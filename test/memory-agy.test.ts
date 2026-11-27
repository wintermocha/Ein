import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readAgy } from "../src/memory-source-agy";
import { prepareCandidates } from "../src/memory-candidates";

test("AGY imports explicit user turns from its index, native transcripts and exports without promoting assistant previews", async () => {
  const root = await mkdtemp(join(tmpdir(), "ein-agy-memory-"));
  const previous = process.env.HOME;
  process.env.HOME = root;
  try {
    const profile = join(root, ".gemini/antigravity-cli");
    const project = join(root, "example");
    const logs = join(profile, "brain/s1/.system_generated/logs");
    await Promise.all([project, logs, join(profile, "conversations")].map(path => mkdir(path, { recursive: true })));
    const path = join(profile, "conversation_summaries.db");
    const first = "앞으로는 커밋을 한국어로 써 줘.";
    const second = "I prefer explicit types.";
    {
      using db = new Database(path);
      db.exec("CREATE TABLE conversation_summaries (conversation_id, workspace_uris, preview)");
      db.exec("CREATE VIRTUAL TABLE conversations_fts USING fts5(conversation_id, chunk_index UNINDEXED, user_body, user_step_byte_offsets UNINDEXED, agent_body)");
      db.query("INSERT INTO conversation_summaries VALUES (?,?,?)").run("s1", JSON.stringify([pathToFileURL(project).href]), "Always use preview fiction.");
      db.query("INSERT INTO conversations_fts VALUES (?,?,?,?,?)").run("s1", 0, first + "\n" + second,
        Buffer.from(JSON.stringify([[0, 0], [4, Buffer.byteLength(first + "\n")]])), "Always use assistant fiction.");
    }
    const third = "By default, write small tests.";
    await writeFile(join(logs, "transcript.jsonl"), [
      { type: "USER_INPUT", source: "USER_EXPLICIT", content: third },
      { type: "USER_INPUT", source: "SYSTEM", content: "Always use injected fiction." },
      { type: "PLANNER_RESPONSE", source: "USER_EXPLICIT", content: "Always use planner fiction." },
    ].map(row => JSON.stringify(row)).join("\n"));
    const fourth = "Going forward, keep docs together.";
    await writeFile(join(profile, "conversations/export.json"), JSON.stringify({cwd: project, messages: [
      { role: "user", content: fourth }, { role: "assistant", content: "Always use export fiction." },
    ]}));
    await writeFile(join(project, "GEMINI.md"), "Build using Bun.");
    const config = join(root, ".gemini/config");
    const curated = [
      [config, "AGENTS.md"], [config, "GEMINI.md"], [config, "rules/style.md"], [config, "skills/learned/SKILL.md"],
      [project, ".agents/AGENTS.md"], [project, ".agents/GEMINI.md"], [project, ".agents/skills/build/SKILL.md"],
    ] as const;
    for (const [dir, file] of [...curated, [config, "skills/learned/reference.md"], [profile, "builtin/plugins/x/SKILL.md"]]) {
      const path = join(dir, file);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file);
    }
    const before = await readdir(profile);
    const candidates = prepareCandidates(await readAgy([]));
    expect(candidates.map(item => item.body).sort()).toEqual([first, second, third, fourth, "Build using Bun.", ...curated.map(([,file]) => file)].sort());
    expect(candidates.filter(item => !item.source.startsWith(config)).every(item => item.folder === project)).toBe(true);
    expect(candidates.find(item => item.body === ".agents/GEMINI.md")?.suggestedScope).toBeUndefined();
    expect(candidates.find(item => item.body === second)?.source).toEqual(path + "#s1/step/4");
    expect(await readdir(profile)).toEqual(before);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});
