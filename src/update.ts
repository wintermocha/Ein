import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { einCommand } from "./cli-invocation";
import { SetupError } from "./config";
import { snifferEnvironment } from "./sniffer";

const releases = "https://github.com/wintermocha/Ein/releases";
const releaseTag = /^main-([1-9][0-9]*)-[0-9a-f]{7}$/;
const curlOptions = ["--disable", "--fail", "--silent", "--show-error", "--proto", "=https",
  "--proto-redir", "=https", "--connect-timeout", "10", "--max-time", "45", "--retry", "2"];

function installedTag(home: string): string {
  try {
    return readFileSync(join(home, "release-tag"), "utf8").trimEnd();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "unversioned";
    throw new SetupError("설치된 Ein 버전을 읽을 수 없습니다. 설치 폴더의 접근 권한을 확인하세요.");
  }
}

function runNumber(tag: string): bigint {
  const number = releaseTag.exec(tag)?.[1];
  if (!number) throw new SetupError("Ein 릴리스 태그 형식을 확인할 수 없습니다.");
  return BigInt(number);
}

export function update(args: string[]): void {
  if (args.length) throw new SetupError(`Usage: ${einCommand} update`);
  const home = snifferEnvironment().EIN_HOME;
  if (!existsSync(join(home, "bin", "ein"))) {
    throw new SetupError(`설치된 Ein을 찾을 수 없습니다. 설치 경로를 확인하세요 (${home}).`);
  }
  const current = installedTag(home);
  const currentRun = current === "unversioned" || current === "source" ? undefined : runNumber(current);
  const redirect = spawnSync("curl", [...curlOptions, "--head", "--output", "/dev/null",
    "--write-out", "%{redirect_url}", releases + "/latest"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  const prefix = releases + "/tag/";
  if (redirect.status !== 0 || !redirect.stdout.startsWith(prefix)) {
    throw new SetupError("GitHub에서 최신 Ein 릴리스를 확인할 수 없습니다.");
  }
  const latest = redirect.stdout.slice(prefix.length).trimEnd();
  const latestRun = runNumber(latest);
  if (currentRun !== undefined && latestRun <= currentRun) {
    console.log(current === latest ? `이미 최신 버전입니다 (${current}).` :
      `새 버전이 없습니다 (설치 ${current}, 최신 릴리스 ${latest}).`);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "ein-update-"));
  try {
    const installer = join(scratch, "install-release.sh");
    const download = spawnSync("curl", [...curlOptions, "--location", "--output", installer,
      `${releases}/download/${latest}/install-release.sh`], { stdio: "inherit" });
    if (download.status !== 0) throw new SetupError(`Ein ${latest} 설치기를 내려받지 못했습니다.`);
    console.log(`Ein ${latest} 버전으로 업데이트합니다.`);
    const install = spawnSync("/bin/sh", [installer, "--update"], {
      env: { ...process.env, EIN_HOME: home, EIN_UPDATE_FROM: current, EIN_UPDATE_TO: latest },
      stdio: "inherit",
    });
    if (install.status !== 0) throw new SetupError(`Ein ${latest} 업데이트를 완료하지 못했습니다.`);
    console.log(`Ein ${latest} 업데이트를 완료했습니다.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
