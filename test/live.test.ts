import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function listen(config: string, delivery: "crash" | "resume" | "redeliver") {
  const child = Bun.spawn([
    process.execPath, "--no-env-file", "--preload", "./test/fixtures/local-slack.ts", "src/cli.ts", "listen",
  ], {
    env: {
      EIN_CONFIG: config, EIN_APP_TOKEN: "xapp-test", EIN_BOT_TOKEN: "xoxb-test",
      LOCAL_DELIVERY: delivery,
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 3000,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { out, err, code };
}

test("listen durably accepts an event before ACK and delivers it once across restarts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-live-"));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({
    team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER",
    watchChannels: [], stateFile: "state.sqlite",
  }));
  try {
    // The peer exits the first process inside its ACK handler, before stdout can drain.
    expect(await listen(config, "crash")).toEqual({ code: 42, out: "", err: "" });
    const line = 'INBOUND dm DTEST 1000000000.000001 1000000000.000001 UOWNER "hello"\n';
    expect(await listen(config, "resume")).toEqual({ code: 0, out: line, err: "" });
    expect(await listen(config, "redeliver")).toEqual({ code: 0, out: "", err: "" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
