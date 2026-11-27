import { writeFileSync } from "node:fs";
import { join } from "node:path";

const fakeHerdr = `
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
const [first, second, target, payload] = process.argv.slice(2);
const dir = process.env.FIXTURE;
const scenario = process.env.SCENARIO;
const read = key => existsSync(dir + "/" + key) ? readFileSync(dir + "/" + key, "utf8") : "";
const save = (key, value) => writeFileSync(dir + "/" + key, value);
const pane = scenario === "reconnect" && read("reopened") ? "w3:p2" : "w2:p7";
const socket = dir + "/herdr.sock";
function reply(result) { console.log(JSON.stringify({ result })); }
if (first === "status" && second === "server") {
  console.log(JSON.stringify({ running: true, socket }));
} else {
  if (process.env.HERDR_SOCKET_PATH !== socket || process.env.EIN_BOT_TOKEN) process.exit(33);
  if (first === "agent" && second === "get" && target === pane) {
    const version = Number(read("observations")) + 1;
    save("observations", String(version));
    const changed = scenario === "replacement" && version > 1;
    const busy = scenario === "busy" && version < 4;
    reply({ agent: { pane_id: pane, terminal_id: "term1", name: scenario === "unnamed" ? read("name") || null : "existing",
      agent: "codex", interactive_ready: true, launch_pending: false, agent_status: busy ? "working" : scenario === "blocked" ? "blocked" : "idle",
      agent_session: scenario === "missing-native" ? null : { agent: "codex", kind: "id", value: changed ? "85b2ca64-2ea4-4fec-9796-75721586cae2" : "334e26ad-855d-4466-aa9b-9711e47090c5" },
    } });
  } else if (first === "pane" && second === "process-info" && target === "--pane" && payload === pane) {
    const shell = scenario === "suspended" && Number(read("observations")) > 1;
    reply({ process_info: { pane_id: pane, foreground_process_group_id: shell ? 4 : 7,
      foreground_processes: [{ pid: shell ? 4 : 7, name: shell ? "zsh" : "codex-aarch64-apple-darwin", argv0: "codex",
        cwd: scenario === "other-directory" ? dir : process.cwd() }] } });
  } else if (first === "agent" && second === "rename" && target === pane && scenario === "unnamed") {
    save("name", payload);
    reply({});
  } else if (first === "agent" && second === "prompt") {
    // Model the live target name leaving with its process while a pane ID follows its replacement.
    if (scenario === "exited-before-write" && target === "existing") process.exit(1);
    if (target !== pane && target !== (read("name") || "existing")) process.exit(2);
    save("delivered.tmp", JSON.stringify({ text: payload, whileBusy: scenario === "busy" && Number(read("observations")) < 4 }));
    renameSync(dir + "/delivered.tmp", dir + "/delivered");
    reply({});
  } else process.exit(3);
}
`;

export function installFixtureHerdr(bin: string) {
  writeFileSync(join(bin, "herdr"), "#!" + process.execPath + "\n" + fakeHerdr, { mode: 0o700 });
}
