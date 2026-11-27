import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { startPeerTLS, waitFor } from "./fixtures/sdk-peer";

const owner = { team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER", ownerDm: "DROOM" };
const appToken = "xapp-fixture-setup-private";
const botToken = "xoxb-fixture-setup-private";
const challengePattern = /\bein-[a-f0-9]{24}\b/;
let root: string;
let configDir: string;
let config: string;
let envTokens: { EIN_APP_TOKEN: string; EIN_BOT_TOKEN: string } | undefined;
let peer: ReturnType<typeof startPeerTLS> | undefined;
const children = new Set<ReturnType<typeof spawn>>();

beforeEach(() => {
  envTokens = { EIN_APP_TOKEN: appToken, EIN_BOT_TOKEN: botToken };
  root = mkdtempSync(join(tmpdir(), "ein-setup-cli-"));
  configDir = join(root, "ein");
  mkdirSync(configDir);
  config = join(configDir, "config.json");
});
afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  await peer?.stop();
  peer = undefined;
  rmSync(root, { recursive: true, force: true });
});

function setup(...args: string[]) {
  const redirect = peer ? ["--preload", "./test/fixtures/sdk-slack-redirect.ts"] : [];
  const child = spawn(process.execPath, ["--no-env-file", ...redirect, "src/cli.ts", "setup", ...args], {
    env: { HOME: root, PATH: root, EIN_CONFIG: config, ...(peer && {
      NODE_EXTRA_CA_CERTS: peer.caFile, EIN_TEST_SLACK_API: peer.apiUrl, ...envTokens,
    }) },
    stdio: ["ignore", "pipe", "pipe"], timeout: 12_000, killSignal: "SIGKILL",
  });
  children.add(child);
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => { out += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { err += data; });
  const result = new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      children.delete(child);
      resolve({ code, out, err });
    });
  });
  return { child, result, get output() { return out + err; } };
}

async function pairingCode(session: ReturnType<typeof setup>) {
  await waitFor(() => challengePattern.test(session.output) || session.child.exitCode !== null, "pairing challenge");
  const code = session.output.match(challengePattern)?.[0];
  if (!code) throw new Error(`Pairing ended before a challenge appeared: ${session.output}`);
  return code;
}

function dm(text: string, envelopeId: string) {
  return { type: "events_api", envelope_id: envelopeId, payload: {
    type: "event_callback", api_app_id: owner.appId, team_id: owner.team,
    authorizations: [{ user_id: owner.botUser, team_id: owner.team, is_bot: true }],
    event: { type: "message", channel: owner.ownerDm, channel_type: "im", user: owner.ownerUser,
      text, ts: (Date.now() / 1000).toFixed(6) },
  } };
}

test("status and the pasteable manifest work before setup without creating local files", async () => {
  const status = await setup("--status").result;
  expect(status.code).toBe(0);
  expect(status.out + status.err).toMatch(/\S/);
  const manifest = await setup("--manifest").result;
  expect(manifest.code).toBe(0);
  expect(JSON.parse(manifest.out)).toEqual(await Bun.file("examples/slack-manifest.json").json());
  expect(readdirSync(configDir)).toEqual([]);
});

test("setup preserves a hand-authored config and its directory", async () => {
  const manual = JSON.stringify({ ...owner, watchChannels: ["CWATCH"], runner: "claude", herdrWorkspace: "My Ein" }, null, 4);
  writeFileSync(config, manual);
  for (const args of [[], ["--status"], ["--app", "AOTHER"], ["--pair"], ["--confirm", "UOTHER"]]) {
    const result = await setup(...args).result;
    if (args.length === 0 || args[0] === "--status") expect(result.code).toBe(0);
    if (args[0] === "--status") {
      expect(result.out).toContain("herdr session attach ein");
      expect(result.out).toContain("My Ein");
    }
    expect(result.out + result.err).not.toMatch(challengePattern);
    expect(readFileSync(config, "utf8")).toBe(manual);
    expect(readdirSync(configDir)).toEqual(["config.json"]);
  }
});

test("a different Socket Mode app cannot issue a setup challenge", async () => {
  peer = startPeerTLS({ appId: "AOTHER" });
  expect((await setup("--app", owner.appId).result).code).toBe(0);
  const result = await setup("--pair").result;
  expect(result.code).toBe(1);
  expect(peer.connections).toBe(1);
  expect(result.out + result.err).not.toMatch(challengePattern);
  expect(existsSync(config)).toBe(false);
});

test("setup resumes pairing and recovers an accepted confirmation from the owner's DM after a lost reply", async () => {
  const posts: unknown[] = [];
  const accepted: { ts: string; user: string; metadata: unknown }[] = [];
  let allowReply = false;
  peer = startPeerTLS({
    async onPost(request) {
      const message: unknown = await request.json();
      posts.push(message);
      if (!allowReply) return Response.json({ ok: false, error: "missing_scope" });
      const metadata = message && typeof message === "object" && "metadata" in message ? message.metadata : undefined;
      accepted.push({ ts: (Date.now() / 1000).toFixed(6), user: owner.botUser, metadata });
      return new Response(null, { status: 500 });
    },
    onHistory(method, params) {
      if (method !== "conversations.history" || params.get("channel") !== owner.ownerDm) return { ok: true, messages: [] };
      const messages = params.get("include_all_metadata") === "true" ? accepted : accepted.map(({ ts, user }) => ({ ts, user }));
      return { ok: true, messages };
    },
  });
  expect((await setup("--app", owner.appId).result).code).toBe(0);
  const first = setup("--pair");
  await pairingCode(first);
  first.child.kill("SIGINT");
  await first.result;
  expect(existsSync(config)).toBe(false);

  const second = setup("--pair");
  const code = await pairingCode(second);
  const good = dm(code, "correct");
  const attempts = [
    dm("unrelated message", "unrelated"),
    { ...good, envelope_id: "other-workspace", payload: { ...good.payload, team_id: "TOTHER" } },
    { ...good, envelope_id: "channel", payload: { ...good.payload, event: {
      ...good.payload.event, user: "UOTHER", channel: "COTHER", channel_type: "channel",
    } } },
  ];
  for (const attempt of attempts) {
    peer.send(2, attempt);
    await waitFor(() => peer?.acks.some(a => a.id === attempt.envelope_id) === true, "unrelated event acknowledgment");
  }
  peer.send(2, good);
  expect((await second.result).code).toBe(0);
  expect((await setup("--confirm", "UOTHER").result).code).toBe(1);
  envTokens = { EIN_APP_TOKEN: "xapp-other-app", EIN_BOT_TOKEN: botToken };
  expect((await setup("--confirm", owner.ownerUser).result).code).toBe(1);
  envTokens = { EIN_APP_TOKEN: appToken, EIN_BOT_TOKEN: botToken };
  expect(posts).toEqual([]);
  expect(existsSync(config)).toBe(false);

  expect((await setup("--confirm", owner.ownerUser).result).code).toBe(1);
  expect(posts).toHaveLength(1);
  expect(existsSync(config)).toBe(false);
  allowReply = true;
  expect((await setup("--confirm", owner.ownerUser).result).code).toBe(1);
  expect(accepted).toHaveLength(1);
  expect(existsSync(config)).toBe(false);
  const confirmation = await setup("--confirm", owner.ownerUser).result;
  expect(confirmation.code).toBe(0);
  expect(posts).toHaveLength(2);
  expect(posts[1]).toMatchObject({ channel: owner.ownerDm, text: "연결됐어요" });
  const history = peer.calls.filter(call => call.method.startsWith("conversations."));
  expect(history.map(call => [call.method, call.params.get("channel")])).toEqual([["conversations.history", owner.ownerDm]]);
  expect(loadConfig(config)).toMatchObject({ ...owner, herdrWorkspace: "Ein-AEIN" });
  expect(confirmation.out).toContain("Herdr를 설치");
  expect(confirmation.out).toContain("herdr session attach ein");
  expect(confirmation.out).toContain("Ein-AEIN");
  expect(statSync(config).mode & 0o777).toBe(0o600);
  const visible = second.output + confirmation.out + confirmation.err + readFileSync(config, "utf8");
  expect(visible).not.toContain(appToken);
  expect(visible).not.toContain(botToken);
}, 25_000);

test("the wizard keeps tokens private when confirmation is deferred to a later process", async () => {
  envTokens = undefined;
  peer = startPeerTLS({ async onPost() {
    return Response.json({ ok: true, channel: owner.ownerDm, ts: "1700000000.000001" });
  } });
  let transcript = "";
  const decoder = new TextDecoder();
  await using terminal = new Bun.Terminal({ data(_term, data) { transcript += decoder.decode(data, { stream: true }); } });
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./test/fixtures/sdk-slack-redirect.ts",
    "src/cli.ts", "setup"], { terminal, timeout: 12_000, killSignal: "SIGKILL",
    env: { HOME: root, PATH: root, EIN_CONFIG: config, NODE_EXTRA_CA_CERTS: peer.caFile, EIN_TEST_SLACK_API: peer.apiUrl } });
  async function answer(prompt: string, value: string) {
    await waitFor(() => transcript.includes(prompt) || child.exitCode !== null, prompt);
    expect(transcript).toContain(prompt);
    terminal.write(value + "\r");
  }
  try {
    await answer("기존 앱]", "2");
    await answer("Basic Information → App ID", owner.appId);
    await answer("(xapp-)", appToken);
    await answer("(xoxb-)", botToken);
    await waitFor(() => challengePattern.test(transcript), "terminal DM challenge");
    const code = transcript.match(challengePattern)?.[0];
    if (!code) throw new Error("Missing terminal challenge");
    peer.send(1, dm(code, "interactive"));
    await answer("[y/N]", "");
    expect(await child.exited).toBe(0);
    expect(transcript).not.toContain(appToken);
    expect(transcript).not.toContain(botToken);
    expect(existsSync(config)).toBe(false);
    expect(peer.calls.some(c => c.method === "chat.postMessage")).toBe(false);
    const status = await setup("--status").result;
    expect(status.out).toContain("--confirm " + owner.ownerUser);
    expect((await setup("--confirm", owner.ownerUser).result).code).toBe(0);
    const saved = loadConfig(config);
    for (const [path, token] of [[saved.appTokenFile, appToken], [saved.botTokenFile, botToken]] as const) {
      if (!path) throw new Error("The config lacks the privately entered token file");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, "utf8").trim()).toBe(token);
    }
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
}, 18_000);
