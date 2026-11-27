import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrRunner, type SessionRef } from "../src/runners";

// Only the herdr process boundary is simulated. Check the pane, native launch and accepted
// input as a CLI consumer sees them, including a pane disappearing between deliveries.
const herdr = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
const state = process.env.FAKE_STATE;
const data = JSON.parse(readFileSync(state, "utf8"));
const [flag, namespace, group, action, ...args] = process.argv.slice(2);
if (flag !== "--session" || namespace !== process.env.EXPECT_NAMESPACE) throw Error("Unexpected server");
if (process.env.EIN_APP_TOKEN || process.env.EIN_BOT_TOKEN || process.env.HOGU_APP_TOKEN ||
    process.env.HOGU_BOT_TOKEN || process.env.HERDR_SOCKET_PATH) throw Error("Inherited receiver context");
const option = name => args[args.indexOf(name) + 1];
const command = group + " " + action;
let result;
switch (command) {
  case "api snapshot":
    if (process.env.PEER && !existsSync(state + "." + process.env.PEER)) {
      writeFileSync(state + "." + process.env.PEER, "");
      const other = process.env.PEER === "a" ? "b" : "a";
      while (!existsSync(state + "." + other)) await Bun.sleep(10);
    }
    result = { snapshot: { workspaces: data.workspaces, tabs: data.tabs, panes: data.panes, agents: data.agents } };
    break;
  case "workspace create":
    appendFileSync(state + ".creates", option("--label") + "\n");
    data.workspaces.push({ workspace_id: "created-" + data.workspaces.length, label: option("--label") });
    result = { workspace: data.workspaces.at(-1) };
    break;
  case "tab create": {
    if (!data.workspaces.some(w => w.workspace_id === option("--workspace"))) throw Error("Missing workspace");
    const number = ++data.sequence;
    const tab = { tab_id: "t" + number, workspace_id: option("--workspace"), label: option("--label") };
    const pane = { pane_id: "p" + number, tab_id: tab.tab_id, cwd: option("--cwd") };
    const env = { ...process.env };
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "--env") continue;
      const assignment = args[++i];
      const split = assignment.indexOf("=");
      env[assignment.slice(0, split)] = assignment.slice(split + 1);
    }
    data.memory = [env.EIN_SNIFFER_DELEGATION, env.EIN_SNIFFER_EXPECT_PROJECT, env.EIN_HOME, env.EIN_CONFIG, env.EIN_SNIFFER_ENDPOINT, env.EIN_SNIFFER_TOKEN_FILE];
    data.tabs.push(tab); data.panes.push(pane);
    result = { root_pane: pane, tab };
    break;
  }
  case "agent start": {
    const kind = option("--kind"), target = option("--pane");
    if (!data.panes.some(pane => pane.pane_id === target)) throw Error("No such pane");
    const agent = { name: args[0], pane_id: target, agent: kind, agent_status: "idle", interactive_ready: true,
      reportsNativeId: !(data.suppressResumeReport && args.includes("resume")) };
    data.agents.push(agent);
    data.launches.push({ kind, target, nativeArgs: args.includes("--") ? args.slice(args.indexOf("--") + 1) : [] });
    result = { agent };
    break;
  }
  case "agent get": {
    const agent = data.agents.find(agent => agent.pane_id === args[0]);
    if (!agent) throw Error("No agent");
    const agent_status = data.busyReads > 0 ? "working" : data.status;
    if (data.busyReads > 0) data.busyReads--;
    result = { agent: { ...agent, agent_status, agent_session: agent.reportsNativeId && data.nativeId ? { agent: agent.agent, kind: "id", value: data.nativeId } : null } };
    if (data.replaceAfterGet) agent.name = "other-live-agent";
    break;
  }
  case "agent prompt": {
    if (args.length !== 2 || args[1].startsWith("-")) throw Error("herdr expects one literal prompt argument");
    // Herdr accepts both bare pane IDs and names; a replacement keeps only the old pane ID.
    const target = data.agents.find(agent => agent.name === args[0] || agent.pane_id === args[0]);
    if (!target) throw Error("No bound agent");
    data.messages.push([target.pane_id, args[1]]);
    if (args[1].startsWith("/rename ")) {
      if (target.agent !== "codex" || !data.renameNativeId) throw Error("Unexpected local rename");
      const pane = data.panes.find(pane => pane.pane_id === target.pane_id);
      const title = args[1].slice("/rename ".length);
      const db = new Database(join(process.env.CODEX_HOME, "state_5.sqlite"), { readwrite: true });
      db.query("INSERT INTO threads(id,title,cwd) VALUES(?,?,?)").run(data.renameNativeId, title, pane.cwd);
      db.close();
      appendFileSync(join(process.env.CODEX_HOME, "session_index.jsonl"),
        JSON.stringify({ id: data.renameNativeId, thread_name: title, updated_at: new Date().toISOString() }) + "\n");
    }
    break;
  }
  case "pane process-info":
    result = { process_info: { pane_id: option("--pane"), shell_pid: 7, foreground_process_group_id: 7,
      foreground_processes: [{ pid: 7, name: "zsh" }] } };
    break;
  case "pane run":
    data.paneRuns.push(args[1]);
    break;
  default: throw Error("Unexpected command: " + command);
}
if (command !== "api snapshot") writeFileSync(state, JSON.stringify(data));
if (result) console.log(JSON.stringify({ result }));
`;

type Data = {
  sequence: number; tabs: {tab_id: string; label: string; workspace_id: string}[];
  panes: {pane_id: string; tab_id: string; cwd: string}[];
  agents: {pane_id: string; name: string; agent: string; agent_status?: string;
    interactive_ready?: boolean; reportsNativeId?: boolean}[];
  launches: {kind: string; target: string; nativeArgs: string[]}[];
  replaceAfterGet?: boolean; renameNativeId?: string; suppressResumeReport?: boolean;
  workspaces: { workspace_id: string; label: string }[];
  memory?: string[];
  nativeId: string | null; busyReads: number; status: string; messages: string[][]; paneRuns: string[];
};
let dir: string;
let dataFile: string;
const nativeId = "03934533-6c50-4e61-a194-e386945a6841";
const signal = new AbortController().signal;
const nop = () => {};
function load(): Data { return JSON.parse(readFileSync(dataFile, "utf8")); }
function patch(fields: Partial<Data>) { writeFileSync(dataFile, JSON.stringify({ ...load(), ...fields })); }
type AdapterOptions = { readonly namespace?: string; readonly expectedNamespace?: string; readonly workspaceLabel?: string };
function adapter(installationId = "installation-a", options: AdapterOptions = { namespace: "runner-test" }) {
  const runnerOptions = { workspaceLabel: options.workspaceLabel, installationId, stateDir: dir, env: {
    PATH: dir, FAKE_STATE: dataFile, CODEX_HOME: join(dir, "codex-profile"),
    EIN_SNIFFER_DELEGATION: "assigned", EIN_SNIFFER_EXPECT_PROJECT: "previous",
    EIN_SNIFFER_ENDPOINT: "previous-endpoint", EIN_SNIFFER_TOKEN_FILE: "previous-token",
    EXPECT_NAMESPACE: options.expectedNamespace ?? options.namespace ?? "ein",
    HERDR_SOCKET_PATH: "/someone-elses-session", EIN_APP_TOKEN: "receiver-only",
    EIN_BOT_TOKEN: "receiver-only", HOGU_APP_TOKEN: "receiver-only", HOGU_BOT_TOKEN: "receiver-only",
  } };
  return options.namespace === undefined
    ? new HerdrRunner(runnerOptions)
    : new HerdrRunner({ ...runnerOptions, namespace: options.namespace });
}
function reservation(runner: "codex" | "claude" = "codex") {
  return { runner, id: "same-thread", cwd: join(dir, "project with spaces"), resultDir: join(dir, "turn results") } satisfies SessionRef;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ein-runner-test-"));
  mkdirSync(join(dir, "codex-profile"));
  mkdirSync(join(dir, "project with spaces"));
  mkdirSync(join(dir, "turn results"));
  dataFile = join(dir, "state.json");
  writeFileSync(dataFile, JSON.stringify({ sequence: 0, tabs: [], panes: [], agents: [], launches: [],
    nativeId, busyReads: 0, status: "idle", messages: [], workspaces: [{ workspace_id: "w1", label: "Ein" }], paneRuns: [] } satisfies Data));
  writeFileSync(join(dir, "herdr"), "#!" + process.execPath + "\n" + herdr, { mode: 0o700 });
  for (const runner of ["codex", "claude", "omo"])
    writeFileSync(join(dir, runner), "#!/bin/sh\nexit 98", { mode: 0o700 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a new reservation uses the Ein server, workspace and label without inherited Slack tokens", async () => {
  patch({ workspaces: [{ workspace_id: "unrelated", label: "Ein-other" }] });

  await adapter("installation-a", {}).ensure(reservation(), signal, nop);

  expect(load().workspaces.map(w => w.label)).toEqual(["Ein-other", "Ein"]);
  expect(load().tabs[0]?.workspace_id).toBe("created-1");
  expect(load().tabs[0]?.label).toMatch(/^ein-[0-9a-f]{26}$/u);
});

test("concurrent setup and reservations reuse exactly one named workspace and reject duplicate labels", async () => {
  const client = adapter("installation-a", { workspaceLabel: "Ein-A" });
  const program = `import { HerdrRunner } from "./src/runners";
    console.log(await new HerdrRunner({ workspaceLabel: "Ein-A" }).ensureWorkspace(process.cwd(), AbortSignal.timeout(4000)));`;
  const ids = await Promise.all(["a", "b"].map(async peer => {
    const child = Bun.spawn([process.execPath, "-e", program], {
      env: { PATH: dir, FAKE_STATE: dataFile, EXPECT_NAMESPACE: "ein", PEER: peer },
      stdout: "pipe", stderr: "inherit", timeout: 4500,
    });
    expect(await child.exited).toBe(0);
    return (await new Response(child.stdout).text()).trim();
  }));
  expect(ids).toEqual(["created-1", "created-1"]);
  expect(readFileSync(dataFile + ".creates", "utf8")).toBe("Ein-A\n");
  await client.ensure(reservation(), signal, nop);
  expect(load().tabs.map(tab => tab.workspace_id)).toEqual(["created-1"]);
  patch({ workspaces: [...load().workspaces, { workspace_id: "duplicate", label: "Ein-A" }] });
  await expect(client.ensure({ ...reservation(), id: "next" }, signal, nop)).rejects.toThrow("ambiguous workspace");
  expect(load().tabs).toHaveLength(1);
});

test("a project pane inherits the assigned binding and a neutral pane clears ambient authority", async () => {
  const runner = adapter();
  const binding = {
    EIN_HOME: join(dir, "custom home"), EIN_CONFIG: join(dir, "custom registry"),
    EIN_SNIFFER_EXPECT_PROJECT: "ein", EIN_SNIFFER_DELEGATION: "assigned",
  } as const;
  await runner.ensure(reservation(), signal, nop, binding);
  expect(load().memory).toEqual(["assigned", "ein", binding.EIN_HOME, binding.EIN_CONFIG, "", ""]);

  await runner.ensure({ ...reservation(), id: "neutral" }, signal, nop);
  expect(load().memory?.slice(0, 2)).toEqual(["none", ""]);
});

test("an exact persisted legacy ID resolves its prior namespace and label", async () => {
  const id = "hogu-" + "a".repeat(32);
  const label = "hogu-" + createHash("sha256")
    .update(JSON.stringify([dir, "installation-a", id])).digest("hex").slice(0, 26);
  const ref = { ...reservation(), id, paneId: "p-old", nativeId };
  patch({
    workspaces: [{ workspace_id: "old", label: "Personal" }],
    tabs: [{ tab_id: "t-old", workspace_id: "old", label }],
    panes: [{ pane_id: "p-old", tab_id: "t-old", cwd: ref.cwd }],
    agents: [{ pane_id: "p-old", name: label, agent: "codex", agent_status: "idle",
      interactive_ready: true, reportsNativeId: true }],
  });

  const resumed = await adapter("installation-a", { expectedNamespace: "hogu" }).ensure(ref, signal, nop);

  expect(resumed).toEqual(ref);
  const client = adapter("installation-a", { expectedNamespace: "hogu" });
  await client.prompt(resumed, "legacy follow-up", signal);
  expect(load().messages).toEqual([["p-old", "legacy follow-up"]]);
  expect(load().launches).toEqual([]);
  patch({ agents: [] });
  await expect(client.ensure({ ...reservation(), id, nativeId }, signal, nop)).rejects.toThrow("outside");
  await expect(client.ensure({ ...reservation(), id, paneId: "p-old" }, signal, nop)).rejects.toThrow("outside");
  expect(await client.ensure(ref, signal, nop)).toEqual(ref);
  expect(load().launches).toEqual([{ kind: "codex", target: "p-old", nativeArgs: ["resume", nativeId, "--add-dir", ref.resultDir] }]);
});

test.each([
  ["ein", "ein-" + "b".repeat(32)],
  ["hogu", "hogu-" + "b".repeat(32)],
] as const)("a persisted %s OMO file resumes through its exact socket path", async (brand, id) => {
  const label = brand + "-" + createHash("sha256")
    .update(JSON.stringify([dir, "installation-a", id])).digest("hex").slice(0, 26);
  const ref = { ...reservation(), runner: "omo", id, paneId: "p-old", nativeId } satisfies SessionRef;
  const file = join(dir, label + ".jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", id: nativeId, cwd: ref.cwd }) + "\n");

  await expect(adapter("installation-a", { expectedNamespace: brand })
    .ensure(ref, AbortSignal.timeout(500), nop)).rejects.toThrow();

  const command = load().paneRuns[0];
  expect(command).toContain(file);
  expect(command).toContain(join("/tmp", `${brand}-rpc-${process.getuid?.()}`));
});

test.each(["codex", "claude"] as const)("%s resumes the exact saved native conversation after its pane disappears", async kind => {
  const ref = reservation(kind);
  const updates: SessionRef[] = [];
  const first = await adapter().ensure(ref, signal, update => updates.push(update));
  expect(updates.map(update => [update.paneId, update.nativeId])).toEqual([["p1", undefined], ["p1", nativeId]]);
  patch({ tabs: [], panes: [], agents: [] });
  const resumed = await adapter().ensure(first, signal, nop);
  expect(resumed.paneId).toBe("p2");
  expect(load().panes.map(pane => pane.cwd)).toEqual([ref.cwd]);
  expect(load().launches).toEqual([
    { kind, target: "p1", nativeArgs: ["--model", kind === "codex" ? "gpt-6.2-astra" : "opus", "--add-dir", ref.resultDir] },
    { kind, target: "p2", nativeArgs: [kind === "codex" ? "resume" : "--resume", nativeId, "--add-dir", ref.resultDir] },
  ]);
});

function enableNamedCodex(cwd: string) {
  const profile = join(dir, "codex-profile");
  const decoy = crypto.randomUUID();
  const db = new Database(join(profile, "state_5.sqlite"), { create: true });
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, cwd TEXT NOT NULL)");
  db.query("INSERT INTO threads VALUES (?,?,?)").run(decoy, "another-codex-chat", cwd);
  db.close();
  writeFileSync(join(profile, "session_index.jsonl"), JSON.stringify({
    id: decoy, thread_name: "another-codex-chat", updated_at: "2099-03-30T00:00:00Z",
  }) + "\n");
  patch({ nativeId: null, renameNativeId: nativeId });
}

test("Codex recovers the named conversation from its profile and resumes by exact UUID after pane loss", async () => {
  const ref = reservation();
  enableNamedCodex(ref.cwd);
  const client = adapter();
  const first = await client.ensure(ref, signal, nop);
  expect(first.nativeId).toBe(nativeId);
  const name = load().agents[0]?.name;
  expect(load().messages).toEqual([["p1", "/rename " + name]]);
  patch({ tabs: [], panes: [], agents: [], nativeId });
  const resumed = await adapter().ensure(first, signal, nop);
  await adapter().prompt(resumed, "same conversation", signal);
  expect(load().launches.at(-1)?.nativeArgs).toEqual(["resume", nativeId, "--add-dir", ref.resultDir]);
  expect(load().messages).toEqual([["p1", "/rename " + name], ["p2", "same conversation"]]);
});

test("old Codex metadata cannot authorize a cold resume or its retry without a live identity report", async () => {
  const ref = reservation();
  enableNamedCodex(ref.cwd);
  const initial = await adapter().ensure(ref, signal, nop);
  expect(initial.nativeId).toBe(nativeId);
  const initialMessages = load().messages;
  patch({ tabs: [], panes: [], agents: [], nativeId, suppressResumeReport: true });

  let persisted = initial;
  const deliver = async () => {
    const client = adapter();
    const session = await client.ensure(persisted, signal, next => { persisted = next; });
    await client.prompt(session, "follow-up", signal);
  };
  await expect(deliver()).rejects.toThrow("identity could not be verified");
  expect(persisted.paneId).toBe("p2");
  await expect(deliver()).rejects.toThrow("identity could not be verified");
  expect(load().messages).toEqual(initialMessages);
  expect(load().launches).toHaveLength(2);
}, 8_000);

test("a new pane occupant cannot receive input if the old agent exits between verification and submit", async () => {
  const client = adapter();
  const ref = await client.ensure(reservation(), signal, nop);
  patch({ replaceAfterGet: true });
  await expect(client.prompt(ref, "belongs to first agent", signal)).rejects.toThrow();
  expect(load().messages).toEqual([]);
});

test("two installations sharing a herdr server keep the same logical ID on separate panes", async () => {
  const ref = reservation();
  const first = await adapter().ensure(ref, signal, nop);
  const other = await adapter("installation-b").ensure(ref, signal, nop);
  const reconnected = await adapter().ensure(first, signal, nop);
  expect(other.paneId).not.toBe(first.paneId);
  expect(reconnected.paneId).toBe(first.paneId);
  expect(load().launches).toHaveLength(2);
  patch({ panes: load().panes.map(pane => ({ ...pane, cwd: dir })) });
  await expect(adapter().ensure(first, signal, nop)).rejects.toThrow("directory");
});

test("native identity may arrive after the first result and capture only trusts the current bound agent", async () => {
  patch({ nativeId: null });
  const ref = await adapter().ensure(reservation(), signal, nop);
  expect(ref.nativeId).toBeUndefined();
  patch({ nativeId, status: "working" });
  expect(await adapter().capture(ref, signal)).toEqual({ ...ref, nativeId });
  patch({ agents: load().agents.map(agent => ({ ...agent, name: "foreign-session" })) });
  expect(await adapter().capture(ref, signal)).toBeUndefined();
  expect(load().launches).toHaveLength(1);
});

test("a lost pane without a verified native ID holds the job without opening another agent", async () => {
  patch({ nativeId: null });
  const ref = await adapter().ensure(reservation(), signal, nop);
  patch({ tabs: [], panes: [], agents: [] });
  await expect(adapter().ensure(ref, signal, nop)).rejects.toThrow("native session ID");
  expect(load().launches).toHaveLength(1);
  expect(load().panes).toHaveLength(0);
});

test("a working pane settles before one prompt with literal multiline content is delivered", async () => {
  const client = adapter();
  const ref = await client.ensure(reservation(), signal, nop);
  patch({ busyReads: 2 });
  const message = "A 'quoted' project and a backslash \\\n두 번째 줄";
  await client.prompt(ref, message, signal);
  expect(load().busyReads).toBe(0);
  expect(load().messages).toEqual([["p1", message]]);
});

test("blocked, mismatched and cancelled sessions never receive a prompt", async () => {
  const client = adapter();
  const ref = await client.ensure(reservation(), signal, nop);
  patch({ status: "blocked" });
  await expect(client.prompt(ref, "blocked", signal)).rejects.toThrow("not ready");
  patch({ status: "idle", nativeId: crypto.randomUUID() });
  await expect(client.prompt(ref, "different conversation", signal)).rejects.toThrow("identity");
  patch({ nativeId, busyReads: 25 });
  await expect(client.prompt(ref, "cancelled", AbortSignal.timeout(100))).rejects.toThrow();
  expect(load().messages).toEqual([]);
});

test("a missing recorded runner is reported even if the other runner is installed", async () => {
  rmSync(join(dir, "claude"));
  await expect(adapter().ensure(reservation("claude"), signal, nop)).rejects.toThrow("Missing executable on PATH: claude");
  expect(load().launches).toEqual([]);
});
