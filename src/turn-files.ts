import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { ensurePrivateDirectory } from "./private-directory";
import { turnResultSchema, type TurnRequest, type TurnResult } from "./turn-contract";

export class TurnError extends Error {
  override readonly name = "TurnError";
}

const positiveId = z.number().int().positive();
const resultEnvelope = z.strictObject({ jobId: positiveId, attempt: positiveId, result: turnResultSchema });
const claimSchema = z.strictObject({
  nonce: z.uuid(), deadline: positiveId, requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  threadThrough: z.string().regex(/^\d+\.\d{1,6}$/).optional(),
});
type Claim = z.infer<typeof claimSchema>;

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Never follow a link, block on a pipe or allocate based on an untrusted file size. */
function readJson(path: string, limit: number): unknown {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw new TurnError("Cannot open a private turn file.");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) {
      throw new TurnError("Invalid turn file type or size.");
    }
    const bytes = Buffer.alloc(stat.size + 1);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size !== stat.size) throw new TurnError("Turn file changed while reading.");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    if (error instanceof TurnError) throw error;
    throw new TurnError("Cannot read a complete turn file.");
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function turnFiles(root: string, request: TurnRequest) {
  if (!positiveId.safeParse(request.jobId).success || !positiveId.safeParse(request.attempt).success) {
    throw new TurnError("Invalid turn identifier.");
  }
  const base = ensurePrivateDirectory(resolve(root));
  const claims = ensurePrivateDirectory(join(base, "claims"));
  const results = ensurePrivateDirectory(join(base, "results"));
  const key = createHash("sha256").update(request.session.id).digest("hex");
  const resultDir = ensurePrivateDirectory(join(results, key));
  const initial = lstatSync(resultDir, { bigint: true });
  const verifyDirectory = () => {
    const current = lstatSync(resultDir, { bigint: true });
    if (!current.isDirectory() || current.dev !== initial.dev || current.ino !== initial.ino ||
      current.uid !== initial.uid || (current.mode & 0o077n) !== 0n) {
      throw new TurnError("The session result directory changed.");
    }
  };
  const path = join(claims, `${key}-${request.jobId}-${request.attempt}.json`);
  function hashInput(input: string): string {
    return createHash("sha256").update(JSON.stringify([
      request.session.id, request.jobId, request.attempt, request.role, input,
      request.canAssign, request.canEscalate, initial.dev.toString(), initial.ino.toString(),
    ])).digest("hex");
  }
  const requestHash = hashInput(request.input);
  function existing(): Claim | undefined {
    const json = readJson(path, 1024);
    if (json === undefined) return;
    const parsed = claimSchema.safeParse(json);
    if (!parsed.success) throw new TurnError("Invalid turn reservation.");
    const claim = parsed.data;
    if (claim.requestHash !== requestHash &&
        (claim.threadThrough !== undefined || !request.legacyInput || claim.requestHash !== hashInput(request.legacyInput()))) {
      throw new TurnError("Invalid turn reservation.");
    }
    return claim;
  }
  function reserve(timeoutMs: number, threadThrough?: string) {
    const claim: Claim = { nonce: randomUUID(), deadline: Date.now() + timeoutMs, requestHash, threadThrough };
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const previous = existing();
      if (!previous) throw new TurnError("Turn reservation disappeared.");
      return { claimed: false, claim: previous };
    }
    try {
      writeFileSync(fd, JSON.stringify(claim));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    for (const directory of [claims, results, base, dirname(base)]) syncDirectory(directory);
    return { claimed: true, claim };
  }
  return { resultDir, existing, reserve, verifyDirectory };
}

export function readTurnResult(path: string, request: TurnRequest): TurnResult | undefined {
  const raw = readJson(path, 256 * 1024);
  if (raw === undefined) return;
  const parsed = resultEnvelope.safeParse(raw);
  if (!parsed.success || parsed.data.jobId !== request.jobId || parsed.data.attempt !== request.attempt) {
    throw new TurnError("Unexpected turn result or attempt.");
  }
  const { result } = parsed.data;
  if (result.kind === "assign" && (!request.canAssign || request.role === "project" ||
    !request.projects.includes(result.project))) throw new TurnError("Turn returned an unavailable project.");
  if (result.kind === "escalate" && (!request.canEscalate || request.role === "main")) {
    throw new TurnError("Turn returned an unavailable escalation.");
  }
  return result;
}
