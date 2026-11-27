import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, rmSync, writeFileSync, type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { SetupError } from "./config";
import { ensurePrivateDirectory } from "./private-directory";

const appId = z.string().regex(/^A[A-Z0-9]+$/);
const userId = z.string().regex(/^[UW][A-Z0-9]+$/);
const owner = z.strictObject({
  team: z.string().regex(/^T[A-Z0-9]+$/), botUser: userId, ownerUser: userId,
  ownerDm: z.string().regex(/^D[A-Z0-9]+$/),
});
const progress = z.strictObject({
  appId: appId.optional(), owner: owner.optional(), appTokenHash: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  reply: z.strictObject({
    id: z.uuid(), createdAt: z.number().int().nonnegative(), cursor: z.string().min(1).optional(),
    sent: z.boolean().optional(), retryAt: z.number().int().nonnegative().optional(),
    readAfter: z.number().int().nonnegative().optional(),
  }).optional(),
});
const installation = owner.extend({ appId });
export type SetupProgress = z.infer<typeof progress>;
type TokenKind = "app" | "bot";

function fsCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function checkPrivateFile(info: Stats): void {
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.() || info.nlink > 1) {
    throw new SetupError("Setup data requires a private regular file owned by the current user.");
  }
}

function checkedToken(kind: TokenKind, value: string): string {
  const token = value.trim();
  if (!token.startsWith(kind === "app" ? "xapp-" : "xoxb-") || /\s/.test(token)) {
    throw new SetupError(`Expected a Slack ${kind} token.`);
  }
  return token;
}

export class SetupStore {
  private readonly path: string;
  private readonly directory: string;

  constructor(configPath: string) {
    this.path = configPath === "~" ? homedir()
      : configPath.startsWith("~/") ? join(homedir(), configPath.slice(2)) : resolve(configPath);
    this.directory = this.path + ".setup";
  }

  configExists(): boolean {
    return lstatSync(this.path, { throwIfNoEntry: false }) !== undefined;
  }

  private prepare(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    ensurePrivateDirectory(this.directory);
  }

  private readPrivate(name: string): string | undefined {
    const dir = lstatSync(this.directory, { throwIfNoEntry: false });
    if (!dir) return undefined;
    if (!dir.isDirectory() || (dir.mode & 0o077) !== 0 || dir.uid !== process.getuid?.()) {
      throw new SetupError("Setup data requires a private directory owned by the current user.");
    }
    let fd: number;
    try {
      fd = openSync(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (fsCode(error, "ENOENT")) return undefined;
      throw new SetupError("Cannot open private setup file.");
    }
    try {
      checkPrivateFile(fstatSync(fd));
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }

  private publish(path: string, contents: string, createOnly = false): void {
    this.prepare();
    const temp = join(this.directory, randomUUID());
    const fd = openSync(temp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, contents);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (createOnly) {
        try {
          linkSync(temp, path);
        } catch (error) {
          if (fsCode(error, "EEXIST")) throw new SetupError("Configuration already exists.");
          throw error;
        }
      } else {
        const current = lstatSync(path, { throwIfNoEntry: false });
        if (current) checkPrivateFile(current);
        renameSync(temp, path);
      }
    } finally {
      rmSync(temp, { force: true });
    }
  }

  read(): SetupProgress {
    const raw = this.readPrivate("progress.json");
    if (raw === undefined) return {};
    try {
      return progress.parse(JSON.parse(raw));
    } catch {
      throw new SetupError("Invalid setup progress.");
    }
  }

  save(value: SetupProgress): void {
    const parsed = progress.safeParse(value);
    if (!parsed.success) throw new SetupError("Invalid setup progress.");
    this.publish(join(this.directory, "progress.json"), JSON.stringify(parsed.data));
  }

  getToken(kind: TokenKind): string | undefined {
    const env = process.env[kind === "app" ? "EIN_APP_TOKEN" : "EIN_BOT_TOKEN"]?.trim();
    const raw = env || this.readPrivate(kind + "-token");
    return raw === undefined ? undefined : checkedToken(kind, raw);
  }

  putToken(kind: TokenKind, value: string): void {
    this.publish(join(this.directory, kind + "-token"), checkedToken(kind, value) + "\n");
  }

  finish(value: z.infer<typeof installation>): string {
    const parsed = installation.safeParse(value);
    if (!parsed.success) throw new SetupError("Invalid Slack installation identifiers.");
    const herdrWorkspace = `Ein-${parsed.data.appId}`;
    this.publish(this.path, JSON.stringify({
      ...parsed.data, herdrWorkspace, watchChannels: [],
      appTokenFile: join(this.directory, "app-token"), botTokenFile: join(this.directory, "bot-token"),
    }, null, 2) + "\n", true);
    rmSync(join(this.directory, "progress.json"), { force: true });
    return herdrWorkspace;
  }

  lock(): () => void {
    this.prepare();
    const path = join(this.directory, "lock.sqlite");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      checkPrivateFile(fstatSync(fd));
    } finally {
      closeSync(fd);
    }
    const db = new Database(path);
    try {
      db.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    } catch (error) {
      db.close();
      if (fsCode(error, "SQLITE_BUSY")) throw new SetupError("Another setup command is running.");
      throw error;
    }
    return () => db.close();
  }
}
