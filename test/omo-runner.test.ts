import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrRunner, type SessionRef } from "../src/runners";

let folder: string;
let stateDir: string;
let ref: SessionRef;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ein-omo-launch-"));
  stateDir = join(folder, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  ref = { runner: "omo", id: crypto.randomUUID(), cwd: folder };
  writeFileSync(join(folder, "omo"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  writeFileSync(join(folder, "herdr"), `#!${process.execPath}
import {existsSync,writeFileSync} from "node:fs";
const [,,first,second,...args]=process.argv.slice(2);
const f=process.env.QA_DIR;
let result;
if(first==="api")result={snapshot:{workspaces:[{workspace_id:"w1",label:"Ein"}],tabs:[],panes:[],agents:[]}};
else if(first==="tab"){writeFileSync(f+"/label",args[args.indexOf("--label")+1]);result={root_pane:{pane_id:existsSync(f+"/launches")?"w1:p3":"w1:p2"}}}
else if(second==="process-info")result={process_info:{pane_id:args[args.indexOf("--pane")+1],shell_pid:7,foreground_process_group_id:7,foreground_processes:[{pid:7,name:process.env.QA_OCCUPANT}]}};
else if(first==="pane" && second==="run" && process.env.QA_LAUNCH) {
  const bridge = Bun.spawn(["/bin/sh", "-c", args[1]], { cwd: f, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  bridge.unref();
  process.exit(0);
}
else {writeFileSync(f+"/wrong-launch","sent");process.exit(1)}
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function runner(occupant: string, launch = false, model?: string) {
  return new HerdrRunner({ stateDir, models: model ? { omo: model } : undefined,
    env: { PATH: folder, QA_DIR: folder, QA_OCCUPANT: occupant, QA_LAUNCH: launch ? "1" : "" } });
}
const signal = () => AbortSignal.timeout(5_000);

test.each([
  { source: "host settings" }, { source: "Ein config", model: "fixture/provider-model" },
])("starts OMO using $source and preserves its model on cold resume", async ({ model }) => {
  const nativeId = crypto.randomUUID();
  writeFileSync(join(folder, "omo"), `#!${process.execPath}
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
appendFileSync("launches", JSON.stringify({ pid: process.pid, args }) + "\\n");
if (!existsSync(args[3])) writeFileSync(args[3], JSON.stringify({ type: "session", id: "${nativeId}", cwd: process.cwd() }));
for await (const line of createInterface({ input: process.stdin })) {
  const { id } = JSON.parse(line);
  const data = { sessionFile: args[3], sessionId: "${nativeId}", isStreaming: false, isCompacting: false };
  console.log(JSON.stringify({ type: "response", id, success: true, data }));
}
`, { mode: 0o700 });
  const launches = join(folder, "launches");
  const recorded = (): { pid: number; args: string[] }[] =>
    readFileSync(launches, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  try {
    const started = await runner("zsh", true, model).ensure(ref, signal(), () => {});
    expect(started.nativeId).toBe(nativeId);
    const resumed = await runner("zsh", true, "fixture/changed-model").ensure(started, signal(), () => {});
    expect(resumed.nativeId).toBe(nativeId);
    expect(resumed.paneId).not.toBe(started.paneId);
    const sessionFile = join(stateDir, readFileSync(join(folder, "label"), "utf8") + ".jsonl");
    const rpc = ["--mode", "rpc", "--session", sessionFile];
    expect(recorded().map(launch => launch.args)).toEqual([
      model ? [...rpc, "--model", model] : rpc, rpc,
    ]);
  } finally {
    if (existsSync(launches)) for (const { pid } of recorded()) process.kill(pid);
  }
});

test("OMO will not type its bridge command into a non-shell foreground process", async () => {
  const updates: SessionRef[] = [];
  await expect(runner("vim").ensure(ref, signal(), current => updates.push(current))).rejects.toThrow("idle shell");
  expect(updates.map(s => s.paneId)).toEqual(["w1:p2"]);
  expect(existsSync(join(folder, "wrong-launch"))).toBe(false);
});

test("losing a pane never opens an empty or foreign OMO session under its filename", async () => {
  const missing = { ...ref, paneId: "w1:p1", nativeId: crypto.randomUUID() };
  await expect(runner("zsh").ensure(missing, signal(), () => {})).rejects.toThrow("file is missing");
  const filename = readFileSync(join(folder, "label"), "utf8") + ".jsonl";
  writeFileSync(join(stateDir, filename), JSON.stringify({ type: "session", id: crypto.randomUUID(), cwd: folder }) + "\n");
  await expect(runner("zsh").ensure(missing, signal(), () => {})).rejects.toThrow("identity changed");
  expect(existsSync(join(folder, "wrong-launch"))).toBe(false);
});
