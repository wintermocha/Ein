import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

function fixture() {
  const home = mkdtempSync("/tmp/ein-sources-");
  const env = { HOME: home, PATH: home, CODEX_HOME: join(home, "codex"), CLAUDE_CONFIG_DIR: join(home, "claude") };
  return {
    home, env,
    put(name: string, text: string) {
      const path = join(home, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    },
    run(command: string): unknown {
      const child = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
        'import {readTool,discoverTools} from "./src/memory-sources"; console.log(JSON.stringify(await ' + command + "));"], { env });
      expect(child.stderr.toString()).toBe("");
      expect(child.exitCode).toBe(0);
      return JSON.parse(child.stdout.toString());
    },
    [Symbol.dispose]() { rmSync(home, { recursive: true, force: true }); },
  };
}

const items = z.array(z.object({ body: z.string(), folder: z.string().optional(), title: z.string().optional(), source: z.string(), kind: z.string(), suggestedScope: z.string().optional() }));
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");

test("Codex recovers project and memory origins, keeps human turns once, and excludes assistant, tool and secret text", () => {
  using f = fixture();
  const cwd = join(f.home, "product");
  const other = join(f.home, "other");
  const prompt = "Please always use the release checklist.";
  const message = (role: string, text: string) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
  f.put("codex/sessions/2026/11/a.jsonl", jsonl({ type: "session_meta", payload: { cwd, id: "session" } },
    message("user", prompt), { type: "event_msg", payload: { type: "user_message", message: prompt } },
    message("assistant", "synthetic recommendation"), { type: "event_msg", payload: { type: "user_message", message: "api_key: secret_example" } }));
  f.put("codex/archived_sessions/b.jsonl", "broken\n" + jsonl(message("user", "<environment_context>synthetic</environment_context>"), message("user", "Use two spaces.")));
  f.put("codex/history.jsonl", jsonl({ session_id: "session", text: prompt }));
  f.put("codex/config.toml", "[projects." + JSON.stringify(other) + ']\ntrust_level="trusted"');
  f.put("other/AGENTS.md", "Run the smoke test.");
  f.put("codex/AGENTS.md", "Prefer brief responses.");
  f.put("codex/memories/MEMORY.md", "# Task Group: Packaging\n\n- rollout_summaries/a.md (cwd=" + cwd + ", rollout_path=/tmp/a)\n- Stage the checksums.");
  f.put("codex/memories/rollout_summaries/a.md", "duplicate lower-level summary");
  f.put("codex/memories/extensions/computer-history/resources/desktop.md", "Unrelated desktop information");
  f.put("codex/memories/raw_memories.md", "raw stage-one material");
  f.put("codex/sessions/child.jsonl", jsonl({ type: "session_meta", payload: { cwd, source: { subagent: "review" } } },
    message("user", "Parent-authored delegated review")));
  f.put("codex/state_5.sqlite", "corrupt binary");
  f.put("codex/history.jsonl", jsonl({ session_id: "session", text: prompt }, { text: "My password is hunter2" }));
  f.put("codex/memories_v2/ad_hoc_notes/unit.md", "# Isolated builds\nUse clean build directories.");
  const result = items.parse(f.run('readTool("codex",[])'));
  expect(result.filter(r => r.kind === "conversation").map(r => r.body).sort()).toEqual([prompt, "Use two spaces."].sort());
  expect(result.find(r => r.body === prompt)?.folder).toBe(cwd);
  expect(result.find(r => r.title === "Task Group: Packaging")?.folder).toBe(cwd);
  expect(result.find(r => r.title === "Isolated builds")?.suggestedScope).toBeUndefined();
  expect(result.filter(r => ["duplicate lower-level summary", "Unrelated desktop information", "raw stage-one material"].includes(r.body))).toHaveLength(0);
  expect(result.find(r => r.body === "Run the smoke test.")?.folder).toBe(other);
  expect(result.find(r => r.body === "Prefer brief responses.")?.suggestedScope).toBe("global");
});

test("Claude discovers indexed roots, preserves ambiguous origins, reads custom memory and excludes generated turns", () => {
  using f = fixture();
  const folder = join(f.home, "repo");
  const bucket = "claude/projects/-encoded/";
  const prompt = "Keep migrations reversible.";
  const message = (content: unknown, extra: object = {}) => ({ type: "user", cwd: folder, message: { role: "user", content }, ...extra });
  f.put(bucket + "sessions-index.json", JSON.stringify({ originalPath: folder, entries: [{ sessionId: "session", projectPath: folder }] }));
  f.put(bucket + "session.jsonl", jsonl(message([{ type: "text", text: prompt }]), message("sidechain", { isSidechain: true }),
    message([{ type: "tool_result", content: "tool text" }]), message("summary", { isCompactSummary: true }), message("generated", { isMeta: true }),
    message("private [REDACTED]")));
  f.put("claude/history.jsonl", jsonl({ project: folder, display: prompt }));
  f.put(bucket + "memory/MEMORY.md", "# Memory\n- [API](api.md) — lookup");
  f.put(bucket + "memory/api.md", "---\nname: REST contracts\n---\nCheck the API schema.");
  f.put("claude/projects/-no-metadata/memory/MEMORY.md", "# Unresolved\n- [Retired](removed.md) — Keep file names stable.");
  f.put("claude/projects/-no-metadata/memory/memo.md", "Remember to update the diagram.");
  f.put("repo/.claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: join(folder, "custom") }));
  f.put("repo/.claude/CLAUDE.md", "Use the local API fixture.");
  f.put("repo/custom/one.md", "Keep the old CLI interface.");
  const second = join(f.home, "second");
  f.put("claude/projects/-other/sessions-index.json", JSON.stringify({ originalPath: second }));
  f.put("second/.claude/settings.local.json", JSON.stringify({ autoMemoryDirectory: join(second, "external") }));
  f.put("unrelated/personal.md", "Unrelated directory");
  symlinkSync(join(f.home, "unrelated"), join(second, "external"));
  const result = items.parse(f.run('readTool("claude",[])'));
  expect(result.filter(r => r.kind === "conversation").map(r => [r.body, r.folder])).toEqual([[prompt, folder]]);
  expect(result.find(r => r.title === "REST contracts")?.folder).toBe(folder);
  expect(result.filter(r => r.source.endsWith("MEMORY.md")).map(r => r.body)).toEqual(["# Unresolved\n- [Retired](removed.md) — Keep file names stable."]);
  expect(result.some(r => r.body === "Unrelated directory")).toBe(false);
  expect(result.find(r => r.body === "Use the local API fixture.")?.folder).toBe(folder);
  expect(result.find(r => r.body === "Keep the old CLI interface.")?.folder).toBe(folder);
  const ambiguous = result.find(r => r.body === "Remember to update the diagram.");
  expect(ambiguous).toBeDefined();
  expect(ambiguous?.folder).toBeUndefined();
});

test("discovery reports selected tool profiles from independent local markers", () => {
  using f = fixture();
  f.put("codex/memories_v2/MEMORY.md", "# Preferences");
  f.put(".gemini/antigravity-ide/rules/settings.md", "Prefer compact output.");
  const discovered = z.array(z.object({ tool: z.string(), data: z.boolean() })).parse(f.run("discoverTools()"));
  expect(discovered.filter(item => item.data).map(item => item.tool).sort()).toEqual(["agy", "codex"]);
});

test("checkpointed Codex SQLite threads supply user turns and project metadata without creating sidecar files", () => {
  using f = fixture();
  const folder = join(f.home, "indexed-project");
  mkdirSync(f.env.CODEX_HOME);
  {
    using state = new Database(join(f.env.CODEX_HOME, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT, cwd TEXT, source TEXT); CREATE TABLE project_roots (path TEXT)");
    state.query("INSERT INTO threads VALUES (?,?,?)").run("user-id", folder, "cli");
    state.query("INSERT INTO threads VALUES (?,?,?)").run("worker-id", folder, '{"subagent":"review"}');
    state.query("INSERT INTO project_roots VALUES (?)").run(join(f.home, "empty-project"));
  }
  {
    using history = new Database(join(f.env.CODEX_HOME, "thread_history_1.sqlite"));
    history.exec("CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, first_user_item_id TEXT); CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, item_json TEXT)");
    for (const [id, text] of [["user-id", "Always preserve release tags."], ["worker-id", "Delegated prompt"]] as const) {
      history.query("INSERT INTO thread_turns VALUES (?,?,?)").run(id, "turn", "first");
      history.query("INSERT INTO thread_items VALUES (?,?,?,?)").run(id, "turn", "first", JSON.stringify({ type: "userMessage", content: [{ type: "text", text }] }));
    }
  }
  f.put("empty-project/AGENTS.md", "Keep existing database keys.");
  const before = readdirSync(f.env.CODEX_HOME);
  const result = items.parse(f.run('readTool("codex",[])'));
  expect(result.map(r => [r.body, r.folder]).sort()).toEqual([
    ["Always preserve release tags.", folder], ["Keep existing database keys.", join(f.home, "empty-project")],
  ]);
  expect(readdirSync(f.env.CODEX_HOME)).toEqual(before);
});
