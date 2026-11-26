import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let configFile: string;
const config = { team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER", watchChannels: ["CROOM"] };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ein-cli-"));
  configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify({ ...config, stateFile: "state.sqlite" }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], input = "") {
  const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
    env: { ...process.env, EIN_CONFIG: configFile }, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { out, err, code };
}

test("replay emits one physical record across alternate subscriptions and ignores other teams", async () => {
  const event = { type: "message", channel: "CROOM", ts: "1000000000.000001", user: "UALICE", text: "<@UBOT> hi\nagain" };
  const input = [
    { team_id: "TOTHER", event: { ...event, ts: "1000000000.000002" } },
    { team_id: "TTEST", event },
    { team_id: "TTEST", event: { ...event, type: "app_mention" } },
  ].map(item => JSON.stringify({ type: "event_callback", ...item })).join("\n");
  const result = await cli(["replay"], input);
  expect(result).toEqual({ code: 0, out: 'INBOUND mention CROOM 1000000000.000001 1000000000.000001 UALICE "<@UBOT> hi\\nagain"\n', err: "" });
  expect(await Bun.file(join(dir, "state.sqlite")).exists()).toBe(false);
});

test("check validates the selected config offline", async () => {
  const result = await cli(["check"]);
  expect(result.code).toBe(0);
  expect(await Bun.file(join(dir, "state.sqlite")).exists()).toBe(false);
});

test("invalid config diagnostics identify the field without echoing values", async () => {
  writeFileSync(configFile, JSON.stringify({ ...config, otherUserReplyRate: { CROOM: "private-payload-marker" } }));
  const result = await cli(["check"]);
  expect(result.code).toBe(1);
  expect(result.err).toContain("otherUserReplyRate");
  expect(result.err).not.toContain("private-payload-marker");
});

test("replay reports malformed input by line without echoing private text", async () => {
  const result = await cli(["replay"], "private-payload-marker");
  expect(result.code).toBe(1);
  expect(result.err).toContain("line 1");
  expect(result.err).not.toContain("private-payload-marker");
});
