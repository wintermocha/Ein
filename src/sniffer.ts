import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SetupError } from "./config";
import type { ProjectMemoryEnvironment } from "./turn-contract";

export function snifferEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || homedir();
  const absolute = (path: string) => path === "~" ? home :
    path.startsWith("~/") ? join(home, path.slice(2)) : resolve(path);
  return {
    EIN_HOME: absolute(env.EIN_HOME || "~/.ein"),
    EIN_CONFIG: absolute(env.EIN_CONFIG || "~/.config/ein/config.json"),
  };
}

export function snifferPaneEnvironment(project?: ProjectMemoryEnvironment, env: NodeJS.ProcessEnv = process.env) {
  const binding = project ?? { ...snifferEnvironment(env),
    EIN_SNIFFER_EXPECT_PROJECT: "", EIN_SNIFFER_DELEGATION: "none" };
  // A long-lived herdr server may have started inside a different Sniffer run.
  return { ...binding, EIN_SNIFFER_BIN: join(binding.EIN_HOME, "bin", "sniffer"),
    EIN_SNIFFER_RUN_ID: "", EIN_SNIFFER_ENDPOINT: "", EIN_SNIFFER_TOKEN_FILE: "",
    EIN_SNIFFER_HOST: "", EIN_SNIFFER_PROJECT_ID: "", EIN_SNIFFER_ROLE: "" };
}

export function snifferTurnArgv(executable: string, binding: ProjectMemoryEnvironment): string[] {
  const env = snifferPaneEnvironment(binding);
  return ["/usr/bin/env", ...Object.entries(env).map(([key, value]) => key + "=" + value), executable];
}

export function runSniffer(args: string[]): never {
  const paths = snifferEnvironment();
  const binary = join(paths.EIN_HOME, "bin", "sniffer");
  if (!process.execve) throw new SetupError("This platform does not support the Sniffer launcher.");
  // Replace the launcher so interactive clients keep their terminal, signals and exit status.
  const { EIN_APP_TOKEN, EIN_BOT_TOKEN, HOGU_APP_TOKEN, HOGU_BOT_TOKEN, ...env } = process.env;
  try {
    return process.execve(binary, [binary, ...args], { ...env, ...paths });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new SetupError("Sniffer가 설치되어 있지 않습니다. Ein 배포 패키지의 install.sh를 실행하세요.");
    }
    throw error;
  }
}
