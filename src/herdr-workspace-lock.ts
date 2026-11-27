import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ensurePrivateDirectory } from "./private-directory";

// Setup and orchestration can resolve the same Herdr namespace from different processes.
export async function withWorkspaceLock<T>(namespace: string, signal: AbortSignal, resolve: () => Promise<T>): Promise<T> {
  const directory = ensurePrivateDirectory(join("/tmp", "ein-workspaces-" + process.getuid?.()));
  const key = createHash("sha256").update(namespace).digest("hex");
  const db = new Database(join(directory, key + ".sqlite"), { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(42_000)]);
    for (;;) {
      deadline.throwIfAborted();
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")) throw error;
        await delay(50, undefined, { signal: deadline });
      }
    }
    return await resolve();
  } finally {
    db.close();
  }
}
