import { createHash } from "node:crypto";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";
import { einCommand } from "./cli-invocation";
import { SetupError } from "./config";
import { ensurePrivateDirectory } from "./private-directory";

const requestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("next"), client: z.string().min(1) }),
  z.strictObject({ kind: z.literal("read"), receipt: z.uuid() }),
  z.strictObject({ kind: z.literal("reply"), receipt: z.string().min(1), text: z.string().min(1) }),
]);
export type SessionRequest = z.infer<typeof requestSchema>;
type Handler = (request: SessionRequest, signal: AbortSignal) => Promise<string>;
const responseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.string() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
const maxFrameBytes = 1024 * 1024;
const unavailable = () => new SetupError(`Slack 세션에 연결할 수 없습니다. 같은 폴더와 EIN_CONFIG에서 ${einCommand} slack connect를 실행하세요.`);

function socketPath(stateFile: string, cwd: string) {
  const directory = ensurePrivateDirectory(join("/tmp", "ein-slack-" + process.getuid?.()));
  const key = createHash("sha256").update(resolve(stateFile)).update("\0").update(realpathSync(cwd)).digest("hex");
  return join(directory, key + ".sock");
}

function encodeFrame(value: SessionRequest | z.infer<typeof responseSchema>) {
  const line = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(line) > maxFrameBytes) throw new SetupError("Slack 세션 메시지가 1 MiB 제한을 넘었습니다.");
  return line;
}

function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolveFrame, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    function cleanup() {
      socket.off("data", data);
      socket.off("error", failed);
      socket.off("close", disconnected);
      socket.off("end", disconnected);
    }
    function failed(error: Error) {
      cleanup();
      reject(error);
    }
    function disconnected() { failed(unavailable()); }
    function data(chunk: Buffer) {
      length += chunk.length;
      if (length > maxFrameBytes) return failed(new SetupError("Slack 세션 메시지가 1 MiB 제한을 넘었습니다."));
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      cleanup();
      if (newline !== chunk.length - 1) return reject(new SetupError("Slack 세션 요청은 한 줄의 JSON이어야 합니다."));
      try {
        resolveFrame(JSON.parse(Buffer.concat(chunks, length).toString("utf8")));
      } catch (error) {
        reject(error instanceof SyntaxError ? new SetupError("Slack 세션 JSON을 읽을 수 없습니다.") : error);
      }
    }
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("close", disconnected);
    socket.once("end", disconnected);
  });
}

async function serve(socket: Socket, handle: Handler, signal: AbortSignal) {
  try {
    const parsed = requestSchema.safeParse(await readFrame(socket));
    if (!parsed.success) throw new SetupError("잘못된 Slack 세션 요청입니다. slack next 또는 slack reply의 인자를 확인하세요.");
    signal.throwIfAborted();
    const value = await handle(parsed.data, signal);
    if (!signal.aborted) socket.end(encodeFrame({ ok: true, value }));
  } catch (error) {
    const message = error instanceof SetupError ? error.message : "Slack 세션 요청 처리에 실패했습니다.";
    if (!signal.aborted) socket.end(encodeFrame({ ok: false, error: message.slice(0, 2048) }));
  }
}

export async function startSessionSocket(stateFile: string, cwd: string, handle: Handler, signal: AbortSignal) {
  signal.throwIfAborted();
  const path = socketPath(stateFile, cwd);
  // The caller owns the state file's exclusive listener lock through close().
  const stale = lstatSync(path, { throwIfNoEntry: false });
  if (stale) {
    if (!stale.isSocket()) throw new SetupError("Slack 세션 소켓 경로에 다른 파일이 있습니다. 해당 경로를 확인하세요.");
    unlinkSync(path);
  }
  const clients = new Map<Socket, AbortController>();
  const handlers = new Set<Promise<void>>();
  const server = createServer(socket => {
    const lifetime = new AbortController();
    clients.set(socket, lifetime);
    const stop = () => lifetime.abort();
    socket.once("end", stop);
    socket.on("error", stop);
    socket.once("close", () => {
      stop();
      clients.delete(socket);
    });
    const task = serve(socket, handle, lifetime.signal);
    handlers.add(task);
    void task.finally(() => handlers.delete(task));
  });

  await new Promise<void>((ready, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      ready();
    });
  });
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    signal.removeEventListener("abort", stop);
    closing = new Promise<void>(done => {
      server.close(() => done());
      for (const [socket, lifetime] of clients) {
        lifetime.abort();
        socket.destroy();
      }
    }).then(async () => { await Promise.all(handlers); });
    return closing;
  }
  const stop = () => { void close(); };
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  return { close };
}

export async function sessionRequest(stateFile: string, cwd: string, request: SessionRequest, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const line = encodeFrame(request);
  const socket = createConnection(socketPath(stateFile, cwd));
  const stop = () => { socket.destroy(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    socket.once("connect", () => { socket.write(line); });
    const result = responseSchema.safeParse(await readFrame(socket));
    if (!result.success) throw new SetupError("Slack 세션 응답 형식을 확인하세요.");
    if (!result.data.ok) throw new SetupError(result.data.error);
    return result.data.value;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof SetupError) throw error;
    throw unavailable();
  } finally {
    signal.removeEventListener("abort", stop);
    socket.destroy();
  }
}
