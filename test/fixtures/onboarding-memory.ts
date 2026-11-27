// The package smoke test runs this against the installed executables.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const bin = process.argv[2] ?? "";
if (!bin) throw new Error("Pass the installed ein executable.");
const root = realpathSync(mkdtempSync(join(tmpdir(), "ein-import-")));
const api = join(root, "api");
const web = join(root, "web");
const claude = join(root, "claude-profile");
const codex = join(root, "codex-profile");
const env = { ...process.env, HOME: root, EIN_HOME: process.env.EIN_HOME, EIN_CONFIG: join(root, "config.json"),
  CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex };
const note = "Use the folder-specific UI test runner.";
const team = "Our team always checks signed receipts before approving a refund.";
const global = "Across all projects, always write release notes in Korean.";
const rejected = "I prefer verbose timing logs for warm starts.";

function cli(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([bin, ...args], { cwd, env });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  return result.stdout.toString();
}

async function interact(cwd: string, args: string[], run: (wait: (prompt: string) => Promise<string>, enter: (answer: string) => void) => Promise<void>) {
  let output = "";
  const decoder = new TextDecoder();
  await using terminal = new Bun.Terminal({ data(_terminal, bytes) { output += decoder.decode(bytes, { stream: true }); } });
  const child = Bun.spawn([bin, ...args], { cwd, env, terminal, timeout: 45_000 });
  let offset = 0;
  try {
    await run(async prompt => {
      const deadline = Date.now() + 20_000;
      while (output.indexOf(prompt, offset) < 0 && child.exitCode === null && Date.now() < deadline) await Bun.sleep(10);
      const end = output.indexOf(prompt, offset);
      assert.ok(end >= 0, `Missing ${prompt}\n${output}`);
      const text = output.slice(offset, end);
      offset = end + prompt.length;
      return text;
    }, answer => terminal.write(answer + "\r"));
    assert.equal(await child.exited, 0, output);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}

try {
  for (const [folder, text] of [[api, "The API uses a local fixture server."], [web, note]] as const) {
    mkdirSync(folder);
    const bucket = join(claude, "projects", folder === api ? "api" : "web");
    mkdirSync(join(bucket, "memory"), { recursive: true });
    writeFileSync(join(bucket, "sessions-index.json"), JSON.stringify({ originalPath: folder }));
    writeFileSync(join(bucket, "memory", "workflow.md"), text);
    if (folder === api) writeFileSync(join(bucket, "session.jsonl"), [team, global, rejected].map(content =>
      JSON.stringify({ type: "user", cwd: api, message: { role: "user", content } })).join("\n"));
  }
  mkdirSync(codex);
  writeFileSync(join(codex, "AGENTS.md"), "Unselected Codex marker");
  for (const action of ["cancel", "save", "repeat"]) {
    await interact(root, action === "save" ? ["setup"] : ["setup", "--memory"], async (wait, enter) => {
      await wait("Enter로 건너뛰기:"); enter("2");
      if (action !== "repeat") {
        await wait("새 프로젝트@그룹]"); enter("shop@commerce");
        await wait("새 프로젝트@그룹]"); enter("shop");
      }
      const preview = await wait("Enter로 취소:");
      assert.ok(!preview.includes("Unselected Codex marker"));
      const skipped = /\[(\d+)\][^\n]*\n(?:(?!\[\d+\])[\s\S])*?verbose timing logs/.exec(preview)?.[1];
      assert.ok(skipped);
      assert.ok(preview.includes("group:commerce") && preview.includes("→ global"));
      if (action !== "repeat") {
        assert.deepEqual(JSON.parse(cli(root, "project", "list")), []);
        assert.deepEqual(JSON.parse(cli(root, "memory", "list", "--global")).memories, []);
      }
      if (action === "cancel") {
        enter("");
        return;
      }
      enter("전체 -" + skipped);
      await wait(action === "save" ? "기억 4건 저장" : "기억 0건 저장");
      if (action === "save") { await wait("Slack 연결도 이어서 할까요?"); enter(""); }
    });
  }
  const local = cli(web, "memory", "list");
  const sibling = cli(api, "memory", "list");
  assert.ok(local.includes(note) && !sibling.includes(note));
  assert.ok(!local.includes("local fixture server") && sibling.includes("local fixture server"));
  assert.ok(local.includes(team) && sibling.includes(team));
  assert.ok(local.includes(global) && cli(root, "memory", "list", "--global").includes(global));
  assert.ok(!local.includes(rejected) && !sibling.includes(rejected));
  const newFolder = join(root, "mobile");
  mkdirSync(newFolder);
  const input = join(root, "local-note.md");
  writeFileSync(input, "---\nschema_version: 1\nid: local-simulator\nscope_id: folder:current\ndescription: simulator\n---\nUse the local device.\n");
  await interact(newFolder, ["memory", "save", "--input", input, "--if-revision", "new", "--request-id", "simulator"], async (wait, enter) => {
    await wait("새 프로젝트@그룹]"); enter("");
  });
  cli(newFolder, "folder", "bind", "--path", newFolder, "--project", "shop");
  assert.ok(cli(newFolder, "memory", "list").includes("local-simulator"));
  assert.ok(!cli(web, "memory", "list").includes("local-simulator"));
  console.log("PASS: onboarding cancellation, selected sources, folder isolation, reviewed group/global memories, repeat import and first save.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
