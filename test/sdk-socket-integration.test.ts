import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiverState } from "../src/state";
import { startPeerTLS, waitFor } from "./fixtures/sdk-peer";

const identity = { team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER", ownerDm: "DROOM" };
const nowTs = () => (Date.now() / 1000).toFixed(6);
function event(id: string, ts: string, text: string) {
  return { type: "events_api", envelope_id: id, payload: {
    type: "event_callback", api_app_id: identity.appId, team_id: identity.team,
    event: { type: "message", channel: identity.ownerDm, user: identity.ownerUser, ts, text },
  } };
}

let root: string;
let path: string;
let peer: ReturnType<typeof startPeerTLS> | undefined;
let running: ReturnType<typeof launch> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ein-sdk-wire-"));
  path = join(root, "state.sqlite");
});
afterEach(async () => {
  if (running) {
    running.kill("SIGKILL");
    await running.result;
    running = undefined;
  }
  await peer?.stop();
  peer = undefined;
  rmSync(root, { recursive: true, force: true });
});

function launch(slack: ReturnType<typeof startPeerTLS>, mode: "listen" | "orchestrate") {
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ ...identity, watchChannels: [], stateFile: path, runner: "codex" }));
  // Jobs may be queued; the test host's installed runners are never used.
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const program of ["herdr", "codex"]) symlinkSync("/usr/bin/false", join(bin, program));
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload",
    "./test/fixtures/sdk-slack-redirect.ts", "src/cli.ts", mode], {
    env: { HOME: root, PATH: bin, EIN_CONFIG: config, EIN_APP_TOKEN: "xapp-test", EIN_BOT_TOKEN: "xoxb-test",
      EIN_TEST_SLACK_API: slack.apiUrl, NODE_EXTRA_CA_CERTS: slack.caFile },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 55_000, killSignal: "SIGKILL",
  });
  let stdout = "";
  const output = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      stdout += decoder.decode(chunk.value, { stream: true });
    }
    stdout += decoder.decode();
  })();
  const result = Promise.all([child.exited, new Response(child.stderr).text(), output])
    .then(([code, err]) => ({ code, err, out: stdout }));
  return { result, kill: (signal: NodeJS.Signals) => child.kill(signal), get stdout() { return stdout; },
    get signalCode() { return child.signalCode; } };
}

test("Slack SDK ACK reaches the wire only after the CLI's SQLite intake survives SIGKILL", async () => {
  peer = startPeerTLS({ onAck: () => running?.kill("SIGKILL") });
  running = launch(peer, "orchestrate");
  await waitFor(() => peer!.connections === 1, "first SDK connection");
  const ts = nowTs();
  peer.send(1, event("persist", ts, "queued before ACK"));
  await waitFor(() => peer!.acks.length === 1, "durable ACK");
  await running.result;
  expect(running.signalCode).toBe("SIGKILL");
  using stored = new Database(path, { readonly: true });
  expect(peer.acks).toEqual([{ connection: 1, id: "persist" }]);
  expect(stored.query("SELECT key FROM outbox").all()).toEqual([{ key: `m:DROOM:${ts}` }]);
  expect(stored.query("SELECT ts, text FROM jobs").all()).toEqual([{ ts, text: "queued before ACK" }]);
});

test("a failed SQLite work insert rolls back the receipt and produces no SDK ACK", async () => {
  new ReceiverState(path, identity.team, identity.botUser, "orchestrate").close();
  {
    using setup = new Database(path);
    setup.exec("CREATE TRIGGER reject_work BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'fixture failure'); END");
  }
  peer = startPeerTLS();
  running = launch(peer, "orchestrate");
  await waitFor(() => peer!.connections === 1, "SDK connection");
  peer.send(1, event("cannot-save", nowTs(), "must roll back"));
  const { code } = await running.result;
  expect(code).toBe(1);
  expect(peer.acks).toEqual([]);
  using stored = new Database(path, { readonly: true });
  expect(stored.query("SELECT key FROM outbox").all()).toEqual([]);
  expect(stored.query("SELECT id FROM jobs").all()).toEqual([]);
}, 10_000);

test("a mismatched Socket Mode hello cannot dispatch or ACK the following envelope", async () => {
  peer = startPeerTLS({ appId: "AOTHER", afterHello: event("wrong-app", nowTs(), "ignored") });
  running = launch(peer, "listen");
  const { code, out, err } = await running.result;
  expect(code).toBe(1);
  expect(err).toContain("app ID");
  expect(out).toBe("");
  expect(peer.acks).toEqual([]);
  using db = new Database(path, { readonly: true });
  expect(db.query("SELECT cursor FROM receiver").get()).toEqual({ cursor: null });
}, 10_000);

test("the SDK receives Agent Messages threads and acknowledges an unsupported agent stop without queuing it", async () => {
  peer = startPeerTLS();
  running = launch(peer, "orchestrate");
  await waitFor(() => peer!.connections === 1, "SDK connection");
  const threadTs = "1700000000.000001";
  const input = event("agent-message", nowTs(), "Agent thread message");
  peer.send(1, { ...input, payload: { ...input.payload, event: { ...input.payload.event,
    channel_type: "im", thread_ts: threadTs,
    app_context: { entities: [{ type: "slack#/types/channel_id", value: "CPROJECT", team_id: identity.team }] },
  } } });
  await waitFor(() => peer!.acks.some(a => a.id === "agent-message"), "thread message ACK");
  peer.send(1, { type: "events_api", envelope_id: "agent-stop", payload: {
    type: "event_callback", team_id: identity.team, api_app_id: identity.appId, event: {
      type: "agent_session_stopped", user: identity.ownerUser, channel: identity.ownerDm,
      event_ts: nowTs(), thread_ts: threadTs, streaming_message_ts: [input.payload.event.ts],
    },
  } });
  await waitFor(() => peer!.acks.some(a => a.id === "agent-stop"), "unsupported Agent event ACK");
  running.kill("SIGTERM");
  expect((await running.result).code).toBe(0);
  using db = new Database(path, { readonly: true });
  expect(db.query("SELECT source, channel, threadTs, text FROM jobs").all()).toEqual([{
    source: "dm-thread", channel: identity.ownerDm, threadTs, text: "Agent thread message",
  }]);
  expect(db.query("SELECT key FROM outbox").all()).toEqual([{ key: `m:DROOM:${input.payload.event.ts}` }]);
});

test("a dropped SDK socket backfills the persisted gap and deduplicates Slack redelivery across refresh", async () => {
  let missedTs = "";
  peer = startPeerTLS({
    onHistory: method => ({ ok: true, messages: method === "conversations.history" && missedTs
      ? [{ ts: missedTs, user: identity.ownerUser, text: "received during gap" }] : [] }),
  });
  running = launch(peer, "listen");
  await waitFor(() => peer!.connections === 1, "SDK connection");
  const beforeTs = nowTs();
  peer.send(1, event("first", beforeTs, "before gap"));
  await waitFor(() => peer!.acks.some(a => a.id === "first"), "original ACK");
  const beforeLoss = nowTs();
  peer.drop(1);
  missedTs = nowTs();
  await waitFor(() => peer!.connections === 2, "automatic SDK reconnection", 15_000);
  // Seeing the recovered line before redelivering its live envelope proves HTTP backfill worked.
  await waitFor(() => running!.stdout.includes('"received during gap"'), "recovered message");
  const history = peer.calls.find(c => c.method === "conversations.history" && c.params.get("channel") === identity.ownerDm);
  expect(Number(history?.params.get("oldest"))).toBeGreaterThan(0);
  expect(Number(history!.params.get("oldest"))).toBeLessThanOrEqual(Number(beforeLoss));
  expect(Number(history!.params.get("latest"))).toBeGreaterThanOrEqual(Number(missedTs));
  peer.send(2, event("redelivered", missedTs, "received during gap"));
  await waitFor(() => peer!.acks.some(a => a.id === "redelivered"), "redelivery ACK");
  peer.send(2, { type: "disconnect", reason: "refresh_requested" });
  await waitFor(() => peer!.connections === 3, "Slack-requested refresh", 15_000);
  peer.send(3, event("after-refresh", missedTs, "received during gap"));
  await waitFor(() => peer!.acks.some(a => a.id === "after-refresh"), "refreshed ACK");
  running.kill("SIGTERM");
  const { out, code } = await running.result;
  expect(code).toBe(0);
  expect(out.trimEnd().split("\n")).toHaveLength(2);
  expect(peer.acks).toEqual([{ id: "first", connection: 1 }, { id: "redelivered", connection: 2 }, { id: "after-refresh", connection: 3 }]);
}, 40_000);

test("SDK heartbeat survives repeated real ping/pong cycles on Bun", async () => {
  peer = startPeerTLS();
  running = launch(peer, "listen");
  await waitFor(() => peer!.connections === 1, "SDK connection");
  const firstConnection = Date.now();
  peer.ping(1);
  await waitFor(() => peer!.pongs.includes(1), "client pong for peer ping");
  // Slack sends server pings independently from the SDK's client pings. Let both watchdogs run.
  let closed = false;
  const heartbeat = setInterval(() => {
    try { peer!.ping(1); }
    catch { closed = true; }
  }, 5000);
  try {
    await waitFor(() => closed || peer!.pings.filter(i => i === 1).length >= 7, "seven client heartbeat pings", 46_000);
    expect(closed).toBe(false);
  } finally {
    clearInterval(heartbeat);
  }
  peer.send(1, event("after-heartbeat", nowTs(), "still connected"));
  await waitFor(() => peer!.acks.some(a => a.id === "after-heartbeat"), "ACK after heartbeat");
  expect(peer.connections).toBe(1);
  expect(peer.acks).toEqual([{ id: "after-heartbeat", connection: 1 }]);
  running.kill("SIGTERM");
  expect((await running.result).code).toBe(0);
  using db = new Database(path, { readonly: true });
  const { cursor } = db.query<{cursor: string}, []>("SELECT cursor FROM receiver").get()!;
  expect(Number(cursor) * 1000).toBeGreaterThan(firstConnection + 20_000);
}, 50_000);
