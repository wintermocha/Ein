import type { Database } from "bun:sqlite";

export type OutgoingDelivery = {
  readonly id: string;
  readonly channel: string;
  readonly threadTs: string | null;
  readonly text: string;
  readonly mode: "send" | "reconcile";
  readonly createdAt: number;
  readonly cursor?: string;
};

export type DeliverySettlement =
  | { readonly kind: "sent"; readonly ts: string }
  | { readonly kind: "retry"; readonly at: number }
  | { readonly kind: "uncertain"; readonly at: number; readonly cursor?: string; readonly readLimited?: true }
  | { readonly kind: "held"; readonly reason: string };

export class DeliveryStore {
  readonly #db: Database;

  /** One instance per exclusive receiver connection. Interrupted POSTs may already be visible on Slack. */
  constructor(db: Database) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS slack_deliveries (
        seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, conversation TEXT NOT NULL,
        channel TEXT NOT NULL, threadTs TEXT, text TEXT, createdAt INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK(status IN ('queued', 'sending', 'uncertain', 'checking', 'sent', 'held')),
        dueAt INTEGER NOT NULL DEFAULT 0, slackTs TEXT, reason TEXT, cursor TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_destination
        ON slack_deliveries(channel, threadTs, seq) WHERE status != 'sent';
      CREATE INDEX IF NOT EXISTS delivery_ready
        ON slack_deliveries(seq) WHERE status IN ('queued', 'uncertain');
      CREATE TABLE IF NOT EXISTS slack_delivery_limits (
        method TEXT PRIMARY KEY, untilMs INTEGER NOT NULL
      );
      UPDATE slack_deliveries SET status = 'uncertain' WHERE status IN ('sending', 'checking');
    `);
  }

  queueDelivery(id: string, conversation: string, channel: string, threadTs: string | null, text: string): void {
    this.#db.query(`INSERT INTO slack_deliveries(id, conversation, channel, threadTs, text, createdAt)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`).run(id, conversation, channel, threadTs, text, Date.now());
  }

  claimDelivery(nowMs: number): OutgoingDelivery | null {
    return this.#db.transaction(() => {
      const row = this.#db.query<Omit<OutgoingDelivery, "cursor"> & { cursor: string | null }, [number, number]>(`
        SELECT id, channel, threadTs, text, createdAt, cursor,
          CASE d.status WHEN 'queued' THEN 'send' ELSE 'reconcile' END AS mode
        FROM slack_deliveries AS d
        WHERE d.status IN ('queued', 'uncertain') AND d.dueAt <= ?
          AND NOT EXISTS (
            SELECT 1 FROM slack_delivery_limits WHERE untilMs > ? AND method =
              CASE WHEN d.status = 'queued' THEN 'post'
                   WHEN d.threadTs IS NULL THEN 'history' ELSE 'replies' END
          )
          AND NOT EXISTS (
            SELECT 1 FROM slack_deliveries AS earlier
            WHERE earlier.status != 'sent' AND earlier.channel = d.channel
              AND earlier.threadTs IS d.threadTs AND earlier.seq < d.seq
          )
        ORDER BY d.seq LIMIT 1
      `).get(nowMs, nowMs);
      if (!row) return null;
      this.#db.query("UPDATE slack_deliveries SET status = ? WHERE id = ?")
        .run(row.mode === "send" ? "sending" : "checking", row.id);
      const {cursor, ...next} = row;
      return cursor === null ? next : {...next, cursor};
    }).immediate();
  }

  settleDelivery(id: string, result: DeliverySettlement): void {
    switch (result.kind) {
      case "sent":
        this.#db.query(`UPDATE slack_deliveries SET status = 'sent', slackTs = ?, text = NULL
          WHERE id = ? AND status IN ('sending', 'checking')`).run(result.ts, id);
        return;
      case "retry":
        this.#db.transaction(() => {
          // Only a rejected POST (429) may become sendable again.
          const updated = this.#db.query(`UPDATE slack_deliveries SET status = 'queued', dueAt = ?
            WHERE id = ? AND status = 'sending'`).run(result.at, id);
          if (updated.changes > 0) {
            this.saveLimit("post", result.at);
          }
        }).immediate();
        return;
      case "uncertain":
        this.#db.transaction(() => {
          const updated = this.#db.query<{ threadTs: string | null }, [number, string | null, string]>(`
            UPDATE slack_deliveries SET status = 'uncertain', dueAt = ?, cursor = ?
            WHERE id = ? AND status IN ('sending', 'checking') RETURNING threadTs
          `).get(result.at, result.cursor ?? null, id);
          if (result.readLimited && updated) {
            this.saveLimit(updated.threadTs === null ? "history" : "replies", result.at);
          }
        }).immediate();
        return;
      case "held":
        this.#db.query(`UPDATE slack_deliveries SET status = 'held', reason = ?
          WHERE id = ? AND status IN ('sending', 'checking')`).run(result.reason, id);
        return;
    }
  }

  private saveLimit(method: "post" | "history" | "replies", until: number): void {
    this.#db.query(`INSERT INTO slack_delivery_limits(method, untilMs) VALUES (?, ?)
      ON CONFLICT(method) DO UPDATE SET untilMs = MAX(untilMs, excluded.untilMs)`).run(method, until);
  }
}
