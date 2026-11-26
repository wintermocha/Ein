import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findCodexSession } from "../src/herdr-codex-index";

const label = "ein-owned-session";
let folder: string;
let project: string;
let database: string;
let index: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "ein-codex-index-"));
  project = join(folder, "project");
  mkdirSync(project);
  database = join(folder, "state_5.sqlite");
  index = join(folder, "session_index.jsonl");
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

function addThread(id: string, title = label, cwd = project) {
  using db = new Database(database);
  db.exec("CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY, title TEXT COLLATE NOCASE, cwd TEXT)");
  db.query("INSERT INTO threads VALUES (?,?,?)").run(id, title, cwd);
}

function name(id: string, thread_name = label) {
  appendFileSync(index, JSON.stringify({ id, thread_name }) + "\n");
}

test("the same UUID and exact label in both indexes identify the canonical working directory", () => {
  const id = crypto.randomUUID();
  const rival = crypto.randomUUID();
  const alias = join(folder, "project-link");
  symlinkSync(project, alias);
  addThread(rival, label.toUpperCase());
  name(rival, label.toUpperCase());
  addThread(id, label, alias);
  name(id);
  name(id);
  expect(findCodexSession(folder, label, project)).toBe(id);
  expect(findCodexSession(folder, label, folder)).toBeUndefined();
  writeFileSync(join(folder, "state_6.sqlite"), "");
  expect(findCodexSession(folder, label, project)).toBeUndefined();
});

test("two distinct UUIDs with the same name in either source prevent resume", () => {
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  addThread(first);
  name(first);
  name(second);
  expect(findCodexSession(folder, label, project)).toBeUndefined();
  writeFileSync(index, "");
  name(first);
  addThread(second);
  expect(findCodexSession(folder, label, project)).toBeUndefined();
});

test("a mismatched UUID, truncated index or unknown database schema never identifies a session", () => {
  const id = crypto.randomUUID();
  name(id);
  addThread(crypto.randomUUID());
  expect(findCodexSession(folder, label, project)).toBeUndefined();

  using db = new Database(database);
  db.exec("DELETE FROM threads");
  db.query("INSERT INTO threads VALUES (?,?,?)").run(id, label, project);
  appendFileSync(index, '{"thread_');
  expect(findCodexSession(folder, label, project)).toBeUndefined();

  writeFileSync(index, "");
  name(id);
  db.exec("DROP TABLE threads");
  expect(findCodexSession(folder, label, project)).toBeUndefined();
});

test("uninitialized profiles and incomplete naming metadata do not create a database", () => {
  expect(findCodexSession(folder, label, project)).toBeUndefined();
  name(crypto.randomUUID());
  expect(findCodexSession(folder, label, project)).toBeUndefined();
  expect(existsSync(database)).toBe(false);
});
