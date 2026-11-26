import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// This fixture is copied to the private test PATH with an absolute Bun shebang.
const directory = dirname(dirname(process.argv[1]!));
const state = join(directory, "fake-herdr.json");
const rawArgs = process.argv.slice(2);
if (rawArgs[0] !== "--session" || rawArgs[1] !== "ein") throw Error("Expected dedicated namespace");
const args = rawArgs.slice(2);
const option = (key: string) => args[args.indexOf(key) + 1];
const command = args.slice(0, 2).join(" ");
const workspace = { workspace_id: "w1", label: "Ein" };
const tab = { tab_id: "w1:t1", workspace_id: "w1", label: "" };
const pane = { pane_id: "w1:p1", tab_id: tab.tab_id, workspace_id: "w1", cwd: "" };
const agent = {
  pane_id: pane.pane_id, tab_id: tab.tab_id, workspace_id: "w1", name: "", agent: "codex", agent_status: "idle", resultDir: "",
  interactive_ready: true, agent_session: { agent: "codex", kind: "id", value: "832b2344-28ce-4ad5-b12a-c8242e75581c" },
};
const snapshot: { workspaces: (typeof workspace)[]; tabs: (typeof tab)[]; panes: (typeof pane)[]; agents: (typeof agent)[] } =
  existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { workspaces: [workspace], tabs: [], panes: [], agents: [] };

function log(value: unknown) {
  appendFileSync(join(directory, "herdr.jsonl"), JSON.stringify(value) + "\n");
}
function output(result: unknown) { console.log(JSON.stringify({ id: "cli:test", result })); }
function save() { writeFileSync(state, JSON.stringify(snapshot)); }
switch (command) {
  case "api snapshot": output({ type: "snapshot", snapshot }); break;
  case "tab create": {
    const label = option("--label");
    const cwd = option("--cwd");
    if (!label || !cwd || snapshot.tabs.length) throw Error("Unexpected tab creation");
    const newTab = { ...tab, label };
    const newPane = { ...pane, cwd };
    snapshot.tabs.push(newTab);
    snapshot.panes.push(newPane);
    save();
    log({ command, label, cwd });
    output({ type: "tab_created", tab: newTab, root_pane: newPane });
    break;
  }
  case "agent start": {
    if (snapshot.agents.length || option("--kind") !== "codex" || option("--pane") !== pane.pane_id) throw Error("Unexpected runner launch");
    const active = { ...agent, name: args[2]!, resultDir: args.includes("--add-dir") ? option("--add-dir")! : "" };
    snapshot.agents.push(active);
    save();
    log({ command, kind: active.agent });
    output({ type: "agent_started", agent: active });
    break;
  }
  case "agent get": output({ type: "agent_info", agent: snapshot.agents[0] }); break;
  case "agent prompt": {
    const prompt = args.at(-1)!;
    const line = prompt.split("\n").find(item => item.startsWith("EIN_TURN "));
    if (!line || !snapshot.agents.length) throw Error("Missing turn metadata or active session");
    const { jobId, attempt, role, resultFile } = JSON.parse(line.slice("EIN_TURN ".length));
    if (dirname(resultFile) !== snapshot.agents[0]?.resultDir) throw Error("Result path is outside the granted directory");
    log({ command, jobId, attempt, role, pane: args[2], prompt });
    const result = { jobId, attempt, result: { kind: "reply", text: `verified job ${jobId}` } };
    writeFileSync(resultFile + ".part", JSON.stringify(result));
    renameSync(resultFile + ".part", resultFile);
    output({ type: "ok" });
    break;
  }
  default: throw Error("Unexpected herdr subcommand " + command);
}
