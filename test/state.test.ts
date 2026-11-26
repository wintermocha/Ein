import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiverState } from "../src/state";
import type { Policy } from "../src/routing";

const policy: Policy = {
  botUser: "UBOT", ownerUser: "UOWNER", watchChannels: ["CCHAN"],
  blockedUsers: [], otherUserReplyRate: {},
};
const dm = {
  type: "message", channel_type: "im", channel: "DDM", user: "UOWNER",
  ts: "1732123456.123456", text: "report",
};
let folder: string;
let path: string;
let opened: ReceiverState[];

function open(mode: "listen" | "orchestrate" = "listen"): ReceiverState {
  const state = new ReceiverState(path, "TTEAM", policy.botUser, mode);
  opened.push(state);
  return state;
}
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ein-state-"));
  path = join(folder, "private", "state.db");
  opened = [];
});
afterEach(() => {
  for (const state of opened) state.close();
  rmSync(folder, {recursive: true, force: true});
});

test("retains one pending message through restart and suppresses delivered replays", () => {
  const first = open();
  first.consume(dm, policy);
  first.consume(dm, policy);
  first.close();

  const lines: string[] = [];
  const second = open();
  second.drain(line => lines.push(line));
  second.close();
  const third = open();
  third.consume(dm, policy);
  third.drain(line => lines.push(line));

  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("report");
  expect(third.channels()).toEqual(["DDM"]);
  expect(third.threads()).toEqual([{channel: "DDM", threadTs: dm.ts}]);
});

test("orchestration intake leaves stdout empty, including after switching back to listen", () => {
  const orchestrator = open("orchestrate");
  orchestrator.consume(dm, policy);
  orchestrator.close();

  const receiver = open();
  receiver.consume(dm, policy);
  const lines: string[] = [];
  receiver.drain(line => lines.push(line));
  expect(lines).toEqual([]);
});

test("a previously delivered listen event cannot start work after a mode change", () => {
  const receiver = open();
  receiver.consume(dm, policy);
  receiver.drain(() => {});
  receiver.close();

  const orchestrator = open("orchestrate");
  orchestrator.consume(dm, policy);
  expect(orchestrator.jobs.ready()).toEqual([]);
});

test("DMs, DM threads and channel threads keep distinct conversation keys across restart", () => {
  const state = open("orchestrate");
  const root = "1732123000.000001";
  const mention = { ...dm, type: "app_mention", channel: "CCHAN", text: "<@UBOT> status" };
  state.consume({ ...dm, text: "Bearer fixture-secret\nreport" }, policy);
  state.consume({ ...dm, ts: "1732123457.123456", thread_ts: root }, policy);
  state.consume(mention, policy);
  state.close();

  const reopened = open("orchestrate");
  reopened.consume({ ...mention, type: "message" }, policy);
  const jobs = reopened.jobs.ready().map(({ conversation, threadTs, source, text }) =>
    ({ conversation, threadTs, source, text }));
  expect(jobs).toEqual([
    { conversation: JSON.stringify(["TTEAM", "DDM", null]), threadTs: null, source: "dm",
      text: "Bearer [REDACTED]\nreport" },
    { conversation: JSON.stringify(["TTEAM", "DDM", root]), threadTs: root, source: "dm-thread", text: "report" },
    { conversation: JSON.stringify(["TTEAM", "CCHAN", dm.ts]), threadTs: dm.ts, source: "mention",
      text: mention.text },
  ]);
});

test("a failed queue insertion rolls back both the thread and the delivery marker", () => {
  const state = open("orchestrate");
  const enqueue = spyOn(state.jobs, "enqueue").mockImplementationOnce(() => { throw new Error("disk full"); });
  try {
    expect(() => state.consume(dm, policy)).toThrow("disk full");
    expect(state.threads()).toEqual([]);
  } finally {
    enqueue.mockRestore();
  }
  state.consume(dm, policy);
  expect(state.jobs.ready()).toHaveLength(1);
});

test("a queued channel mention enrolls follow-ups before the bot has posted", () => {
  const state = open("orchestrate");
  state.consume({ ...dm, type: "app_mention", channel: "CCHAN", text: "<@UBOT> status" }, policy);
  state.consume({ ...dm, channel: "CCHAN", ts: "1732123500.000001", thread_ts: dm.ts }, policy);
  const [mention] = state.jobs.ready();
  if (!mention) throw new Error("Expected queued mention");
  state.jobs.answer(mention.id, mention.attempt, "done");
  expect(state.jobs.ready()).toMatchObject([{ source: "own-thread", conversation: mention.conversation }]);
});

test("replayed enrolled mentions identify the thread for live overlap recovery", () => {
  const state = open("orchestrate");
  const root = "1732123000.000001";
  const mention = { ...dm, type: "app_mention", channel: "CCHAN", user: "UOTHER", thread_ts: root };
  const expected = { channel: "CCHAN", threadTs: root, ts: dm.ts };
  expect(state.consume(mention, policy)).toEqual(expected);
  expect(state.consume(mention, { ...policy, otherUserReplyRate: { CCHAN: 0 } })).toEqual(expected);
});

test("reactions and declined reply decisions cannot start work even on redelivery", () => {
  const state = open("orchestrate");
  const other = { ...dm, user: "UOTHER" };
  state.consume(other, { ...policy, otherUserReplyRate: { DDM: 0 } });
  state.consume(other, { ...policy, otherUserReplyRate: { DDM: 1 } });
  state.consume({ type: "reaction_added", user: "UOWNER", reaction: "wave",
    item_user: "UBOT", item: { type: "message", channel: "DDM", ts: dm.ts }, event_ts: dm.ts }, policy);
  expect(state.jobs.ready()).toEqual([]);
});

test("retries the pending line after an output failure", () => {
  const state = open();
  state.consume(dm, policy);
  expect(() => state.drain(() => { throw new Error("broken pipe"); })).toThrow();
  const lines: string[] = [];
  state.drain(line => lines.push(line));
  expect(lines).toHaveLength(1);
});

test("a different workspace or bot cannot open existing state", () => {
  open().close();
  expect(() => new ReceiverState(path, "TOTHER", "UBOT")).toThrow();
  expect(() => new ReceiverState(path, "TTEAM", "UOTHER")).toThrow();
  expect(open().recoveryCursor()).toBeUndefined();
});

test("creates restricted state directories and files", () => {
  open();
  expect(statSync(join(folder, "private")).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("a second receiver cannot open an active state file", () => {
  open();
  expect(() => open()).toThrow();
});

test("release after process death permits reopening with committed cursor", async () => {
  open().close();
  const child = Bun.spawn([
    process.execPath, "-e",
    'import { ReceiverState } from "./src/state.ts"; const s = new ReceiverState(process.argv[1], "TTEAM", "UBOT"); s.setRecoveryCursor("1732123456.000000"); console.log("ready"); setInterval(()=>s.recoveryCursor(), 60000);',
    path,
  ], {stdout: "pipe", stderr: "inherit"});
  const reader = child.stdout.getReader();
  try {
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
    expect(() => open()).toThrow();
  } finally {
    reader.releaseLock();
    child.kill("SIGKILL");
    await child.exited;
  }
  expect(open().recoveryCursor()).toBe("1732123456.000000");
});

test("observing a bot reply enrolls its thread for future inbound replies", () => {
  const state = open();
  const root = "1732123000.100000";
  state.consume({ type: "message", channel: "CCHAN", user: policy.botUser,
    thread_ts: root, ts: "1732123100.123456", text: "noted" }, policy);
  state.consume({...dm, channel: "CCHAN", channel_type: "channel", thread_ts: root}, policy);
  const lines: string[] = [];
  state.drain(line => lines.push(line));
  expect(lines).toHaveLength(1);
  expect(state.threads()).toEqual([{channel: "CCHAN", threadTs: root}]);
  expect(state.channels()).toEqual([]);
});

test("a bot reply to a human post does not make the root a bot reaction target", () => {
  const state = open();
  state.consume({ type: "message", channel: "CCHAN", user: policy.botUser,
    thread_ts: dm.ts, ts: "1732123500.000001", text: "noted" }, policy);
  state.consume({
    type: "reaction_added", user: "UOWNER", reaction: "wave",
    event_ts: "1732124000.000001", item: { type: "message", channel: "CCHAN", ts: dm.ts },
  }, policy);
  const lines: string[] = [];
  state.drain(line => lines.push(line));
  expect(lines).toEqual([]);
  expect(state.threads()).toEqual([{channel: "CCHAN", threadTs: dm.ts}]);
});

test("memory replay opens without creating a file", () => {
  // Isolate the filesystem assertion even when suites run in parallel.
  const moduleURL = new URL("../src/state.ts", import.meta.url).href;
  const script = `import { ReceiverState } from ${JSON.stringify(moduleURL)};
    new ReceiverState(":memory:", "TTEAM", "UBOT").close();`;
  const child = Bun.spawnSync([process.execPath, "-e", script], {cwd: folder});
  expect(child.exitCode).toBe(0);
  expect(() => statSync(join(folder, ":memory:"))).toThrow();
});

test("delivery-limit recovery keeps its bounds across a restart", () => {
  const first = open();
  expect(first.readLimitEnd()).toBeUndefined();
  first.setRecoveryCursor("1732123456.000000");
  first.saveRateLimit("1732123400.000000", 1732123460);
  first.close();

  const second = open();
  expect(second.recoveryCursor()).toBe("1732123400.000000");
  expect(second.readLimitEnd()).toBe(1732123460);
  second.clearLimit();
  second.close();

  const third = open();
  expect(third.readLimitEnd()).toBeUndefined();
  expect(third.recoveryCursor()).toBe("1732123400.000000");
});

test("a retried bot post reports its root for follow-up recovery", () => {
  const state = open();
  const threadTs = "1732123000.000000";
  const botPost = { ...dm, channel: "CCHAN", channel_type: "channel", thread_ts: threadTs, user: policy.botUser };
  state.consume(botPost, policy);
  expect(state.consume(botPost, policy)).toEqual({channel: "CCHAN", threadTs, ts: dm.ts});
  expect(state.consume(dm, policy)).toBeUndefined();
});
