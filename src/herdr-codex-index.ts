import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const indexRow = z.object({ thread_name: z.string(), id: z.string().uuid() });
const maxIndexBytes = 4 * 1024 * 1024;

// Read the complete naming index or abstain: searching a suffix could miss an older collision.
function indexedId(path: string, label: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || !file.size || file.size > maxIndexBytes) return undefined;
    const bytes = Buffer.alloc(file.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || fstatSync(fd).size !== bytes.length) return undefined;

    let id: string | undefined;
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = indexRow.parse(JSON.parse(line));
      if (row.thread_name !== label) continue;
      if (id && id !== row.id) return undefined;
      id = row.id;
    }
    return id;
  } finally {
    closeSync(fd);
  }
}

/** Codex 0.140 may persist a renamed session before herdr reports its native UUID. */
export function findCodexSession(profile: string, label: string, cwd: string): string | undefined {
  try {
    const id = indexedId(join(profile, "session_index.jsonl"), label);
    if (!id) return undefined;
    // A migration can leave a readable state_5 beside the active, newer database.
    if (readdirSync(profile).some(name => Number(/^state_(\d+)\.sqlite$/.exec(name)?.[1]) > 5)) return undefined;
    const path = join(profile, "state_5.sqlite");
    if (!lstatSync(path).isFile()) return undefined;
    using db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA busy_timeout=0");
    const matches = db.query<{ id: unknown; cwd: unknown }, [string]>(
      "SELECT id, cwd FROM threads WHERE title = ? COLLATE BINARY LIMIT 2"
    ).all(label);
    const row = matches[0];
    if (matches.length !== 1 || row?.id !== id || typeof row.cwd !== "string" || !isAbsolute(row.cwd)) return undefined;
    return realpathSync(row.cwd) === realpathSync(cwd) ? id : undefined;
  } catch {
    // Local Codex profile formats are version-specific. No metadata is copied into diagnostics.
    return undefined;
  }
}
