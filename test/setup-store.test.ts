import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentials, loadConfig } from "../src/config";
import { SetupStore } from "../src/setup-store";

const owner = { team: "TWORK", botUser: "UBOT", ownerUser: "UOWNER", ownerDm: "DDM" };
const install = { appId: "AEIN", ...owner };
let folder: string;
let path: string;
let store: SetupStore;
let app: string | undefined;
let bot: string | undefined;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ein-setup-store-"));
  path = join(folder, "nested", "first.json");
  store = new SetupStore(path);
  app = process.env.EIN_APP_TOKEN;
  bot = process.env.EIN_BOT_TOKEN;
  delete process.env.EIN_APP_TOKEN;
  delete process.env.EIN_BOT_TOKEN;
});
afterEach(() => {
  if (app === undefined) delete process.env.EIN_APP_TOKEN;
  else process.env.EIN_APP_TOKEN = app;
  if (bot === undefined) delete process.env.EIN_BOT_TOKEN;
  else process.env.EIN_BOT_TOKEN = bot;
  rmSync(folder, { recursive: true, force: true });
});

test("fresh inspection leaves the config parent absent", () => {
  expect(store.configExists()).toBe(false);
  expect(store.read()).toEqual({});
  expect(store.getToken("bot")).toBeUndefined();
  expect(existsSync(join(folder, "nested"))).toBe(false);
});

test("resuming publishes a loadable config with private credentials and clears progress", () => {
  store.putToken("bot", "xoxb-fixture");
  const progress = { appId: "AEIN", owner, appTokenHash: "abcd0123".repeat(8) };
  store.save(progress);
  const resumed = new SetupStore(path);
  expect(resumed.read()).toEqual(progress);
  expect(resumed.getToken("bot")).toBe("xoxb-fixture");
  expect(resumed.getToken("app")).toBeUndefined();
  process.env.EIN_APP_TOKEN = "xapp-env_fixture.v1";
  expect(resumed.getToken("app")).toBe("xapp-env_fixture.v1");
  resumed.finish(install);
  const config = loadConfig(path);
  expect(config).toMatchObject({ ...install, watchChannels: [] });
  expect(credentials(config)).toEqual({ appToken: "xapp-env_fixture.v1", botToken: "xoxb-fixture" });
  expect(statSync(config.botTokenFile ?? "").mode & 0o777).toBe(0o600);
  expect(existsSync(config.appTokenFile ?? "")).toBe(false);
  expect(readFileSync(path, "utf8")).not.toContain("xoxb-");
  expect(readFileSync(path, "utf8")).not.toContain(progress.appTokenHash);
  expect(resumed.read()).toEqual({});
  process.env.EIN_BOT_TOKEN = "xoxb-override";
  expect(resumed.getToken("bot")).toBe("xoxb-override");
});

test("finish preserves existing hand-edited config and independent config paths remain isolated", () => {
  store.save({ appId: "AEIN" });
  const second = new SetupStore(join(folder, "nested", "second.json"));
  second.putToken("app", "xapp-other");
  expect(store.getToken("app")).toBeUndefined();
  writeFileSync(path, "manually edited");
  expect(() => store.finish(install)).toThrow("already exists");
  expect(readFileSync(path, "utf8")).toBe("manually edited");
});

test("rejects malformed input and linked credentials without exposing or changing their contents", () => {
  expect(() => store.save({ appTokenHash: "xapp-sensitive" })).toThrow("Invalid setup progress.");
  expect(() => store.save({ appId: "xapp-sensitive" })).toThrow("Invalid setup progress.");
  expect(() => store.putToken("bot", "xapp-sensitive")).toThrow("Expected a Slack bot token.");
  store.finish(install);
  const tokenPath = loadConfig(path).botTokenFile ?? "";
  const target = join(folder, "target");
  writeFileSync(target, "private-marker");
  symlinkSync(target, tokenPath);
  expect(() => store.putToken("bot", "xoxb-new")).toThrow("private regular file");
  expect(() => store.getToken("bot")).toThrow("Cannot open private setup file");
  expect(readFileSync(target, "utf8")).toBe("private-marker");
});

test("lock excludes another process and closes automatically on abrupt process exit", async () => {
  const child = Bun.spawn([process.execPath, "-e",
    'import {SetupStore} from "./src/setup-store"; const release = new SetupStore(process.argv[1]).lock(); console.log("locked"); setInterval(() => {}, 1000);',
    path], { stdout: "pipe", stderr: "inherit" });
  try {
    expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("locked");
    expect(() => store.lock()).toThrow("Another setup command");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
  }
  const release = store.lock();
  release();
});
