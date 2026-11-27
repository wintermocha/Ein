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
import {writeFileSync} from "node:fs";
const [,,first,second,...args]=process.argv.slice(2);
const f=process.env.QA_DIR;
let result;
if(first==="api")result={snapshot:{workspaces:[{workspace_id:"w1",label:"Ein"}],tabs:[],panes:[],agents:[]}};
else if(first==="tab"){writeFileSync(f+"/label",args[args.indexOf("--label")+1]);result={root_pane:{pane_id:"w1:p2"}}}
else if(second==="process-info")result={process_info:{pane_id:"w1:p2",shell_pid:7,foreground_process_group_id:7,foreground_processes:[{pid:7,name:process.env.QA_OCCUPANT}]}};
else {writeFileSync(f+"/wrong-launch","sent");process.exit(1)}
console.log(JSON.stringify({result}));
`, { mode: 0o700 });
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

function runner(occupant: string) {
  return new HerdrRunner({ stateDir, env: { PATH: folder, QA_DIR: folder, QA_OCCUPANT: occupant } });
}
const signal = () => AbortSignal.timeout(5_000);

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
