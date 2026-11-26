import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { DeliveryStore, type DeliverySettlement } from "./delivery-store";
import { jobsSchema, type Job, type JobInput } from "./job-schema";
import { redactCredentials } from "./redaction";
import type { SessionRef } from "./runners";

export type { DeliverySettlement, OutgoingDelivery } from "./delivery-store";
export type { Job, JobInput } from "./job-schema";

type SessionRow = Pick<SessionRef, "id" | "runner" | "cwd"> & { paneId: string | null; nativeId: string | null };
type HistoryEntry = { user: string; text: string; answer: string };
type Step = { stage: string; project?: string | null; sessionId?: string | null; context?: string | null };

type ConfirmedQuestion = Job & { questionTs: string };
const confirmedQuestion = `SELECT jobs.*, d.slackTs AS questionTs FROM jobs
  JOIN slack_deliveries d ON d.id = jobs.questionDelivery
  WHERE jobs.status = 'waiting' AND d.status = 'sent'`;

function afterQuestion(ts: string, questionTs: string): boolean {
  const [seconds, micros] = ts.split(".");
  const [sentSeconds, sentMicros] = questionTs.split(".");
  if (!seconds || !micros || !sentSeconds || !sentMicros) return false;
  const delta = BigInt(seconds) - BigInt(sentSeconds);
  return delta > 0n || (delta === 0n && micros.padEnd(6, "0") > sentMicros.padEnd(6, "0"));
}

export class JobQueue extends DeliveryStore {
  readonly installationId: string;

  constructor(private readonly db: Database) {
    super(db);
    db.exec(jobsSchema);
    db.query("INSERT INTO installation (id, uuid) VALUES (1, ?) ON CONFLICT(id) DO NOTHING").run(randomUUID());
    this.installationId = db.query<{ uuid: string }, []>("SELECT uuid FROM installation WHERE id = 1").get()!.uuid;
  }

  /** Called inside the receiver's event transaction, before the Socket Mode ACK. */
  enqueue(input: JobInput): void {
    this.db.transaction(() => {
      const { key, conversation, channel, threadTs, ts, source, user, text } = input;
      const result = this.db.query(`INSERT INTO jobs (key, conversation, channel, threadTs, ts, source, user, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`)
        .run(key, conversation, channel, threadTs, ts, source, user, text);
      if (!result.changes) return;
      const waiting = this.db.query<ConfirmedQuestion, [string, string]>(
        `${confirmedQuestion} AND jobs.conversation = ? AND jobs.user = ?`,
      ).get(conversation, user);
      if (waiting && afterQuestion(ts, waiting.questionTs)) {
        this.consumeClarification(waiting, Number(result.lastInsertRowid), text);
      }
    })();
  }

  /** Only the oldest unfinished turn per conversation is eligible, across restarts too. */
  ready(): Job[] {
    return this.db.query<Job, []>(`
      SELECT j.* FROM (SELECT MIN(id) AS id FROM jobs WHERE status != 'done' GROUP BY conversation) head
      JOIN jobs j ON j.id = head.id WHERE j.status IN ('queued', 'active') ORDER BY j.id
    `).all();
  }

  get(id: number): Job | undefined {
    return this.db.query<Job, [number]>("SELECT * FROM jobs WHERE id = ?").get(id) ?? undefined;
  }

  advance(id: number, attempt: number, step: Step): Job | undefined {
    return this.db.transaction(() => {
      const current = this.editable(id, attempt);
      if (!current) return;
      const context = step.context === undefined ? current.context : step.context;
      this.db.query(`UPDATE jobs SET status = 'active', attempt = attempt + 1,
        stage = ?, project = ?, sessionId = ?, context = ? WHERE id = ?`).run(step.stage,
          step.project === undefined ? current.project : step.project,
          step.sessionId === undefined ? current.sessionId : step.sessionId,
          context === null ? null : redactCredentials(context), id);
      return this.get(id);
    })();
  }

  hold(id: number, attempt: number, reason: string): void {
    this.db.query(`UPDATE jobs SET status = 'held', reason = ?
      WHERE id = ? AND attempt = ? AND status IN ('queued', 'active')`).run(reason, id, attempt);
  }

  answer(id: number, attempt: number, text: string): void {
    this.db.transaction(() => {
      const job = this.editable(id, attempt);
      if (!job) return;
      const reply = redactCredentials(text);
      this.queueDelivery(this.deliveryId(job, "reply"), job.conversation, job.channel, job.threadTs, reply);
      this.db.query("UPDATE jobs SET status = 'done', answer = ? WHERE id = ?").run(reply, id);
    })();
  }

  ask(id: number, attempt: number, question: string): void {
    this.db.transaction(() => {
      const job = this.editable(id, attempt);
      if (!job) return;
      const delivery = this.deliveryId(job, "ask");
      const redacted = redactCredentials(question);
      this.queueDelivery(delivery, job.conversation, job.channel, job.threadTs, redacted);
      this.db.query("UPDATE jobs SET status = 'waiting', question = ?, questionDelivery = ? WHERE id = ?")
        .run(redacted, delivery, id);
    })();
  }

  private editable(id: number, attempt: number): Job | undefined {
    const job = this.get(id);
    return job?.attempt === attempt && (job.status === "queued" || job.status === "active") ? job : undefined;
  }

  private deliveryId(job: Job, purpose: "ask" | "reply"): string {
    return JSON.stringify([this.installationId, job.conversation, job.key, job.attempt, purpose]);
  }

  /** A reply can arrive over the socket before the question's POST receipt (or its reconciliation). */
  override settleDelivery(id: string, result: DeliverySettlement): void {
    this.db.transaction(() => {
      super.settleDelivery(id, result);
      if (result.kind !== "sent") return;
      const waiting = this.db.query<ConfirmedQuestion, [string]>(`${confirmedQuestion} AND d.id = ?`).get(id);
      if (!waiting) return;
      const candidates = this.db.query<Pick<Job, "id" | "ts" | "text">, [string, string, number]>(`
        SELECT id, ts, text FROM jobs WHERE conversation = ? AND user = ? AND id > ? AND status = 'queued'
        ORDER BY id`).all(waiting.conversation, waiting.user, waiting.id);
      const response = candidates.find(row => afterQuestion(row.ts, waiting.questionTs));
      if (response) this.consumeClarification(waiting, response.id, response.text);
    })();
  }

  private consumeClarification(job: ConfirmedQuestion, responseId: number, answer: string): void {
    const history = job.clarification ? JSON.parse(job.clarification) as { question: string; answer: string }[] : [];
    history.push({ question: job.question!, answer });
    const stage = job.stage.replace(/^running\//u, "");
    this.db.query(`UPDATE jobs SET status = 'active', attempt = attempt + 1, stage = ?, clarification = ?,
      question = NULL, questionDelivery = NULL WHERE id = ?`).run(stage, JSON.stringify(history), job.id);
    this.db.query("UPDATE jobs SET status = 'done' WHERE id = ?").run(responseId);
  }

  history(conversation: string, beforeJobId: number, ownerUser?: string): HistoryEntry[] {
    return this.db.query<HistoryEntry, [string, number, string | null, string | null]>(`SELECT user, text, answer FROM jobs
      WHERE conversation = ? AND id < ? AND answer IS NOT NULL AND (? IS NULL OR user = ?)
      ORDER BY id DESC LIMIT 8`).all(conversation, beforeJobId, ownerUser ?? null, ownerUser ?? null).reverse();
  }

  projectFor(conversation: string): string | undefined {
    return this.db.query<{ project: string }, [string]>(
      "SELECT project FROM conversation_projects WHERE conversation = ?",
    ).get(conversation)?.project;
  }

  bindProject(conversation: string, project: string): void {
    this.db.query("INSERT INTO conversation_projects VALUES (?, ?) ON CONFLICT(conversation) DO NOTHING")
      .run(conversation, project);
  }

  session(id: string): SessionRef | undefined {
    const row = this.db.query<SessionRow, [string]>("SELECT * FROM job_sessions WHERE id = ?").get(id);
    if (!row) return;
    const { paneId, nativeId, ...ref } = row;
    return { ...ref, ...(paneId === null ? {} : { paneId }), ...(nativeId === null ? {} : { nativeId }) };
  }

  reserveSession(ref: SessionRef): SessionRef {
    this.db.query(`INSERT INTO job_sessions (id, runner, cwd, paneId, nativeId) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING`).run(ref.id, ref.runner, ref.cwd, ref.paneId ?? null, ref.nativeId ?? null);
    return this.session(ref.id)!;
  }

  updateSession(ref: SessionRef): void {
    const nativeId = ref.nativeId ?? null;
    const result = this.db.query(`UPDATE job_sessions SET paneId = COALESCE(?, paneId), nativeId = COALESCE(nativeId, ?)
      WHERE id = ? AND runner = ? AND cwd = ? AND (nativeId IS NULL OR ? IS NULL OR nativeId = ?)`)
      .run(ref.paneId ?? null, nativeId, ref.id, ref.runner, ref.cwd, nativeId, nativeId);
    if (!result.changes) throw new Error("The session update disagrees with its reserved identity.");
  }
}
