import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  absoluteFolder, claudeHome, memoryItem, sourceEntries, sourceFiles, sourceJson, sourceRows, sourceText,
  userHome, userText, type SourceItem,
} from "./memory-sources";

const userMessage = z.object({
  role: z.literal("user"),
  content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]),
});
const entries = z.array(z.object({ projectPath: z.string().optional(), sessionId: z.string().optional() }));
const scope = (folder?: string) => folder ? { folder, suggestedScope: "project" as const } : {};

async function memoryDirectory(dir: string, folder?: string) {
  const items: SourceItem[] = [];
  const indexes: string[] = [];
  for await (const source of sourceFiles(dir, ".md", true)) {
    if (basename(source) === "MEMORY.md") indexes.push(source);
    else items.push(...memoryItem({ tool: "claude", source, ...scope(folder) }, await sourceText(source)));
  }
  const topics = new Set(items.map(item => item.source));
  for (const source of indexes) {
    const body = (await sourceText(source)).split("\n").filter(line => {
      const target = /^\s*[-*]?\s*\[[^\]]+\]\(([^)]+?\.md)(?:#[^)]*)?\)/.exec(line)?.[1];
      return !target || !topics.has(resolve(dirname(source), target));
    }).join("\n");
    if (body.split("\n").some(line => line.trim() && !/^\s*#/.test(line)))
      items.push(...memoryItem({ tool: "claude", source, ...scope(folder) }, body));
  }
  return items;
}

async function configuredMemory(file: string, folder?: string) {
  const value = sourceJson(await sourceText(file)).autoMemoryDirectory;
  if (typeof value !== "string") return;
  const path = value.startsWith("~/") ? join(userHome(), value.slice(2)) : absoluteFolder(value);
  if (!path) return;
  const dir = await realpath(path).catch(() => undefined);
  if (!dir || dir === "/" || dir === await realpath(userHome()).catch(() => userHome())) return;
  if (folder) {
    const root = await realpath(folder).catch(() => undefined);
    if (!root) return;
    const subpath = relative(root, dir);
    if (!subpath || subpath === ".." || subpath.startsWith("../") || isAbsolute(subpath)) return;
  }
  return dir;
}

export async function readClaude(folders: readonly string[]): Promise<SourceItem[]> {
  const home = claudeHome();
  const roots = new Set(folders.filter(path => absoluteFolder(path)));
  const items: SourceItem[] = [];
  const buckets: { dir: string; paths: Set<string>; original?: string }[] = [];
  const sessionFolders = new Map<string, string>();
  for (const entry of await sourceEntries(join(home, "projects"))) {
    if (!entry.isDirectory()) continue;
    const dir = join(home, "projects", entry.name);
    const paths = new Set<string>();
    const index = sourceJson(await sourceText(join(dir, "sessions-index.json")));
    const original = absoluteFolder(index.originalPath);
    if (original) roots.add(original);
    for (const row of entries.safeParse(index.entries).data ?? []) {
      const folder = absoluteFolder(row.projectPath);
      if (!folder) continue;
      paths.add(folder);
      roots.add(folder);
      if (row.sessionId) sessionFolders.set(row.sessionId, folder);
    }
    for await (const file of sourceFiles(dir, ".jsonl")) {
      const session = basename(file, ".jsonl");
      for await (const { row, line } of sourceRows(file)) {
        if (row.isSidechain === true || row.isMeta === true || row.isCompactSummary === true) continue;
        const cwd = absoluteFolder(row.cwd);
        if (cwd) {
          roots.add(cwd);
          paths.add(cwd);
          sessionFolders.set(session, cwd);
        }
        if (row.type !== "user" || row.toolUseResult || row.sourceToolAssistantUUID) continue;
        const message = userMessage.safeParse(row.message).data;
        if (!message || (Array.isArray(message.content) && message.content.some(part => part.type === "tool_result"))) continue;
        const content = typeof message.content === "string" ? message.content :
          message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
        const body = userText(content);
        const folder = cwd ?? sessionFolders.get(session) ?? original;
        if (body) items.push({ tool: "claude", kind: "conversation", ...(folder && { folder }), source: file + "#" + line, body });
      }
    }
    buckets.push({ dir, paths, ...(original && { original }) });
  }
  for await (const { row, line } of sourceRows(join(home, "history.jsonl"))) {
    const folder = absoluteFolder(row.project) ?? (typeof row.sessionId === "string" ? sessionFolders.get(row.sessionId) : undefined);
    if (folder) roots.add(folder);
    const body = userText(row.display);
    if (body && !/^\/\S|\[Pasted text #\d+/.test(body)) items.push({ tool: "claude", kind: "conversation", ...(folder && { folder }), source: join(home, "history.jsonl") + "#" + line, body });
  }
  for (const bucket of buckets) {
    const matches = [...roots].filter(folder => folder.replace(/[^a-zA-Z0-9]/g, "-") === basename(bucket.dir));
    const evidence = [...bucket.paths];
    const folder = bucket.original ?? (evidence.length === 1 ? evidence[0] : evidence.length === 0 && matches.length === 1 ? matches[0] : undefined);
    items.push(...await memoryDirectory(join(bucket.dir, "memory"), folder));
  }

  const global = { tool: "claude", suggestedScope: "global" } as const;
  const globalInstructions = join(home, "CLAUDE.md");
  items.push(...memoryItem({ ...global, source: globalInstructions }, await sourceText(globalInstructions)));
  for await (const source of sourceFiles(join(home, "rules"), ".md", true))
    items.push(...memoryItem({ ...global, source }, await sourceText(source)));

  const customDirs = new Map<string, Set<string>>();
  const defaultCustom = await configuredMemory(join(home, "settings.json"));
  if (defaultCustom) customDirs.set(defaultCustom, new Set());
  for (const folder of roots) {
    for (const file of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) {
      const source = join(folder, file);
      items.push(...memoryItem({ tool: "claude", source, ...scope(folder) }, await sourceText(source)));
    }
    for await (const source of sourceFiles(join(folder, ".claude/rules"), ".md", true))
      items.push(...memoryItem({ tool: "claude", source, ...scope(folder) }, await sourceText(source)));
    const custom = await configuredMemory(join(folder, ".claude/settings.local.json"), folder) ??
      await configuredMemory(join(folder, ".claude/settings.json"), folder);
    if (custom) {
      const owners = customDirs.get(custom) ?? new Set();
      owners.add(folder);
      customDirs.set(custom, owners);
    }
  }
  for (const [dir, owners] of customDirs)
    items.push(...await memoryDirectory(dir, dir !== defaultCustom && owners.size === 1 ? [...owners][0] : undefined));
  return items;
}
