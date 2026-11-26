import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("orchestrate recovers an ACKed job and an accepted POST, then reuses the thread session after a config change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-orchestrate-cli-"));
  const bin = join(dir, "bin");
  const project = join(dir, "project");
  const configFile = join(dir, "config.json");
  const config = {
    team: "TTEST", appId: "AEIN", botUser: "UBOT", ownerUser: "UOWNER", watchChannels: ["CPROJECT"],
    stateFile: "state.sqlite", projects: { ein: { path: "project", channels: ["CPROJECT"] } },
  };
  const rows = (filename: string) => {
    const file = join(dir, filename);
    return existsSync(file) ? readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)) : [];
  };
  const run = async (phase: string, runner: string) => {
    writeFileSync(configFile, JSON.stringify({ ...config, runner }));
    const child = Bun.spawn([
      process.execPath, "--no-env-file", "--preload", "./test/fixtures/orchestrate-slack.ts", "src/cli.ts", "orchestrate",
    ], {
      env: { HOME: dir, PATH: bin, EIN_CONFIG: configFile, FIXTURE_ROOT: dir, FIXTURE_PHASE: phase,
        EIN_APP_TOKEN: "xapp-test", EIN_BOT_TOKEN: "xoxb-test" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 7000, killSignal: "SIGKILL",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { out, err, code };
  };
  try {
    mkdirSync(bin);
    mkdirSync(project);
    const fixture = readFileSync(join(import.meta.dir, "fixtures", "orchestrate-herdr.ts"), "utf8");
    writeFileSync(join(bin, "herdr"), `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    for (const runner of ["codex", "claude"]) {
      writeFileSync(join(bin, runner), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    }
    expect(await run("crash", "codex")).toEqual({ code: 42, out: "", err: "" });
    expect(rows("posts.jsonl")).toHaveLength(0);
    expect(await run("recover", "codex")).toEqual({ code: 43, out: "", err: "" });
    expect(rows("posts.jsonl")).toHaveLength(1);
    expect(await run("followup", "claude")).toEqual({ code: 0, out: "", err: "" });
    expect(rows("acks.jsonl")).toEqual([["crash", "root"], ["followup", "root"], ["followup", "overlap"], ["followup", "reply"]]);
    expect(rows("reconciled.jsonl")).toEqual([["CPROJECT", "1000000000.000001"]]);

    const calls = rows("herdr.jsonl");
    expect(calls.filter(call => call.command === "tab create").map(call => call.cwd)).toEqual([project]);
    expect(calls.filter(call => call.command === "agent start").map(call => call.kind)).toEqual(["codex"]);
    const turns = calls.filter(call => call.command === "agent prompt");
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map(turn => turn.jobId)).size).toBe(2);
    expect(new Set(turns.map(turn => turn.pane)).size).toBe(1);
    expect(turns.some(turn => turn.role === "main")).toBe(false);
    expect(rows("posts.jsonl").map(post => [post.channel, post.thread_ts, post.text])).toEqual(
      turns.map(turn => ["CPROJECT", "1000000000.000001", `verified job ${turn.jobId}`]),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 24_000);
