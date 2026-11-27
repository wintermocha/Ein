import { Database } from "bun:sqlite";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { absoluteFolder, memoryItem, sourceEntries, sourceFiles, sourceRows, sourceText, userHome, userText, type SourceItem } from "./memory-sources";

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function workspace(uri: unknown): string | undefined {
  if (typeof uri !== "string") return undefined;
  try { return absoluteFolder(uri.startsWith("file:") ? fileURLToPath(uri) : uri); }
  catch { return undefined; }
}

const record = z.record(z.string(), z.unknown());
const textBlock = z.object({type: z.literal("text"), text: z.string()});

function exportedMessages(raw: unknown, path: string, output: SourceItem[], folder?: string, ref = ""): void {
  if (Array.isArray(raw)) {
    raw.forEach((row, i) => exportedMessages(row, path, output, folder, ref + "/" + i));
    return;
  }
  const row = record.safeParse(raw).data;
  if (!row) return;
  folder = workspace(row.cwd ?? row.workspaceUri ?? row.workspace_uri) ?? folder;
  if (Array.isArray(row.messages) && !row.role && !row.event) {
    exportedMessages(row.messages, path, output, folder, ref + "/messages");
    return;
  }
  const message = record.safeParse(row.message).data;
  const roles = [row.role, row.event, row.type, message?.role].filter(role => role !== undefined);
  if (!roles.length || !roles.every(role => role === "user")) return;
  const content = message?.content ?? row.content ?? row.text;
  const body = Array.isArray(content)
    ? content.flatMap(block => textBlock.safeParse(block).data?.text ?? []).join("\n")
    : content;
  const input = userText(body);
  if (input) output.push({
    tool: "agy", kind: "conversation", body: input, source: path + "#" + ref, ...(folder && { folder })
  });
}

const indexedTurn = z.object({
  conversation_id: z.string(), chunk_index: z.number(), user_body: z.string(),
  user_step_byte_offsets: z.union([z.string(), z.instanceof(Uint8Array), z.null()])
});
const offsetsSchema = z.array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]));

async function readIndex(path: string, output: SourceItem[], workspaces: Map<string, string>): Promise<void> {
  if (!(await lstat(path).catch(() => undefined))?.isFile()) return;
  try {
    // Immutable opens the saved snapshot without creating journal or shared-memory files.
    using db = new Database(pathToFileURL(path).href + "?immutable=1", { readonly: true });
    for (const raw of db.query<{workspace_uris: unknown; conversation_id: unknown}, []>("SELECT conversation_id, workspace_uris FROM conversation_summaries").iterate()) {
      const uris = typeof raw.workspace_uris === "string" ? parseJson(raw.workspace_uris) : undefined;
      const folder = Array.isArray(uris) && uris.length === 1 ? workspace(uris[0]) : undefined;
      if (typeof raw.conversation_id === "string" && folder) workspaces.set(raw.conversation_id, folder);
    }
    const query = db.query(`SELECT f.conversation_id, f.chunk_index, f.user_body, f.user_step_byte_offsets
      FROM conversations_fts f
      WHERE length(f.user_body) > 0 ORDER BY f.conversation_id, f.chunk_index`);
    for (const raw of query.iterate()) {
      const r = indexedTurn.safeParse(raw).data;
      if (!r) continue;
      const folder = workspaces.get(r.conversation_id);
      const index = typeof r.user_step_byte_offsets === "string" ? r.user_step_byte_offsets
        : Buffer.from(r.user_step_byte_offsets ?? []).toString("utf8");
      const offsets = offsetsSchema.safeParse(parseJson(index)).data;
      const bytes = Buffer.from(r.user_body);
      if (!offsets?.length || offsets[0]?.[1] !== 0 ||
        offsets.some(([, pos], i) => pos >= bytes.length || (i > 0 && pos <= (offsets[i-1]?.[1] ?? 0)))) continue;
      for (const [i, [step, start]] of offsets.entries()) {
        const body = userText(bytes.subarray(start, offsets[i + 1]?.[1]).toString("utf8"));
        if (body) output.push({ tool: "agy", kind: "conversation", body, source: path + "#" + r.conversation_id + "/step/" + step, ...(folder && { folder }) });
      }
    }
  } catch {
    // Some versions store only previews or encrypted trajectories without a user text index.
  }
}

export async function readAgy(folders: readonly string[]): Promise<SourceItem[]> {
  const output: SourceItem[] = [];
  const gemini = join(userHome(), ".gemini");
  async function memory(path: string, folder?: string, global = false): Promise<void> {
    const metadata = { tool: "agy", source: path, ...(folder && { folder }), ...(global && { suggestedScope: "global" as const }) } as const;
    output.push(...memoryItem(metadata, await sourceText(path)));
  }
  async function skills(dir: string, folder?: string): Promise<void> {
    for await (const path of sourceFiles(dir, ".md", true)) {
      if (basename(path) === "SKILL.md") await memory(path, folder);
    }
  }
  const roots = new Set(folders.filter(folder => absoluteFolder(folder)));
  const config = join(gemini, "config");
  for (const dir of [gemini, config]) {
    for (const name of ["GEMINI.md", "AGENTS.md"]) await memory(join(dir, name), undefined, true);
  }
  for await (const path of sourceFiles(join(config, "rules"), ".md", true)) await memory(path, undefined, true);
  await skills(join(config, "skills"));
  for (const name of ["antigravity", "antigravity-cli", "antigravity-ide"]) {
    const profile = join(gemini, name);
    for (const dir of ["rules", "knowledge"]) {
      for await (const path of sourceFiles(join(profile, dir), ".md", true)) await memory(path, undefined, dir === "rules");
    }
    const workspaces = new Map<string, string>();
    await readIndex(join(profile, "conversation_summaries.db"), output, workspaces);
    for (const folder of workspaces.values()) roots.add(folder);
    const brain = join(profile, "brain");
    for (const entry of await sourceEntries(brain)) {
      if (!entry.isDirectory()) continue;
      const logs = join(brain, entry.name, ".system_generated", "logs");
      const folder = workspaces.get(entry.name);
      const seen = new Set<string>();
      const paths = [join(logs, "transcript_full.jsonl"), join(logs, "transcript.jsonl")];
      for await (const path of sourceFiles(join(logs, "chunks", "transcript_full"), ".jsonl")) paths.push(path);
      for await (const path of sourceFiles(join(logs, "chunks", "transcript"), ".jsonl")) paths.push(path);
      for (const path of paths) {
        for await (const { row, line } of sourceRows(path)) {
          if (row.type !== "USER_INPUT" || row.source !== "USER_EXPLICIT") continue;
          const body = userText(row.content);
          if (!body || seen.has(body)) continue;
          seen.add(body);
          output.push({ tool: "agy", kind: "conversation", source: path + "#" + line, body, ...(folder && { folder }) });
        }
      }
    }
    const conversations = join(profile, "conversations");
    for await (const path of sourceFiles(conversations, ".json", true)) {
      exportedMessages(parseJson(await sourceText(path)), path, output);
    }
    for await (const path of sourceFiles(conversations, ".jsonl", true)) {
      for await (const { row, line } of sourceRows(path)) exportedMessages(row, path, output, undefined, "line/" + line);
    }
  }
  for (const item of output) if (item.folder) roots.add(item.folder);
  for (const folder of roots) {
    for (const dir of [folder, join(folder, ".agents")]) {
      for (const name of ["GEMINI.md", "AGENTS.md"]) await memory(join(dir, name), folder);
    }
    await skills(join(folder, ".agents", "skills"), folder);
    for (const name of [".agents", ".agent"]) {
      for await (const path of sourceFiles(join(folder, name, "rules"), ".md", true)) await memory(path, folder);
    }
  }
  return output;
}
