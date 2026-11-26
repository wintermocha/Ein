import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { JobQueue } from "./job-queue";
import { route, type Policy, type RoutedEvent } from "./routing";

type Thread = { readonly channel: string; readonly threadTs: string };
type Identity = { readonly team: string; readonly botUser: string };

export class StateError extends Error {
  override readonly name = "StateError";
}

function prepareFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    const file = lstatSync(path);
    if (!file.isFile() || (file.mode & 0o077) !== 0) {
      throw new StateError("State must be a private regular file (chmod 600).");
    }
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS receiver (
    id INTEGER PRIMARY KEY CHECK (id = 1), team TEXT NOT NULL, botUser TEXT NOT NULL, cursor TEXT
  );
  CREATE TABLE IF NOT EXISTS delivery_limit (
    id INTEGER PRIMARY KEY CHECK (id = 1), endTime INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS threads (
    channel TEXT NOT NULL, threadTs TEXT NOT NULL, owned INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel, threadTs)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS bot_posts (
    channel TEXT NOT NULL, ts TEXT NOT NULL, threadTs TEXT NOT NULL, PRIMARY KEY (channel, ts)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, key TEXT NOT NULL UNIQUE, line TEXT);
  CREATE INDEX IF NOT EXISTS pending ON outbox(id) WHERE line IS NOT NULL;
`;

export class ReceiverState {
  readonly #db: Database;
  readonly jobs: JobQueue;
  #closed = false;

  constructor(path: string, private readonly team: string, botUser: string,
    private readonly mode: "listen" | "orchestrate" = "listen") {
    if (path !== ":memory:") prepareFile(path);
    this.#db = new Database(path, { strict: true });
    try {
      // Set EXCLUSIVE before opening the WAL. SQLite retains the OS lock until close or exit.
      this.#db.exec(`
        PRAGMA busy_timeout = 200;
        PRAGMA locking_mode = EXCLUSIVE;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA secure_delete = ON;
      `);
      this.#db.transaction(() => {
        this.#db.exec(schema);
        this.#db.query("INSERT OR IGNORE INTO receiver (id, team, botUser) VALUES (1, ?, ?)")
          .run(team, botUser);
        const identity = this.#db.query<Identity, []>("SELECT team, botUser FROM receiver WHERE id = 1").get();
        if (identity?.team !== team || identity.botUser !== botUser) {
          throw new StateError("This state file belongs to another Slack workspace or bot.");
        }
      }).immediate();
      this.jobs = new JobQueue(this.#db);
      // A confirmed Slack post is authoritative even if the corresponding Socket Mode echo is lost.
      this.#db.exec(`CREATE TRIGGER IF NOT EXISTS track_confirmed_delivery AFTER UPDATE OF status ON slack_deliveries
        WHEN NEW.status = 'sent' AND OLD.status != 'sent' BEGIN
          INSERT INTO threads (channel, threadTs, owned) VALUES (NEW.channel, COALESCE(NEW.threadTs, NEW.slackTs), 1)
            ON CONFLICT(channel, threadTs) DO UPDATE SET owned = 1;
          INSERT OR IGNORE INTO bot_posts (channel, ts, threadTs)
            VALUES (NEW.channel, NEW.slackTs, COALESCE(NEW.threadTs, NEW.slackTs));
        END`);
    } catch (error) {
      this.#db.close();
      if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") {
        throw new StateError("Another Ein receiver has this state file open.");
      }
      throw error;
    }
  }

  consume(event: unknown, policy: Policy): RoutedEvent["track"] {
    const ownsThread = (channel: string, threadTs: string) => {
      if (this.#db.query("SELECT 1 FROM threads WHERE channel = ? AND threadTs = ? AND owned = 1")
        .get(channel, threadTs)) return true;
      // Orchestration accepts follow-ups as soon as a first mention queues, even before our reply.
      return this.mode === "orchestrate" && Boolean(this.#db.query(`SELECT 1 FROM jobs
        WHERE channel = ? AND threadTs = ? AND source IN ('mention', 'thread-mention') LIMIT 1`)
        .get(channel, threadTs));
    };
    const { track, inbound } = route(event, policy, {
      ownsThread,
      parentOf: (channel, ts) => this.#db.query<{ readonly threadTs: string }, [string, string]>(
        "SELECT threadTs FROM bot_posts WHERE channel = ? AND ts = ?",
      ).get(channel, ts)?.threadTs,
      random: Math.random,
    });
    if (!track && !inbound) return;
    return this.#db.transaction(() => {
      if (track) {
        this.#db.query(`INSERT INTO threads (channel, threadTs, owned) VALUES (?, ?, 1)
          ON CONFLICT(channel, threadTs) DO UPDATE SET owned = 1`).run(track.channel, track.threadTs);
        this.#db.query("INSERT OR IGNORE INTO bot_posts (channel, ts, threadTs) VALUES (?, ?, ?)")
          .run(track.channel, track.ts, track.threadTs);
      }
      if (inbound) {
        if (inbound.recoverThread !== false) {
          this.#db.query("INSERT OR IGNORE INTO threads (channel, threadTs) VALUES (?, ?)")
            .run(inbound.channel, inbound.threadTs);
        }
        const { key, channel, source, user, text, ts } = inbound;
        const marker = this.#db.query("INSERT OR IGNORE INTO outbox (key, line) VALUES (?, ?)")
          .run(key, this.mode === "listen" ? inbound.line : null);
        if (marker.changes && this.mode === "orchestrate" && source !== "reaction" && inbound.allowReply) {
          const threadTs = source === "dm" ? null : inbound.threadTs;
          const conversation = JSON.stringify([this.team, channel, threadTs]);
          this.jobs.enqueue({ key, conversation, channel, threadTs, ts, source, user, text });
        }
        // Recovery can discover this mention after the live socket has already skipped a follow-up.
        if (this.mode === "orchestrate" && (source === "mention" || source === "thread-mention")
          && ownsThread(channel, inbound.threadTs)) {
          return { channel, threadTs: inbound.threadTs, ts };
        }
      }
      return track;
    })();
  }

  /** A crash after write succeeds and before SQLite commits can repeat the last line. */
  drain(write: (line: string) => void): void {
    const next = this.#db.query<{ readonly id: number; readonly line: string }, []>(
      "SELECT id, line FROM outbox WHERE line IS NOT NULL ORDER BY id LIMIT 1",
    );
    const delivered = this.#db.query("UPDATE outbox SET line = NULL WHERE id = ?");
    for (let row = next.get(); row; row = next.get()) {
      write(row.line);
      delivered.run(row.id);
    }
  }

  channels(): string[] {
    return this.#db.query<{ readonly channel: string }, []>(
      "SELECT DISTINCT channel FROM threads WHERE channel GLOB 'D*' ORDER BY channel",
    ).all().map(row => row.channel);
  }

  threads(): Thread[] {
    return this.#db.query<Thread, []>("SELECT channel, threadTs FROM threads ORDER BY channel, threadTs").all();
  }

  recoveryCursor(): string | undefined {
    return this.#db.query<{ readonly cursor: string | null }, []>(
      "SELECT cursor FROM receiver WHERE id = 1",
    ).get()?.cursor ?? undefined;
  }

  setRecoveryCursor(ts: string): void {
    this.#db.query("UPDATE receiver SET cursor = ? WHERE id = 1").run(ts);
  }

  readLimitEnd(): number | undefined {
    return this.#db.query<{ readonly endTime: number }, []>(
      "SELECT endTime FROM delivery_limit WHERE id = 1",
    ).get()?.endTime;
  }

  saveRateLimit(oldest: string, end: number): void {
    this.#db.transaction(() => {
      this.setRecoveryCursor(oldest);
      this.#db.query("INSERT OR REPLACE INTO delivery_limit (id, endTime) VALUES (1, ?)").run(end);
    })();
  }

  clearLimit(): void {
    this.#db.query("DELETE FROM delivery_limit WHERE id = 1").run();
  }

  close(): void {
    if (this.#closed) return;
    this.#db.close();
    this.#closed = true;
  }
}
