import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const bridge = join(import.meta.dir, "../src/herdr-omo.ts");
const nativeId = "78462093-e88f-4bd5-8585-0ba36109e4f8";
const fakeRunner = `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const session = process.argv.at(-1);
if (process.argv.slice(2, -1).join(" ") !== "--mode rpc --session") process.exit(2);
writeFileSync(session + ".pid", String(process.pid));
for await (const line of createInterface({ input: process.stdin })) {
  const { id, type, message } = JSON.parse(line);
  const fixture = JSON.parse(readFileSync(session + ".fixture", "utf8"));
  if (type === "get_state") {
    console.log(JSON.stringify({ type: "response", id, success: true, data: {
      sessionFile: session, sessionId: "${nativeId}", isStreaming: false, isCompacting: false, ...fixture.state,
    } }));
  } else if (type === "prompt") {
    if (fixture.onPrompt === "exit") process.exit(0);
    if (fixture.onPrompt !== "refuse") appendFileSync(session + ".inbox", JSON.stringify(message) + "\\n");
    for (const event of fixture.events) console.log(JSON.stringify(event));
    console.log(JSON.stringify({ type: "response", id, success: fixture.onPrompt !== "refuse" }));
  }
}
`;

let folder: string;
let session: string;
let socket: string;
let child: ReturnType<typeof Bun.spawn> | undefined;

function configure(state: Record<string, unknown> = {}, onPrompt = "accept", events: readonly object[] = []) {
  writeFileSync(session + ".fixture", JSON.stringify({ state, onPrompt, events }));
}

function post(command: object) {
  return fetch("http://localhost/rpc", { unix: socket, method: "POST", body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000) });
}

const prompt = (text: string, id = nativeId) => post({ command: "prompt", text, nativeId: id });

beforeEach(async () => {
  folder = mkdtempSync("/tmp/ein-bridge-test-");
  socket = join(folder, "rpc.sock");
  session = join(folder, "session file.jsonl");
  const runner = join(folder, "omo");
  writeFileSync(runner, fakeRunner, { mode: 0o700 });
  configure();
  child = Bun.spawn([process.execPath, bridge, runner, session, socket], {
    stdin: "ignore", stdout: Bun.file(join(folder, "pane.log")), stderr: "inherit",
  });
  const deadline = AbortSignal.timeout(2400);
  while (!existsSync(socket) || !existsSync(session + ".pid")) {
    if (child.exitCode !== null) throw new Error("Test bridge exited before opening its socket.");
    await delay(10, undefined, { signal: deadline });
  }
});

afterEach(async () => {
  if (child && child.exitCode === null) child.kill();
  await child?.exited;
  child = undefined;
  rmSync(folder, { recursive: true, force: true });
});

test("returns the native UUID and delivers the literal prompt only with an affirmative OMO receipt", async () => {
  const state = await post({ command: "state" });
  expect(await state.json()).toEqual({ nativeId, ready: true, blocked: false });
  const text = "테스트\n'quoted' $(literal) 🔎";

  expect(await (await prompt(text)).json()).toEqual({ accepted: true });
  expect(readFileSync(session + ".inbox", "utf8").trim()).toBe(JSON.stringify(text));
});

test("refused native RPC does not create a successful prompt receipt", async () => {
  configure({}, "refuse");
  expect((await prompt("unaccepted")).ok).toBe(false);
  expect(existsSync(session + ".inbox")).toBe(false);
});

test("shows assistant progress and tool activity in the pane while the turn is still running", async () => {
  const secret = "private-fixture-value";
  const update = (type: string, delta: string) => ({ type: "message_update", assistantMessageEvent: { type, delta } });
  configure({}, "accept", [
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: secret } },
    update("thinking_delta", secret),
    update("toolcall_delta", secret),
    update("text_delta", "조사 중 \u001b[32m확"),
    update("text_delta", "인\u001b[0m xoxb-"),
    update("text_delta", "123-test\n"),
    { type: "tool_execution_start", toolName: "read", args: { path: secret } },
    { type: "tool_execution_end", toolName: "read", isError: true, result: { content: secret } },
  ]);
  expect((await prompt(secret)).ok).toBe(true);

  const pane = readFileSync(join(folder, "pane.log"), "utf8");
  expect(pane).toContain("조사 중 확인 [REDACTED]");
  expect(pane).toContain("read 실행");
  expect(pane).toContain("read 실패");
  expect(pane).not.toMatch(/private-fixture-value|xoxb-|\x1b/);
});

test("mismatched session UUID and replaced session file reject input", async () => {
  expect((await prompt("wrong UUID", crypto.randomUUID())).ok).toBe(false);
  configure({ sessionFile: join(folder, "other.jsonl") });
  expect((await post({ command: "state" })).ok).toBe(false);
  expect((await prompt("wrong file")).ok).toBe(false);
  expect(existsSync(session + ".inbox")).toBe(false);
});

test.each([
  { state: { pendingMessageCount: 1 }, blocked: false },
  { state: { isStreaming: true }, blocked: false },
  { state: { pendingDialogs: [{}] }, blocked: true },
  { state: { paused: true }, blocked: true },
])("guards prompt admission for native state %j", async ({ state, blocked }) => {
  configure(state);
  expect(await (await post({ command: "state" })).json()).toEqual({ nativeId, ready: false, blocked });
  expect((await prompt("while unavailable")).ok).toBe(false);
  expect(existsSync(session + ".inbox")).toBe(false);
});

test("native exit during admission releases the outstanding request and terminates the bridge", async () => {
  configure({}, "exit");
  // Disconnect and explicit HTTP failure both mean that no positive admission receipt was received.
  let acknowledged: boolean;
  try { acknowledged = (await prompt("exit before receipt")).ok; }
  catch (error) {
    if (!(error instanceof Error) || error.name === "TimeoutError") throw error;
    acknowledged = false;
  }
  expect(acknowledged).toBe(false);
  expect(await child?.exited).toBe(0);
});
