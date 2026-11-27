import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { SetupError } from "./config";
import type { DeliveryStore } from "./delivery-store";
import { redactCredentials } from "./redaction";

type Incoming = {
  readonly key: string;
  readonly channel: string;
  readonly threadTs: string | null;
  readonly text: string;
};

export type AttachedMessage = Incoming & {
  readonly receipt: string;
};

export class AttachedInbox {
  constructor(private readonly db: Database, private readonly deliveries: DeliveryStore,
    private readonly session: string) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS attached_inbox (
        id INTEGER PRIMARY KEY, session TEXT NOT NULL, key TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL, threadTs TEXT, text TEXT, receipt TEXT NOT NULL UNIQUE,
        offered INTEGER NOT NULL DEFAULT 0, answerHash TEXT
      );
      CREATE INDEX IF NOT EXISTS attached_pending ON attached_inbox(session, id) WHERE answerHash IS NULL;
      CREATE INDEX IF NOT EXISTS attached_threads ON attached_inbox(session, channel, threadTs);
    `);
  }

  enqueue(input: Incoming): void {
    this.db.query(`INSERT INTO attached_inbox(session, key, channel, threadTs, text, receipt)
      VALUES (?, ?, ?, ?, ?, ?)`).run(this.session, input.key, input.channel, input.threadTs, input.text, randomUUID());
  }

  ownsThread(channel: string, threadTs: string): boolean {
    return Boolean(this.db.query("SELECT 1 FROM attached_inbox WHERE session = ? AND channel = ? AND threadTs = ? LIMIT 1")
      .get(this.session, channel, threadTs));
  }

  read(receipt: string): AttachedMessage {
    const message = this.db.query<AttachedMessage, [string, string]>(`SELECT key, channel, threadTs, text, receipt
      FROM attached_inbox WHERE session = ? AND receipt = ? AND offered = 1 AND answerHash IS NULL`).get(this.session, receipt);
    if (!message) throw new SetupError("이 세션에 해당하는 미응답 Slack 요청이 없습니다.");
    return message;
  }

  /** One open turn per attached agent. Pull clients can recover a receipt lost in transit. */
  claim(recover: boolean): AttachedMessage | undefined {
    return this.db.transaction(() => {
      const message = this.db.query<AttachedMessage & { offered: number }, [string]>(`SELECT key, channel, threadTs, text, receipt, offered
        FROM attached_inbox WHERE session = ? AND answerHash IS NULL ORDER BY id LIMIT 1`).get(this.session);
      if (!message) return;
      if (message.offered) return recover ? message : undefined;
      this.db.query("UPDATE attached_inbox SET offered = 1 WHERE receipt = ?").run(message.receipt);
      return message;
    })();
  }

  reply(receipt: string, value: string): void {
    const answer = redactCredentials(value.trim());
    if (!answer || answer.length > 40_000) throw new SetupError("답변은 1~40,000자로 입력하세요.");
    const digest = createHash("sha256").update(answer).digest("hex");
    this.db.transaction(() => {
      const message = this.db.query<Pick<AttachedMessage, "channel" | "threadTs"> & { answerHash: string | null }, [string, string]>(
        "SELECT channel, threadTs, answerHash FROM attached_inbox WHERE session = ? AND receipt = ? AND offered = 1",
      ).get(this.session, receipt);
      if (!message) throw new SetupError("이 세션에 해당하는 Slack 요청이 없습니다.");
      if (message.answerHash === digest) return;
      if (message.answerHash !== null) throw new SetupError("이 요청의 답변은 이미 접수됐습니다.");
      this.deliveries.queueDelivery("attached:" + receipt, this.session, message.channel, message.threadTs, answer);
      this.db.query("UPDATE attached_inbox SET answerHash = ?, text = NULL WHERE receipt = ?").run(digest, receipt);
    })();
  }
}
