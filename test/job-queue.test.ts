import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobQueue, threadCutoff, type JobInput } from "../src/job-queue";

let directory: string;
let database: Database;
let queue: JobQueue;

function open(): void {
  database = new Database(join(directory, "test.db"), { strict: true });
  queue = new JobQueue(database);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ein-jobs-"));
  open();
});
afterEach(() => {
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

function input(key: string, root = "1", user = "owner", ts = "5.000001"): JobInput {
  return { key, ts, text: key, conversation: JSON.stringify(["T", "C", root]),
    channel: "C", threadTs: root, source: "mention", user };
}

test("FIFO heads and their original attempts survive reopening, held work blocks only its own thread", () => {
  queue.enqueue(input("A"));
  queue.enqueue(input("A"));
  queue.enqueue(input("B"));
  queue.enqueue(input("C", "2"));
  const [a, c] = queue.ready();
  expect([a?.key, c?.key]).toEqual(["A", "C"]);
  const running = queue.advance(a!.id, a!.attempt, { stage: "main", sessionId: "m", context: "s" })!;
  expect(queue.advance(running.id, a!.attempt, { stage: "late" })).toBeUndefined();
  database.close();
  open();
  expect(queue.ready()[0]).toEqual(running);

  queue.answer(running.id, a!.attempt, "late answer");
  expect(queue.claimDelivery(Date.now())).toBeNull();
  queue.hold(c!.id, c!.attempt, "missing runner");
  queue.enqueue(input("D", "2"));
  expect(queue.get(c!.id)?.reason).toBe("missing runner");
  queue.answer(running.id, running.attempt, "reply");
  queue.answer(running.id, running.attempt, "replay");
  expect(queue.ready().map(job => job.key)).toEqual(["B"]);
  const delivery = queue.claimDelivery(Date.now())!;
  expect(delivery.text).toBe("reply");
  queue.settleDelivery(delivery.id, { kind: "sent", ts: "9.0" });
  expect(queue.claimDelivery(Date.now())).toBeNull();
});

test("clarification bypasses queued work from a different user and preserves the decision through restart", () => {
  queue.enqueue(input("what?"));
  const first = queue.ready()[0]!;
  const deciding = queue.advance(first.id, first.attempt, {
    stage: "running/main", project: "web", sessionId: "M", context: "partial result",
  })!;
  queue.enqueue(input("outsider", "1", "other", "10.000020"));
  queue.enqueue(input("earlier independent request", "1", "owner", "9.999999"));
  queue.ask(deciding.id, deciding.attempt, "which project?");
  expect(queue.ready()).toEqual([]);
  expect(queue.get(first.id)?.status).toBe("waiting");
  database.close();
  open();
  queue.enqueue(input("web", "1", "owner", "10.000011"));
  expect(queue.ready()).toEqual([]);
  const sent = queue.claimDelivery(Date.now())!;
  queue.settleDelivery(sent.id, { kind: "sent", ts: "10.000010" });
  const resumed = queue.ready()[0]!;
  expect(resumed).toMatchObject({ stage: "main", sessionId: "M", project: "web", attempt: deciding.attempt + 1,
    context: "partial result", clarification: JSON.stringify([{ question: "which project?", answer: "web", ts: "10.000011" }]) });
  queue.ask(resumed.id, resumed.attempt, "confirm?");
  const confirmation = queue.claimDelivery(Date.now())!;
  queue.settleDelivery(confirmation.id, { kind: "sent", ts: "11.4" });
  queue.enqueue(input("again", "1", "owner", "11.400001"));
  const latest = queue.ready()[0]!;
  expect(latest.attempt).toBe(resumed.attempt + 1);
  expect(JSON.parse(latest.clarification!)).toEqual([
    { question: "which project?", answer: "web", ts: "10.000011" },
    { question: "confirm?", answer: "again", ts: "11.400001" },
  ]);
  expect(threadCutoff(latest)).toBe("11.400001");
  expect(threadCutoff({ ...latest, clarification: '[{"question":"old?","answer":"yes"}]' })).toBe(first.ts);
  queue.answer(latest.id, latest.attempt, "finished");
  const head = queue.ready()[0]!;
  expect(head.text).toBe("outsider");
  queue.answer(head.id, head.attempt, "guest response");
  expect(queue.ready()[0]?.text).toBe("earlier independent request");
  expect(queue.history(first.conversation, 100, "owner")).toEqual([{ user: "owner", text: "what?", answer: "finished" }]);
});

test("a failed delivery insertion rolls back finishing and clarification", () => {
  queue.enqueue(input("request"));
  const job = queue.ready()[0]!;
  database.exec("CREATE TRIGGER fail BEFORE INSERT ON slack_deliveries BEGIN SELECT RAISE(ABORT,'disk full'); END");
  expect(() => queue.ask(job.id, job.attempt, "why?")).toThrow("disk full");
  expect(() => queue.answer(job.id, job.attempt, "done")).toThrow("disk full");
  expect(queue.get(job.id)).toEqual(job);
  expect(queue.claimDelivery(Date.now())).toBeNull();
});

test("thread context cursors advance only forward per session and conversation across restarts", () => {
  // Reopening a database created before thread context support adds the cursor table.
  database.exec("DROP TABLE thread_cursors");
  database.close();
  open();
  expect(queue.threadCursor("thread", "assigned")).toBeNull();
  for (const ts of ["9.999999", "10.2", "10.100001", "10.200000"]) {
    queue.withThreadCursor("thread", "assigned", ts, () => {});
  }
  queue.withThreadCursor("other", "assigned", "4.1", () => {});
  queue.withThreadCursor("thread", "main", "5.1", () => {});
  database.close();
  open();
  expect(queue.threadCursor("thread", "assigned")).toBe("10.2");
  expect(queue.threadCursor("thread", "main")).toBe("5.1");
  expect(queue.threadCursor("other", "assigned")).toBe("4.1");
  expect(queue.threadCursor("other", "main")).toBeNull();
});

test("a failed thread cursor write rolls back the job outcome and its Slack delivery", () => {
  queue.enqueue(input("request"));
  const job = queue.ready()[0]!;
  database.exec("CREATE TRIGGER fail BEFORE INSERT ON thread_cursors BEGIN SELECT RAISE(ABORT,'disk full'); END");
  expect(() => queue.withThreadCursor(job.conversation, "worker", job.ts,
    () => queue.answer(job.id, job.attempt, "done"))).toThrow("disk full");
  expect(queue.threadCursor(job.conversation, "worker")).toBeNull();
  expect(queue.get(job.id)).toEqual(job);
  expect(queue.claimDelivery(Date.now())).toBeNull();
});

test("session runner and directory remain pinned, and each conversation preserves its first project", () => {
  const installation = queue.installationId;
  const session = queue.reserveSession({ id: "agent-1", runner: "codex", cwd: "/web" });
  queue.updateSession({ ...session, paneId: "pane-123", nativeId: "native-44" });
  queue.bindProject("thread", "web");
  database.close();
  open();
  expect(queue.installationId).toBe(installation);
  const fresh = new Database(":memory:");
  try {
    expect(new JobQueue(fresh).installationId).not.toBe(installation);
  } finally {
    fresh.close();
  }
  queue.bindProject("thread", "api");
  expect(queue.projectFor("thread")).toBe("web");
  expect(queue.reserveSession({ id: session.id, runner: "claude", cwd: "/api" }))
    .toEqual({ ...session, paneId: "pane-123", nativeId: "native-44" });
  queue.updateSession({ ...session, paneId: "replacement" });
  expect(queue.session(session.id)).toEqual({ ...session, paneId: "replacement", nativeId: "native-44" });
  expect(() => queue.updateSession({ ...session, nativeId: "different" })).toThrow();
  expect(() => queue.updateSession({ ...session, runner: "claude", cwd: "/api" })).toThrow();
  expect(queue.session("absent")).toBeUndefined();
});

test("agent reply and clarification text are redacted before persisting or forwarding them", () => {
  queue.enqueue(input("request"));
  const first = queue.ready()[0]!;
  queue.ask(first.id, first.attempt, "token xoxb-test");
  const ask = queue.claimDelivery(Date.now())!;
  expect(ask.text).toBe("token [REDACTED]");
  expect(queue.get(first.id)?.question).toBe(ask.text);
  queue.settleDelivery(ask.id, { kind: "sent", ts: "5.000002" });
  queue.enqueue(input("yes", "1", "owner", "6.000001"));
  const resumed = queue.ready()[0]!;
  queue.answer(resumed.id, resumed.attempt, "Bearer example");
  expect(queue.claimDelivery(Date.now())!.text).toBe("Bearer [REDACTED]");
  expect(queue.history(first.conversation, 100)[0]?.answer).toBe("Bearer [REDACTED]");
});
