import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { SetupError } from "./config";
import { askSetup } from "./setup-prompt";
import { snifferEnvironment } from "./sniffer";

const slug = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const inspection = z.object({
  root: z.string(), folderId: z.string().regex(slug), projectId: z.string(),
  bound: z.boolean(), projects: z.array(z.string()), groups: z.array(z.string()),
});
export type FolderPlan = z.infer<typeof inspection> & { requestedGroup?: string; exact: boolean };

export function hasMemoryEngine(): boolean {
  return existsSync(join(snifferEnvironment().EIN_HOME, "bin", "sniffer"));
}

export function snifferJSON(args: string[], cwd = process.cwd(), input?: string): unknown {
  const env = snifferEnvironment();
  const result = spawnSync(join(env.EIN_HOME, "bin", "sniffer"), args, {
    cwd, env: { ...process.env, ...env }, encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw new SetupError(`기억 엔진을 실행할 수 없습니다. Ein 설치와 폴더를 확인하세요. (${result.error.message})`);
  if (result.status !== 0) throw new SetupError(result.stderr.trim() || "기억 엔진 명령이 중단됐습니다.");
  return JSON.parse(result.stdout);
}

export function directory(value: string): string | undefined {
  if (!value) return undefined;
  const path = value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : resolve(value);
  try {
    if (!statSync(path).isDirectory()) return undefined;
    const canonical = realpathSync(path);
    const engine = snifferEnvironment().EIN_HOME;
    const home = existsSync(engine) ? realpathSync(engine) : engine;
    if (canonical === sep || canonical === home || canonical.startsWith(home + sep) || home.startsWith(canonical + sep)) return undefined;
    return canonical;
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EACCES"].includes(String(error.code))) return undefined;
    throw error;
  }
}

function folderArgs(action: string, path: string, exact: boolean, project?: string, group?: string): string[] {
  return ["folder", action, "--path", path, ...(exact ? ["--exact"] : []),
    ...(project ? ["--project", project] : []), ...(group ? ["--group", group] : [])];
}

export function inspectFolder(path: string, exact: boolean, project?: string, group?: string): FolderPlan {
  return { ...inspection.parse(snifferJSON(folderArgs("inspect", path, exact, project, group))), exact };
}

export function bindFolder(plan: FolderPlan): void {
  const actual = inspection.parse(snifferJSON(folderArgs("bind", plan.root, plan.exact, plan.projectId, plan.requestedGroup)));
  if (actual.folderId !== plan.folderId || actual.projectId !== plan.projectId ||
      actual.groups.join("/") !== plan.groups.join("/")) {
    throw new SetupError("검토하는 동안 폴더의 연결이 바뀌었습니다. 범위를 다시 확인하세요.");
  }
}

export async function chooseProject(folder: FolderPlan, signal: AbortSignal, planned: ReadonlyMap<string, string | undefined>): Promise<FolderPlan> {
  if (folder.projectId) return folder;
  const projects = [...new Set([...folder.projects, ...planned.keys()])];
  console.log(`\n작업 폴더 ${folder.root}`);
  if (projects.length) console.log(`연결할 수 있는 프로젝트: ${projects.join(", ")}`);
  for (;;) {
    const value = await askSetup("기존 또는 새 프로젝트 ID를 입력하세요. [Enter: 폴더 전용 / 새 프로젝트@그룹]", signal);
    if (!value) return folder;
    const [project, group, ...extra] = value.split("@");
    if (!project || !slug.test(project) || extra.length || (group !== undefined && !slug.test(group))) {
      console.log("ID는 영문 소문자·숫자로 시작하고 소문자·숫자·하이픈·밑줄을 포함할 수 있습니다.");
      continue;
    }
    const parent = group ?? planned.get(project);
    if (planned.has(project) && parent !== planned.get(project)) {
      console.log("앞서 선택한 프로젝트의 그룹과 다릅니다.");
      continue;
    }
    try {
      const preview = inspectFolder(folder.root, folder.exact, project, parent);
      return parent ? { ...preview, requestedGroup: parent } : preview;
    } catch (error) {
      if (!(error instanceof SetupError)) throw error;
      console.log(error.message);
    }
  }
}

export async function connectFirstFolder(): Promise<void> {
  const signal = new AbortController().signal;
  let folder = inspectFolder(process.cwd(), false);
  if (folder.bound) return;
  if (!folder.projectId) {
    const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
    const root = git.status === 0 ? git.stdout.trim() : "";
    if (root && isAbsolute(root) && root !== folder.root) {
      const answer = await askSetup(`작업 폴더로 Git 루트 ${root}를 쓸까요? [Enter: 사용 / n: 현재 폴더]`, signal);
      if (!answer) folder = inspectFolder(root, false);
    }
  }
  bindFolder(await chooseProject(folder, signal, new Map()));
}
