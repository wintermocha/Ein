import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiverState } from "../src/state";

let dir: string;
let stateFile: string;
let configFile: string;
const base = { team: "TTEST", botUser: "UBOT", appId: "AEIN", ownerUser: "UOWNER", watchChannels: [] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ein-service-"));
  stateFile = join(dir, "state.sqlite");
  configFile = join(dir, "config.json");
  for (const cli of ["herdr", "codex"]) symlinkSync("/usr/bin/false", join(dir, cli));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function runService(config: object) {
  writeFileSync(configFile, JSON.stringify({ ...base, stateFile, ...config }));
  const child = Bun.spawn([process.execPath, "--no-env-file", "--preload", "./test/fixtures/local-slack.ts",
    "src/cli.ts", "orchestrate"], {
    env: { PATH: dir, LOCAL_DELIVERY: "resume", EIN_CONFIG: configFile, EIN_APP_TOKEN: "xapp-test", EIN_BOT_TOKEN: "xoxb-test" },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3_000,
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}

test("orchestrate requires an explicit runner before opening receiver state", async () => {
  const result = await runService({});
  expect(result.code).toBe(1);
  expect(result.err).toContain("Set runner");
  expect(existsSync(stateFile)).toBe(false);
});

test("a mismatched app token cannot start a pending delivery", async () => {
  let state = new ReceiverState(stateFile, base.team, base.botUser, "orchestrate");
  state.jobs.queueDelivery("one", "conversation", "DTEST", null, "private-delivery-marker");
  state.close();
  const result = await runService({ runner: "codex", appId: "AOTHER" });
  expect(result.code).toBe(1);
  expect(result.out).toBe("");
  expect(result.err).toContain("app ID");
  expect(result.err).not.toContain("private-delivery-marker");
  state = new ReceiverState(stateFile, base.team, base.botUser, "orchestrate");
  try { expect(state.jobs.claimDelivery(Date.now())?.mode).toBe("send"); }
  finally { state.close(); }
});

test("an orchestrator restart leaves unfinished listen stdout records available to listen", async () => {
  const input = { type: "message", channel: "DROOM", user: "UOWNER", ts: "1000000000.000001", text: "saved" };
  let state = new ReceiverState(stateFile, base.team, base.botUser);
  state.consume(input, { ...base, blockedUsers: [], otherUserReplyRate: {} });
  state.close();
  expect(await runService({ runner: "codex" })).toEqual({ code: 0, out: "", err: "" });
  state = new ReceiverState(stateFile, base.team, base.botUser);
  const emitted: string[] = [];
  try { state.drain(line => emitted.push(line)); }
  finally { state.close(); }
  expect(emitted).toEqual(['INBOUND dm DROOM 1000000000.000001 1000000000.000001 UOWNER "saved"']);
});

test("private session data cannot be redirected through a symlink", async () => {
  const target = join(dir, "target");
  mkdirSync(target);
  symlinkSync(target, stateFile + ".orchestration");
  const result = await runService({ runner: "codex" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("private directory");
  expect(existsSync(join(target, "turns"))).toBe(false);
});

test("reopening a database reuses local session files and a new database at the same path isolates them", async () => {
  const directories = () => readdirSync(stateFile + ".orchestration").sort();
  expect((await runService({ runner: "codex" })).code).toBe(0);
  const first = directories();
  expect(first).toHaveLength(1);
  expect((await runService({ runner: "codex" })).code).toBe(0);
  expect(directories()).toEqual(first);
  renameSync(stateFile, stateFile + ".backup");
  expect((await runService({ runner: "codex" })).code).toBe(0);
  expect(directories()).toHaveLength(2);
  expect(directories()).toEqual(expect.arrayContaining(first));
});

test("existing shared session directories are refused without changing permissions", async () => {
  const root = stateFile + ".orchestration";
  mkdirSync(root);
  chmodSync(root, 0o755);
  const result = await runService({ runner: "codex" });
  expect(result.code).toBe(1);
  expect(result.err).toContain("private directory");
  expect(statSync(root).mode & 0o777).toBe(0o755);
});
