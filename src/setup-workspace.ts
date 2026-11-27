import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { SetupError } from "./config";
import { herdrEnvironment } from "./herdr-environment";
import { AmbiguousWorkspaceError, HerdrRunner } from "./runners";

export function workspaceGuide(label: string): string {
  return `작업 과정을 보려면 터미널에서 아래 명령을 실행한 뒤 작업공간 목록에서 ‘${label}’을 여세요.\nherdr session attach ein`;
}

const serverStatus = z.object({ session: z.literal("ein"), status: z.string(), running: z.boolean() });

export async function prepareSetupWorkspace(label: string, signal: AbortSignal): Promise<string> {
  const env = herdrEnvironment();
  const executable = Bun.which("herdr", { PATH: env.PATH ?? "" });
  if (!executable) return "Herdr 작업공간 준비를 보류했습니다. Herdr를 설치하고 ein 세션을 시작하면 첫 오케스트레이션 작업에서 준비합니다.";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  const command = [executable, "--session", "ein"];
  async function status() {
    const child = Bun.spawn([...command, "status", "server", "--json"], {
      env, stdin: "ignore", stdout: "pipe", stderr: "ignore", signal: deadline,
    });
    const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    if (code !== 0) throw new SetupError("Herdr 서버 상태를 확인하지 못했습니다.");
    return serverStatus.parse(JSON.parse(output));
  }
  try {
    const current = await status();
    if (!current.running && current.status === "not_running") {
      const server = Bun.spawn([...command, "server"], {
        env, cwd: homedir(), detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore",
      });
      server.unref();
      while (!(await status()).running) {
        if (server.exitCode !== null) throw new SetupError("Herdr 서버가 종료됐습니다.");
        await delay(100, undefined, { signal: deadline });
      }
    }
    await new HerdrRunner({ workspaceLabel: label, env }).ensureWorkspace(homedir(), deadline);
    return `Herdr 작업공간 ${label} 준비 완료.`;
  } catch (error) {
    if (error instanceof AmbiguousWorkspaceError)
      return `herdr에 ‘${label}’ 워크스페이스가 여러 개 있습니다. 사용할 공간만 이 이름을 유지하도록 나머지 이름을 변경하세요.`;
    if (!(error instanceof Error)) throw error;
    return "Herdr 작업공간 준비를 보류했습니다. ein 세션을 확인하고 오케스트레이션을 시작하면 첫 작업에서 다시 준비합니다.";
  }
}
