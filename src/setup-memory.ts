import { createHash } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { SetupError } from "./config";
import { prepareCandidates } from "./memory-candidates";
import { discoverTools, readTool, type SourceItem } from "./memory-sources";
import { askSetup } from "./setup-prompt";
import { bindFolder, chooseProject, directory, inspectFolder, snifferJSON, type FolderPlan } from "./setup-folders";

type Row = { item: SourceItem; folder?: FolderPlan; scope: string };
const projectList = z.array(z.object({ roots: z.array(z.string()) }));
const listing = z.object({ memories: z.array(z.object({
  id: z.string(), scope_id: z.string(), revision: z.string(), body: z.string(), description: z.string(),
  key: z.string().optional(), aliases: z.array(z.string()).optional(), tags: z.array(z.string()).optional(), derived_from: z.unknown().optional(),
})) });

function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "");
}

// Leave room below Sniffer's 64 KiB body limit for the source reference.
function fitDocument(item: SourceItem): SourceItem[] {
  const bytes = Buffer.from(item.body.trim());
  const limit = 60 * 1024;
  if (bytes.length <= limit) return [item];
  const parts: string[] = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(start + limit, bytes.length);
    if (end < bytes.length) {
      const newline = bytes.lastIndexOf(10, end - 1);
      if (newline > start + limit / 2) end = newline + 1;
      else while ((bytes[end] ?? 0) >> 6 === 2) end--;
    }
    const part = bytes.subarray(start, end).toString("utf8").trim();
    if (part) parts.push(part);
    start = end;
  }
  return parts.map((body, index) => ({ ...item, body,
    title: `${item.title ?? basename(item.source)} (${index + 1}/${parts.length})`,
    source: item.source + "#part-" + (index + 1) }));
}

function scopes(folder?: FolderPlan): string[] {
  if (!folder) return ["global"];
  return [`folder:${folder.folderId}`, ...(folder.projectId ? [`project:${folder.projectId}`] : []),
    ...folder.groups.map(id => "group:" + id), "global"];
}

function destination(row: Row): string {
  return row.folder && row.scope === "folder:" + row.folder.folderId ? "폴더 " + row.folder.root : row.scope;
}

function proposedScope(item: SourceItem, folder: FolderPlan): string {
  if (item.suggestedScope === "global") return "global";
  if (item.suggestedScope === "group" && folder.groups[0]) return "group:" + folder.groups[0];
  if (item.kind === "conversation" && item.suggestedScope === "project" && folder.projectId) return "project:" + folder.projectId;
  return "folder:" + folder.folderId;
}

async function planRows(items: SourceItem[], signal: AbortSignal): Promise<Row[]> {
  const rows: Row[] = [];
  const folders = new Map<string, FolderPlan>();
  const projects = new Map<string, string | undefined>();
  const missing = new Map<string, string>();
  const canonical = new Map<string, string | undefined>();
  for (const item of items) {
    let path: string | undefined;
    if (item.folder && isAbsolute(item.folder)) {
      if (!canonical.has(item.folder)) canonical.set(item.folder, directory(item.folder));
      path = canonical.get(item.folder);
    }
    if (!path) {
      if (!item.folder && item.suggestedScope === "global") { rows.push({ item, scope: "global" }); continue; }
      const key = item.folder || item.source.split("#")[0] || item.source;
      if (!missing.has(key)) {
        console.log(`\n작업 폴더를 확인할 수 없습니다 · ${visible(key)}`);
        for (;;) {
          const answer = await askSetup("연결할 폴더 경로 [global: 전역 후보로 검토 / Enter: 건너뛰기]", signal);
          const mapped = !answer || answer === "global" ? answer : directory(answer);
          if (mapped !== undefined) { missing.set(key, mapped); break; }
          console.log("읽을 수 있는 폴더 경로를 입력하세요.");
        }
      }
      path = missing.get(key);
      if (!path) continue;
      if (path === "global") { rows.push({ item, scope: "global" }); continue; }
    }
    let folder = folders.get(path);
    if (!folder) {
      const found = inspectFolder(path, true);
      folder = folders.get(found.root) ?? await chooseProject(found, signal, projects);
      folders.set(path, folder);
      folders.set(folder.root, folder);
      if (folder.projectId) projects.set(folder.projectId, folder.requestedGroup);
    }
    rows.push({ item, folder, scope: proposedScope(item, folder) });
  }
  const recurring = new Map<string, Row[]>();
  for (const row of rows) {
    if (row.item.kind !== "conversation" || !row.folder?.groups.length || !row.scope.startsWith("folder:")) continue;
    const text = row.item.body.normalize("NFC").replace(/\s+/g, " ").trim();
    const matches = recurring.get(text) ?? [];
    matches.push(row);
    recurring.set(text, matches);
  }
  for (const matches of recurring.values()) {
    if (new Set(matches.map(row => row.folder?.projectId)).size < 2 ||
        new Set(matches.map(row => row.item.source.split("#")[0])).size < 2) continue;
    const shared = matches[0]?.folder?.groups.find(group => matches.every(row => row.folder?.groups.includes(group)));
    if (shared) for (const row of matches) row.scope = "group:" + shared;
  }
  return rows;
}

function numbers(answer: string, count: number): number[] | undefined {
  const values = answer.trim().split(/[\s,]+/);
  if (!values.every(v => /^[1-9]\d*$/.test(v) && Number(v) <= count)) return undefined;
  return [...new Set(values.map(v => Number(v) - 1))];
}

function display(row: Row, index: number, full: boolean): void {
  const body = visible(row.item.body);
  const entire = full || row.item.kind === "conversation" || !row.scope.startsWith("folder:");
  console.log(`\n[${index + 1}] ${row.item.kind === "memory" ? "기존 기억" : "대화에서 추출"} → ${visible(destination(row))}`);
  console.log(`    ${row.item.tool} · ${visible(row.item.source)}`);
  if (row.item.title) console.log(`    ${visible(row.item.title)}`);
  if (row.folder && !row.scope.startsWith("folder:")) console.log(`    원래 폴더 · ${visible(row.folder.root)}`);
  console.log((entire || body.length <= 240 ? body : body.slice(0, 240) + "…").split("\n").map(line => "    " + line).join("\n"));
}

async function review(rows: Row[], signal: AbortSignal): Promise<Row[]> {
  console.log("\n저장 전 일괄 검토");
  for (const folder of new Map(rows.flatMap(row => row.folder ? [[row.folder.root, row.folder] as const] : [])).values()) {
    console.log(`${visible(folder.root)} → ${folder.projectId || "폴더 전용"}${folder.groups.map(id => " · group:" + id).join("")}`);
  }
  rows.forEach((row, index) => display(row, index, false));
  console.log("\n범위를 바꾸려면 ‘범위 번호 대상’을 입력하세요. 대상은 folder, project, group:<ID>, global입니다.");
  for (;;) {
    const answer = await askSetup("저장할 번호, 전체, 전체 -제외번호, 기본(폴더의 기존 기억) +추가번호, 보기 번호, 또는 Enter로 취소:", signal);
    if (!answer) return [];
    if (answer === "전체") return rows;
    if (answer === "기본" || answer.startsWith("기본 +") || answer.startsWith("전체 -")) {
      const skip = answer.startsWith("전체 -");
      const indices = answer === "기본" ? [] : numbers(answer.slice(4), rows.length);
      if (!indices) { console.log("표에 있는 번호를 쉼표로 구분하세요."); continue; }
      return rows.filter((row, i) => skip ? !indices.includes(i) :
        indices.includes(i) || (row.item.kind === "memory" && row.scope.startsWith("folder:")));
    }
    const [cmd, number, target, ...rest] = answer.split(/\s+/);
    if (cmd === "보기" || cmd === "범위") {
      const row = rows[Number(number) - 1];
      if (!number || !/^[1-9]\d*$/.test(number) || !row || rest.length) { console.log("표에 있는 번호를 입력하세요."); continue; }
      if (cmd === "범위") {
        const options = scopes(row.folder);
        const scope = target === "folder" && row.folder ? "folder:" + row.folder.folderId :
          target === "project" && row.folder?.projectId ? "project:" + row.folder.projectId : target;
        if (!scope || !options.includes(scope)) { console.log("가능한 범위: " + options.join(", ")); continue; }
        row.scope = scope;
      }
      display(row, Number(number) - 1, true);
      continue;
    }
    const selected = numbers(answer, rows.length);
    if (selected) return rows.filter((_, index) => selected.includes(index));
    console.log("표에 있는 번호 또는 전체·기본을 입력하세요.");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function memoryDocument(row: Row) {
  const { item, scope } = row;
  const text = item.body.normalize("NFC").trim().replace(/\r\n/g, "\n");
  const id = "import-" + digest(JSON.stringify([row.folder?.folderId ?? "global", text]));
  const title = visible(item.title || text.split("\n").find(line => line.trim()) || basename(item.source)).trim();
  const description = Array.from(title).slice(0, 180).join("");
  const source = visible(item.source).replaceAll("\n", " ");
  const body = `${text}\n\n가져온 곳: ${item.tool} · ${source}`;
  if (Buffer.byteLength(body) > 65536) throw new SetupError(`기억의 저장 크기 한도를 넘었습니다: ${source}`);
  return { id, text, body: body.normalize("NFC"), description: description.normalize("NFC"),
    markdown: ["---", "schema_version: 1", "id: " + id, "scope_id: " + JSON.stringify(scope),
    "description: " + JSON.stringify(description), "---", body].join("\n") };
}

function save(rows: Row[], signal: AbortSignal): void {
  const documents = new Map<string, ReturnType<typeof memoryDocument> & { row: Row }>();
  for (const row of rows) {
    const doc = memoryDocument(row);
    const known = documents.get(doc.id);
    const chain = scopes(row.folder);
    if (!known || chain.indexOf(known.row.scope) < chain.indexOf(row.scope)) documents.set(doc.id, { row, ...doc });
  }
  const plans = new Map(rows.flatMap(row => row.folder ? [[row.folder.root, row.folder] as const] : []));
  let saved = 0;
  let skipped = 0;
  let conflicts = 0;
  try {
    for (const folder of [...plans.values()].sort((a, b) => b.root.length - a.root.length)) {
      signal.throwIfAborted();
      bindFolder(folder);
    }
    const known = new Map<string, z.infer<typeof listing>["memories"]>();
    const written = new Set<string>();
    for (const { row, id, text, markdown, body, description } of documents.values()) {
      signal.throwIfAborted();
      const cwd = row.folder?.root;
      const local = cwd ?? "";
      const globalFlag = cwd ? [] : ["--global"];
      let memories = known.get(local);
      if (!memories) {
        memories = listing.parse(snifferJSON(["memory", "list", ...globalFlag], cwd)).memories;
        known.set(local, memories);
      }
      const key = JSON.stringify([row.scope, text]);
      const prior = memories.find(m => m.id === id);
      if (written.has(key) || memories.some(m => m.scope_id === row.scope &&
          (m.id === id || m.body === text || m.body.startsWith(text + "\n\n가져온 곳: ")))) { skipped++; continue; }
      if (prior) {
        const order = scopes(row.folder);
        if (order.indexOf(row.scope) <= order.indexOf(prior.scope_id)) { skipped++; continue; }
        if (prior.body !== body || prior.description !== description || prior.key || prior.aliases?.length ||
            prior.tags?.length || prior.derived_from) {
          console.log(`아인에서 수정된 기억은 기존 범위에 유지했습니다: ${id}`);
          conflicts++;
          continue;
        }
        snifferJSON(["memory", "promote", "--id", id, "--to", row.scope, "--if-revision", prior.revision,
          "--request-id", "promote-" + digest(id + prior.revision + row.scope), "--apply"], cwd);
      } else {
        snifferJSON(["memory", "save", ...globalFlag, "--input", "-", "--if-revision", "new",
          "--request-id", "save-" + digest(markdown)], cwd, markdown);
      }
      written.add(key);
      saved++;
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new SetupError(`${saved}건 저장 후 중단됐습니다. 다시 검토해 이어갈 수 있습니다. ${error.message}`);
  }
  console.log(`기억 ${saved}건 저장 · 이미 저장된 기억 ${skipped}건${conflicts ? " · 수정 충돌 " + conflicts + "건" : ""}`);
}

export async function importMemory(extraFolders: string[], signal: AbortSignal): Promise<boolean> {
  const tools = await discoverTools();
  console.log("\n이 Mac에서 기억을 가져올 도구를 선택하세요.");
  tools.forEach((t, index) => console.log(`[${index + 1}] ${t.tool} · ${t.installed ? "설치 확인" : "실행 파일 미확인"} · ${t.data ? "자료 경로 발견" : "기본 자료 경로 없음"}`));
  let selection: number[] | undefined;
  while (!selection) {
    const answer = await askSetup("도구 번호(쉼표 구분) 또는 Enter로 건너뛰기:", signal);
    if (!answer) return false;
    selection = numbers(answer, tools.length);
  }
  const registered = projectList.parse(snifferJSON(["project", "list"])).flatMap(project => project.roots);
  const explicit = extraFolders.map(value => {
    const path = directory(value);
    if (!path) throw new SetupError(`작업 폴더를 찾을 수 없습니다: ${value}`);
    return path;
  });
  const cwd = directory(process.cwd());
  const folders = [...new Set([...registered, ...explicit, ...(cwd ? [cwd] : [])])];
  const selected = tools.filter((_, i) => selection.includes(i));
  const items = prepareCandidates((await Promise.all(selected.map(t => readTool(t.tool, folders)))).flat()).flatMap(fitDocument);
  const rows = await planRows(items, signal);
  if (!rows.length) { console.log("가져올 기억 후보가 없습니다."); return false; }
  const accepted = await review(rows, signal);
  if (!accepted.length) { console.log("저장한 기억이 없습니다."); return false; }
  save(accepted, signal);
  return true;
}
