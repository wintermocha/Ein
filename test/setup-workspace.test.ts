import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prepare = 'import {prepareSetupWorkspace} from "./src/setup-workspace"; console.log(await prepareSetupWorkspace("Ein-ATEST", new AbortController().signal));';

async function provision(env: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", prepare], { env, stdout: "pipe", stderr: "inherit" });
  const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(code).toBe(0);
  return out;
}

test("an unavailable Herdr server defers the workspace to the first orchestration job", async () => {
  const folder = mkdtempSync("/tmp/ein-offline-");
  try {
    writeFileSync(join(folder, "herdr"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect(await provision({ HOME: folder, PATH: folder })).toContain("첫 작업");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const installed = Bun.which("herdr");
test.skipIf(!installed)("onboarding starts an isolated Herdr session and reuses its named workspace on retry", async () => {
  if (!installed) throw new Error("This integration requires Herdr");
  const folder = mkdtempSync("/tmp/ein-setup-");
  const bin = join(folder, "bin");
  mkdirSync(bin);
  symlinkSync(installed, join(bin, "herdr"));
  const env = { HOME: folder, XDG_CONFIG_HOME: join(folder, ".config"), XDG_RUNTIME_DIR: folder,
    XDG_DATA_HOME: join(folder, "data"), XDG_STATE_HOME: join(folder, "state"), PATH: bin + ":/usr/bin:/bin", SHELL: "/bin/sh" };
  const command = (...args: string[]) => Bun.spawnSync([installed, "--session", "ein", ...args], { env });
  try {
    expect(JSON.parse(command("status", "server", "--json").stdout.toString()).running).toBe(false);
    const contaminated = { ...env, HERDR_SOCKET_PATH: join(folder, "other.sock"), HERDR_SESSION: "other" };
    expect(await provision(contaminated)).toContain("준비 완료");
    expect(await provision(contaminated)).toContain("준비 완료");
    const list = command("workspace", "list");
    expect(list.exitCode).toBe(0);
    const { result } = JSON.parse(list.stdout.toString());
    expect(result.workspaces.filter((workspace: { label: string }) => workspace.label === "Ein-ATEST")).toHaveLength(1);
    expect(command("workspace", "create", "--label", "Ein-ATEST", "--no-focus").exitCode).toBe(0);
    expect(await provision(contaminated)).toContain("이름을 변경하세요");
  } finally {
    command("server", "stop");
    rmSync(folder, { recursive: true, force: true });
  }
}, 25_000);
