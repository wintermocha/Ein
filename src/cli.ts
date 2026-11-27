import { loadConfig, SetupError } from "./config";
import { replay } from "./input";
import { listen } from "./live";
import { SocketFailure } from "./socket";
import { StateError } from "./state";
import { einCommand } from "./cli-invocation";
import { runSniffer } from "./sniffer";

const help = `Ein (아인) — Slack orchestration and project memory
  ${einCommand} setup [--help]
  ${einCommand} check
  ${einCommand} replay < events.jsonl
  ${einCommand} listen
  ${einCommand} orchestrate
  ${einCommand} project add --id ID --path DIRECTORY
  ${einCommand} folder bind --path DIRECTORY [--project ID]
  ${einCommand} memory search --query TEXT
  ${einCommand} run claude|codex|agy [-- NATIVE_ARGUMENTS]
  ${einCommand} delegate [--cwd DIRECTORY] [--project ID] [-- COMMAND ARG...]
  ${einCommand} sniffer help

EIN_CONFIG selects the JSON config (default ~/.config/ein/config.json).
EIN_HOME selects the Sniffer installation and memory store (default ~/.ein).
listen writes INBOUND records to stdout and diagnostics to stderr.
orchestrate runs the configured agent sessions and sends replies to Slack.`;

async function main(args: string[]) {
  const [command] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  const configPath = process.env["EIN_CONFIG"] ?? "~/.config/ein/config.json";
  if (command === "__omo-bridge") {
    const { runOmoBridge } = await import("./herdr-omo");
    return runOmoBridge(args.slice(1));
  }
  if (command === "sniffer") return runSniffer(args.slice(1));
  if (["memory", "project", "group", "folder", "run", "delegate"].includes(command)) {
    if (((command === "run" && ["claude", "codex", "agy"].includes(args[1] ?? "")) ||
        (command === "memory" && args[1] === "save" && !args.some(arg => arg === "--project" || arg.startsWith("--project=") || arg === "--global"))) &&
        process.stdin.isTTY && process.stderr.isTTY && !process.env.EIN_SNIFFER_EXPECT_PROJECT && !process.env.EIN_SNIFFER_ROLE && !process.env.EIN_SNIFFER_DELEGATION) {
      const { hasMemoryEngine, connectFirstFolder } = await import("./setup-folders");
      if (hasMemoryEngine()) await connectFirstFolder();
    }
    return runSniffer(args);
  }
  if (command === "setup") {
    const { setup } = await import("./setup");
    return setup(configPath, args.slice(1));
  }
  if (args.length !== 1 || !["check", "listen", "replay", "orchestrate"].includes(command)) {
    throw new SetupError("Invalid command or arguments. Run with --help.");
  }
  const config = loadConfig(configPath);
  switch (command) {
    case "check":
      console.log("Ein config OK (offline).");
      return;
    case "replay":
      return replay(config);
    case "listen":
    case "orchestrate": {
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await listen(config, controller, command);
      } catch (error) {
        if (!(controller.signal.aborted && error instanceof Error && error.name === "AbortError")) throw error;
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    }
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const safe = error instanceof SetupError || error instanceof StateError || error instanceof SocketFailure;
  console.error(`Ein: ${safe ? error.message : "Local I/O failed. Check config, state permissions and the output pipe."}`);
  process.exitCode = 1;
}
