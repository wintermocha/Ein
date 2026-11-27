import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, sessionModel } from "../src/config";

const minimum = { team: "TTEST", appId: "ATEST", botUser: "UBOT", ownerUser: "UOWNER", watchChannels: [] };
let folder: string;
let configFile: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ein-config-"));
  configFile = join(folder, "config.json");
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function config(extra: Record<string, unknown> = {}) {
  writeFileSync(configFile, JSON.stringify({ ...minimum, ...extra }));
  return loadConfig(configFile);
}

function preflight() {
  const child = Bun.spawnSync([
    process.execPath, "--no-env-file", "-e",
    'import {loadConfig,requireOrchestration} from "./src/config";' +
    'try { console.log(requireOrchestration(loadConfig(process.argv[1]))) }' +
    'catch(e) { console.error(e.message); process.exitCode=1 }',
    configFile,
  ], { env: { PATH: folder } });
  return { code: child.exitCode, out: child.stdout.toString().trim(), err: child.stderr.toString().trim() };
}

function installFake(name: string) {
  writeFileSync(join(folder, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
}

test("receiver-only configs require no runner or projects", () => {
  const result = config();
  expect(result.runner).toBeUndefined();
  expect(result.projects).toEqual({});
  expect(preflight().err).toContain("runner");
});

test("each host uses its configured model or its own default", () => {
  const { models } = config({ models: { claude: "opus[1m]", omo: "provider/custom-model" } });
  expect(sessionModel("claude", models)).toBe("opus[1m]");
  expect(sessionModel("omo", models)).toBe("provider/custom-model");
  expect(sessionModel("codex", models)).toBe("gpt-6.2-astra");
  expect(sessionModel("agy", models)).toBe("gemini-4-carbon");
  expect(sessionModel("claude", config().models)).toBe("claude-opus-5-5");
  expect(sessionModel("omo", config().models)).toBeUndefined();
});

test("rejects unknown hosts and invalid model selectors", () => {
  for (const models of [null, [], { unknown: "opus" }, { claude: "" }, { codex: "a b" }, { agy: "--effort" }]) {
    expect(() => config({ models })).toThrow("models");
  }
});

test.each(["omo", "claude", "codex"])("accepts the global %s runner without executing it", runner => {
  installFake("herdr");
  installFake(runner);
  const result = config({ runner, projects: { docs: { path: "." }, app: { path: "~/code", channels: ["CAPP"] } } });
  expect(result.projects.docs).toEqual({ path: folder, channels: [] });
  expect(result.projects.app?.path).toBe(join(homedir(), "code"));
  config({ runner, projects: { docs: { path: "." } } });
  expect(preflight()).toEqual({ code: 0, out: runner, err: "" });
});

test("reports invalid runner and disallows project and role overrides", () => {
  expect(() => config({ runner: "private-invalid-value" })).toThrow("runner");
  expect(() => config({ mainRunner: "claude" })).toThrow("Invalid config");
  expect(() => config({ projects: { app: { path: ".", runner: "omo" } } })).toThrow("projects");
});

test("rejects empty or absent paths, invalid aliases, and private-message channel IDs", () => {
  for (const projects of [
    { app: {} }, { app: { path: "" } }, { "../app": { path: "." } },
    { "two words": { path: "." } }, { app: { path: ".", channels: ["DDM"] } },
    { constructor: { path: "." } }, { ["__proto__"]: { path: "." } },
  ]) expect(() => config({ projects })).toThrow("projects");
});

test("each dedicated channel can select only one project", () => {
  const project = { path: ".", channels: ["CAPP"] };
  expect(() => config({ projects: { app: project, docs: project } })).toThrow("projects");
});

test("preflight checks project directories without exposing a private path", () => {
  installFake("herdr");
  installFake("omo");
  config({ runner: "omo", projects: { docs: { path: "private-marker" } } });
  const absent = preflight();
  expect(absent.code).toBe(1);
  expect(absent.err).toContain("projects");
  expect(absent.err).not.toContain("private-marker");
  writeFileSync(join(folder, "private-marker"), "not a directory");
  expect(preflight().code).toBe(1);
  mkdirSync(join(folder, "repo"));
  config({ runner: "omo", projects: { docs: { path: "repo" } } });
  expect(preflight().code).toBe(0);
});

test("preflight reports the selected missing binary without using an alternative", () => {
  config({ runner: "claude" });
  installFake("omo");
  installFake("herdr");
  expect(preflight().err).toContain("claude");
  rmSync(join(folder, "herdr"));
  installFake("claude");
  expect(preflight().err).toContain("herdr");
});
