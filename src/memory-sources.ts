import { constants } from "node:fs";
import { access, lstat, open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import { readAgy } from "./memory-source-agy";
import { readClaude } from "./memory-source-claude";
import { readCodex } from "./memory-source-codex";
import { redactCredentials } from "./redaction";

export type ToolName = "codex" | "claude" | "agy";
export type SourceItem = {
  readonly tool: ToolName;
  readonly kind: "memory" | "conversation";
  readonly folder?: string;
  readonly source: string;
  readonly body: string;
  readonly title?: string;
  readonly suggestedScope?: "global" | "group" | "project";
};

export const userHome = () => process.env.HOME || homedir();
export const codexHome = () => process.env.CODEX_HOME || join(userHome(), ".codex");
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(userHome(), ".claude");

export function absoluteFolder(value: unknown) {
  return typeof value === "string" && isAbsolute(value) && !value.includes("\0") ? normalize(value) : undefined;
}

function unavailable(error: unknown) {
  return error instanceof Error && "code" in error &&
    ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENXIO", "EINVAL"].includes(String(error.code));
}

export async function sourceEntries(dir: string) {
  try {
    if (!(await lstat(dir)).isDirectory()) return [];
    return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if (unavailable(error)) return [];
    throw error;
  }
}

async function sourceFile(path: string) {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if ((await file.stat()).isFile()) return file;
    } catch (error) {
      await file.close();
      throw error;
    }
    await file.close();
  } catch (error) {
    if (!unavailable(error)) throw error;
  }
}

export async function sourceText(path: string) {
  const file = await sourceFile(path);
  if (!file) return "";
  try { return await file.readFile("utf8"); }
  finally { await file.close(); }
}

const record = z.record(z.string(), z.unknown());
export function sourceJson(text: string): Record<string, unknown> {
  try { return record.safeParse(JSON.parse(text)).data ?? {}; }
  catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function* sourceRows(path: string) {
  const file = await sourceFile(path);
  if (!file) return;
  const stream = file.createReadStream({ autoClose: false });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let line = 0;
  try {
    for await (const text of lines) yield { row: sourceJson(text), line: ++line };
  } finally {
    lines.close();
    stream.destroy();
    await file.close();
  }
}

export async function* sourceFiles(dir: string, extension: string, recursive: boolean | ((name: string) => boolean) = false): AsyncGenerator<string> {
  for (const entry of await sourceEntries(dir)) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(extension)) yield path;
    if (entry.isDirectory() && (typeof recursive === "function" ? recursive(entry.name) : recursive)) yield* sourceFiles(path, extension, recursive);
  }
}

const privateContent = [
  /\0|\[REDACTED[^\]]*\]|<redacted>|-----BEGIN [\w ]*PRIVATE KEY-----/i,
  /\b(?:sk-[\w-]{15,}|gh[pousr]_[\w]{16,}|github_pat_[\w]+|AKIA[A-Z0-9]{16}|AIza[\w-]{32,})/,
  /(?:\b|_)(?:password|passwd|passphrase|secret|api[_ -]?key|(?:access[_ -]?)?token)["']?\s*[:=]\s*["']?[^\s"']+/i,
  /\b(?:password|passphrase|api key|access token|secret key)\s+is\s+\S+|(?:비밀번호|패스워드|API\s*키|토큰)(?:은|는|이|가)\s+\S+/i,
  /\bBasic\s+[a-z0-9+/]{8,}={0,2}\b|\b[a-z]+:\/\/[^\s/@:]+:[^\s/@]+@/i,
];

export function safeSourceText(body: string) {
  return !!body.trim() && redactCredentials(body) === body && !privateContent.some(pattern => pattern.test(body));
}

export function userText(body: unknown): string | undefined {
  if (typeof body !== "string") return;
  const text = body.trim();
  if (!safeSourceText(text) || /<(?:environment_context|system-reminder|local-command-(?:caveat|stdout)|command-name|turn_aborted|user_instructions|permissions instructions|subagent_notification|task-notification)\b|^# AGENTS\.md instructions for |^This session is being continued from a previous conversation/i.test(text)) return;
  return text;
}

export function memoryItem(base: Omit<SourceItem, "kind" | "title" | "body">, text: string): SourceItem[] {
  const body = text.trim();
  if (!safeSourceText(body)) return [];
  const title = /^name:\s*(.+)$/im.exec(body)?.[1]?.trim() || /^#{1,3}\s+(.+)$/m.exec(body)?.[1]?.trim() || basename(base.source, ".md");
  return [{ ...base, kind: "memory", title, body }];
}

export async function discoverTools() {
  const gemini = join(userHome(), ".gemini");
  const roots = ["antigravity", "antigravity-ide", "antigravity-cli"];
  const indicators: Record<ToolName, readonly string[]> = {
    codex: ["AGENTS.md", "AGENTS.override.md", "memories", "memories_v2", "sessions", "archived_sessions", "history.jsonl", "state_5.sqlite", "thread_history_1.sqlite", "config.toml"].map(n => join(codexHome(), n)),
    claude: ["CLAUDE.md", "projects", "history.jsonl", "settings.json", "rules"].map(n => join(claudeHome(), n)),
    agy: [join(gemini, "GEMINI.md"), join(gemini, "AGENTS.md"), ...["AGENTS.md", "GEMINI.md", "rules", "skills"].map(n => join(gemini, "config", n)), ...roots.flatMap(r => ["conversation_summaries.db", "conversations", "knowledge", "rules"].map(n => join(gemini, r, n)))],
  };
  const apps: Record<ToolName, readonly string[]> = {
    codex: ["/Applications/Codex.app", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"], claude: [join(userHome(), ".local/bin/claude")],
    agy: ["/Applications/Antigravity IDE.app", "/Applications/Antigravity.app", join(userHome(), "Applications/Antigravity.app"), join(gemini, "bin/agy")],
  };
  return Promise.all((["codex", "claude", "agy"] as const).map(async tool => ({
    tool, installed: Boolean(Bun.which(tool)) || (await Promise.all(apps[tool].map(path => access(path, constants.X_OK).then(() => true, () => false)))).some(Boolean),
    data: (await Promise.all(indicators[tool].map(path => lstat(path).then(s => s.isDirectory() || s.isFile(), () => false)))).some(Boolean),
  })));
}

export async function readTool(tool: ToolName, folders: readonly string[]): Promise<SourceItem[]> {
  const read = { claude: readClaude, codex: readCodex, agy: readAgy }[tool];
  const seen = new Set<string>();
  return (await read(folders)).filter(item => {
    if (!safeSourceText(item.body) || !safeSourceText(item.source) || (item.title && !safeSourceText(item.title))) return false;
    const key = JSON.stringify([item.kind, item.folder, item.suggestedScope, item.folder || item.suggestedScope ? "" : item.source.split("#")[0], item.body]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
