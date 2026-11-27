import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { SetupError } from "../src/config";
import { sessionRequest, startSessionSocket } from "../src/slack-session-ipc";

let folder: string;
let state: string;
let server: Awaited<ReturnType<typeof startSessionSocket>> | undefined;
beforeEach(() => {
  folder = mkdtempSync("/tmp/ein-slack-ipc-test-");
  state = join(folder, "inbound.sqlite");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(folder, { recursive: true, force: true });
});

test("a workspace alias reaches the same socket and preserves multiline Unicode in both directions", async () => {
  const alias = join(folder, "alias");
  symlinkSync(folder, alias);
  const signal = AbortSignal.timeout(2500);
  server = await startSessionSocket(state, folder, async request => {
    if (request.kind !== "reply") throw new SetupError("expected reply");
    return request.receipt + "\n" + request.text;
  }, signal);
  const text = "🔎\n\"검토\"\\\n".repeat(6000);
  expect(await sessionRequest(state, alias, { kind: "reply", receipt: "r1", text }, signal)).toBe("r1\n" + text);
});

test("an unknown workspace or state file cannot send a request to the running session", async () => {
  const signal = AbortSignal.timeout(2500);
  server = await startSessionSocket(state, folder, async () => "received", signal);
  const request = { kind: "next", client: "lead" } as const;
  for (const [otherState, otherCwd] of [[state, "/tmp"], [state + ".other", folder]] as const) {
    await expect(sessionRequest(otherState, otherCwd, request, signal)).rejects.toThrow("slack connect");
  }
});

test("the listener rejects malformed requests and converts handler errors into CLI errors", async () => {
  const signal = AbortSignal.timeout(2500);
  server = await startSessionSocket(state, folder, async () => { throw new SetupError("unknown receipt"); }, signal);
  await expect(sessionRequest(state, folder, { kind: "next", client: "" }, signal)).rejects.toThrow("잘못된 Slack 세션 요청");
  await expect(sessionRequest(state, folder, { kind: "reply", text: "reply", receipt: "expired" }, signal)).rejects.toThrow("unknown receipt");
});

test("oversized requests and responses report a bounded-frame error to the CLI", async () => {
  const signal = AbortSignal.timeout(2500);
  const large = "한".repeat(350_000);
  server = await startSessionSocket(state, folder, async () => large, signal);
  await expect(sessionRequest(state, folder, { kind: "reply", receipt: "r1", text: large }, signal)).rejects.toThrow("1 MiB");
  await expect(sessionRequest(state, folder, { kind: "next", client: "lead" }, signal)).rejects.toThrow("1 MiB");
});

test.each(["client", "listener"])("aborting the %s cancels a waiting next request", async side => {
  const client = new AbortController();
  const listener = new AbortController();
  const waiting = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  server = await startSessionSocket(state, folder, async (_, signal) => {
    waiting.resolve();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    cancelled.resolve();
    return "cancelled";
  }, listener.signal);
  const request = sessionRequest(state, folder, { kind: "next", client: "lead" }, client.signal);
  const rejected = request.then(() => false, () => true);
  await waiting.promise;
  (side === "client" ? client : listener).abort();
  expect(await rejected).toBe(true);
  await cancelled.promise;
});
