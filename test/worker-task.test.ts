import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "../src/cli.ts");

test("folder opt-in gates one-shot workers, preserves literal task input, and returns the final answer", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ein-task-")));
  const folder = join(root, "project");
  const sibling = join(root, "sibling");
  const alias = join(root, "alias");
  const bin = join(root, "bin");
  for (const directory of [folder, sibling, bin]) mkdirSync(directory);
  symlinkSync(folder, alias);
  const env = { PATH: bin, EIN_HOME: join(root, "ein"), HOME: root,
    EIN_CONFIG: join(root, "absent-config"), EIN_BOT_TOKEN: "bot", HOGU_APP_TOKEN: "app",
    SLACK_BOT_TOKEN: "slack", EIN_SNIFFER_TOKEN_FILE: "parent", EIN_SNIFFER_EXPECT_PROJECT: "wrong",
    CLAUDECODE: "1", CODEX_THREAD_ID: "parent", EIN_AGENT_SESSION: "parent",
    CODEX_API_KEY: "fixture", CODEX_CA_CERTIFICATE: "fixture.pem" };
  async function run(cwd: string, args: string[], input = "") {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      cwd, env, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, out, err };
  }
  try {
    expect((await run(folder, ["task", "work"])).code).toBe(1);
    expect((await run(folder, ["orchestration", "enable"])).out).toContain("enabled codex\n");
    expect((await run(alias, ["orchestration", "status"])).out).toContain("enabled codex\n");
    expect((await run(sibling, ["orchestration", "status"])).out).toBe("disabled\n");
    expect((await run(folder, ["task", "work"])).err).toContain("Missing executable on PATH: codex");
    writeFileSync(env.EIN_CONFIG, JSON.stringify({ models: { codex: "fixture-codex", claude: "fixture-claude", omo: "fixture-omo" } }));
    const task = "-o /tmp/unwanted\n$(touch SHOULD_NOT_EXIST) 'task'";
    for (const runner of ["codex", "claude", "omo"]) {
      const fixture = `#!${process.execPath}
if (process.argv.includes("mcp")) { console.log('[{"name":"fixture","enabled":true}]'); process.exit(0); }
const input = await Bun.stdin.text();
const env = process.env;
if (["SLACK_BOT_TOKEN", "EIN_BOT_TOKEN", "HOGU_APP_TOKEN", "CODEX_THREAD_ID", "EIN_AGENT_SESSION", "CLAUDECODE", "EIN_SNIFFER_TOKEN_FILE", "EIN_SNIFFER_EXPECT_PROJECT"].some(key => key in env)
    || env.EIN_SNIFFER_DELEGATION !== "none" || env.CODEX_API_KEY !== "fixture" || env.CODEX_CA_CERTIFICATE !== "fixture.pem") process.exit(11);
const args = process.argv.slice(2);
if (!args.includes(${JSON.stringify("fixture-" + runner)})) process.exit(13);
if (${JSON.stringify(runner)} === "codex" && !args.includes('mcp_servers={"fixture"={enabled=false}}')) process.exit(14);
if (args.includes(input) || !args.includes(${JSON.stringify({codex:"--ephemeral",claude:"--no-session-persistence",omo:"--no-session"}[runner])})) process.exit(12);
if (input === "fail") { console.log("partial"); process.exit(7); }
if (input === "partial") { console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"still working"}})); process.exit(0); }
const answer = process.cwd() + "\\n" + input;
switch (${JSON.stringify(runner)}) {
  case "codex":
    for (const text of ["working", answer]) console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text}}));
    console.log(JSON.stringify({type:"turn.completed"}));
    break;
  case "claude": console.log(answer); break;
  case "omo":
    for (const [text,stopReason] of [["working","toolUse"],[answer,"stop"]])
      console.log(JSON.stringify({type:"message_end",message:{ role:"assistant",stopReason,content:[{type:"text",text}]}}));
}
`;
      writeFileSync(join(bin, runner), fixture, { mode: 0o700 });
      expect((await run(folder, ["orchestration", "enable", runner])).code).toBe(0);
      const result = runner === "omo" ? await run(alias, ["task"], task) : await run(alias, ["task", task]);
      expect(result).toEqual({ code: 0, out: folder + "\n" + task + "\n", err: "" });
      if (runner === "codex") {
        const truncated = await run(folder, ["task", "partial"]);
        expect(truncated).toEqual({ code: 1, out: "", err: "Ein: codex returned no final reply.\n" });
      }
      const failed = await run(folder, ["task", "fail"]);
      expect(failed.code).toBe(1);
      expect(failed.out).toBe("");
    }
    writeFileSync(join(bin, "omo"), "#!/nonexistent/worker-interpreter\n");
    const broken = await run(folder, ["task", "work"]);
    expect(broken.code).toBe(1);
    expect(broken.out).toBe("");
    expect((await run(alias, ["orchestration", "disable"])).code).toBe(0);
    expect((await run(folder, ["task", "work"])).err).toContain("ein orchestration enable");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("interrupting Ein terminates its running worker", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ein-task-cancel-")));
  const env = { PATH: root, HOME: root, EIN_HOME: join(root, "ein"), EIN_CONFIG: join(root, "absent") };
  try {
    writeFileSync(join(root, "claude"), `#!${process.execPath}
process.on("SIGTERM", () => process.exit(42));
console.error("READY",process.pid);
setInterval(() => {}, 1000);
`, { mode: 0o700 });
    const setup = Bun.spawnSync([process.execPath, cli, "orchestration", "enable", "claude"], { cwd: root, env });
    expect(setup.exitCode).toBe(0);
    const proc = Bun.spawn([process.execPath, cli, "task", "wait"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 4000,
    });
    const reader = proc.stderr.getReader();
    const chunk = await reader.read();
    const match = /READY (\d+)/.exec(new TextDecoder().decode(chunk.value));
    expect(match).toBeTruthy();
    const pid = Number(match?.[1]);
    proc.kill("SIGINT");
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
