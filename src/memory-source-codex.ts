import { Database, SQLiteError } from "bun:sqlite";
import { pathToFileURL } from "node:url";
import { basename, dirname, join, relative } from "node:path";
import { z } from "zod";
import {
  absoluteFolder, codexHome, memoryItem, sourceEntries, sourceFiles, sourceJson, sourceRows, sourceText, userText, type SourceItem,
} from "./memory-sources";

const payloadType = z.record(z.string(), z.unknown());
const inputParts = z.array(z.object({ type: z.string(), text: z.string().optional() }));
const scope = (folder?: string) => folder ? { folder, suggestedScope: "project" as const } : {};

async function sessionMessages(file: string, sessions: Map<string, string>, roots: Set<string>) {
  let folder: string | undefined;
  let session: string | undefined;
  const events: SourceItem[] = [];
  const messages: SourceItem[] = [];
  let hasEvents = false;
  for await (const { row, line } of sourceRows(file)) {
    const payload = payloadType.safeParse(row.payload).data;
    if (!payload) continue;
    if (row.type === "session_meta" || row.type === "turn_context") {
      if (row.type === "session_meta") {
        // Subagent prompts are written by their parent agent.
        if (payload.source === "subagent" || (payload.source && typeof payload.source === "object" && "subagent" in payload.source)) return [];
        if (typeof payload.id === "string") session = payload.id;
      }
      folder = absoluteFolder(payload.cwd) ?? folder ?? (session && sessions.get(session));
      if (folder) {
        roots.add(folder);
        if (session) sessions.set(session, folder);
      }
      continue;
    }
    const event = row.type === "event_msg" && payload.type === "user_message";
    const response = row.type === "response_item" && payload.type === "message" && payload.role === "user";
    if (event && !hasEvents) {
      hasEvents = true;
      messages.length = 0;
    }
    if (!event && (!response || hasEvents)) continue;
    const text = event ? payload.message :
      inputParts.safeParse(payload.content).data?.filter(p => p.type === "input_text").map(p => p.text).join("\n");
    const body = userText(text);
    if (body) (event ? events : messages).push({ tool: "codex", kind: "conversation", ...(folder && { folder }), source: file + "#" + line, body });
  }
  return hasEvents ? events : messages;
}

function memoryFolder(text: string) {
  const paths = new Set<string>();
  for (const match of text.matchAll(/(?:^\s*(?:[-*]\s*)?(?:cwd|working_directory|working directory)\s*[:=]\s*(.+?)\s*$|\(cwd=(.*?)(?:,\s*(?:rollout_path|updated_at|thread_id)=|\)\s*$))/gim)) {
    const path = absoluteFolder((match[1] ?? match[2])?.replace(/^[`"']|[`"']$/g, ""));
    if (path) paths.add(path);
  }
  return paths.size === 1 ? [...paths][0] : undefined;
}

async function codexMemories(dir: string, roots: Set<string>) {
  const items: SourceItem[] = [];
  const handbooks = new Map<string, string>();
  for await (const source of sourceFiles(dir, ".md", name => name !== "extensions" && name !== "memories_extensions")) {
    const name = relative(dir, source);
    if (name.split("/").includes("skills") && basename(source) !== "SKILL.md") continue;
    const memoryRoot = name.includes("rollout_summaries/") ? source.split("/rollout_summaries/")[0] : dirname(source);
    const canonicalPath = join(memoryRoot || dir, "MEMORY.md");
    let canonical = handbooks.get(canonicalPath);
    if (canonical === undefined) {
      canonical = await sourceText(canonicalPath);
      handbooks.set(canonicalPath, canonical);
    }
    if (basename(source) === "raw_memories.md" && canonical.trim()) continue;
    if (name.includes("rollout_summaries/") && canonical.includes("rollout_summaries/" + basename(source))) continue;
    let text = source === canonicalPath ? canonical : await sourceText(source);
    if (basename(source) === "memory_summary.md") text = text.split(/^##\s+What.s in Memory\s*$/im)[0] ?? "";
    const blocks = text.split(/(?=^# Task Group:|^## Thread\s)/m);
    for (const [index, block] of blocks.entries()) {
      if (!block.split("\n").some(line => line.trim() && !/^\s*(?:#|v1\s*$)/.test(line))) continue;
      const folder = memoryFolder(block);
      if (folder) roots.add(folder);
      items.push(...memoryItem({ tool: "codex", source: blocks.length > 1 ? source + "#" + (index + 1) : source, ...scope(folder) }, block));
    }
  }
  return items;
}

async function indexedSessions(home: string, roots: Set<string>) {
  const sessions = new Map<string, string>();
  const names = (await sourceEntries(home)).filter(entry => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .map(entry => entry.name).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  const database = names[0];
  if (!database) return sessions;
  try {
    using db = new Database(pathToFileURL(join(home, database)).href + "?immutable=1", { readonly: true });
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_roots'").get()) {
      for (const row of db.query<{ path: unknown }, []>("SELECT path FROM project_roots").iterate()) {
        const path = absoluteFolder(row.path);
        if (path) roots.add(path);
      }
    }
    for (const row of db.query<{ id: unknown; cwd: unknown; source: unknown }, []>("SELECT id, cwd, source FROM threads").iterate()) {
      if (typeof row.source === "string" && row.source.includes("subagent")) continue;
      const folder = absoluteFolder(row.cwd);
      if (!folder || typeof row.id !== "string") continue;
      sessions.set(row.id, folder);
      roots.add(folder);
    }
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error;
    // Rollouts still provide cwd when an older or partially written database cannot be queried.
  }
  return sessions;
}

async function indexedTurns(home: string, sessions: ReadonlyMap<string, string>) {
  const output: SourceItem[] = [];
  const path = join(home, "thread_history_1.sqlite");
  if (!sessions.size || !(await sourceEntries(home)).some(entry => entry.isFile() && entry.name === basename(path))) return output;
  try {
    using db = new Database(pathToFileURL(path).href + "?immutable=1", { readonly: true });
    const turns = db.query<{ thread_id: string; turn_id: string; item_json: string }, []>(`
      SELECT t.thread_id, t.turn_id, i.item_json FROM thread_turns t JOIN thread_items i
        ON i.thread_id = t.thread_id AND i.item_id = t.first_user_item_id AND i.turn_id = t.turn_id`);
    for (const row of turns.iterate()) {
      const folder = sessions.get(row.thread_id);
      if (!folder || typeof row.item_json !== "string") continue;
      const item = sourceJson(row.item_json);
      if (item.type !== "userMessage") continue;
      const parts = inputParts.safeParse(item.content).data;
      const body = userText(parts?.filter(p => p.type === "text").map(p => p.text).join("\n"));
      if (body) output.push({ tool: "codex", kind: "conversation", folder, source: path + "#" + row.thread_id + "/" + row.turn_id, body });
    }
  } catch (error) {
    if (!(error instanceof SQLiteError)) throw error;
  }
  return output;
}

export async function readCodex(folders: readonly string[]): Promise<SourceItem[]> {
  const home = codexHome();
  const roots = new Set(folders.filter(path => absoluteFolder(path)));
  let items: SourceItem[] = [];
  const config = await sourceText(join(home, "config.toml"));
  if (config) {
    try {
      const projects = z.object({ projects: z.record(z.string(), z.unknown()).optional() }).safeParse(Bun.TOML.parse(config)).data?.projects;
      for (const path of Object.keys(projects ?? {})) {
        const folder = absoluteFolder(path);
        if (folder) roots.add(folder);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // A malformed TOML file need not hide readable sessions and memories.
    }
  }
  const sessions = await indexedSessions(home, roots);
  for (const root of ["sessions", "archived_sessions"]) {
    for await (const file of sourceFiles(join(home, root), ".jsonl", true))
      for (const item of await sessionMessages(file, sessions, roots)) items.push(item);
  }
  items = items.concat(await indexedTurns(home, sessions));
  const history = join(home, "history.jsonl");
  for await (const { row, line } of sourceRows(history)) {
    const folder = absoluteFolder(row.cwd) ?? (typeof row.session_id === "string" ? sessions.get(row.session_id) : undefined);
    const body = userText(row.text);
    if (folder) roots.add(folder);
    if (body) items.push({ tool: "codex", kind: "conversation", ...(folder && { folder }), source: history + "#" + line, body });
  }
  for (const name of ["memories", "memories_v2"]) items = items.concat(await codexMemories(join(home, name), roots));
  for (const folder of new Set([home, ...roots])) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"]) {
      const source = join(folder, name);
      const body = await sourceText(source);
      if (!body.trim()) continue;
      const target = folder === home ? { suggestedScope: "global" as const } : scope(folder);
      items.push(...memoryItem({ tool: "codex", source, ...target }, body));
      break;
    }
  }
  return items;
}
