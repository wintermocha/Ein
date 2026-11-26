import { loadConfig, SetupError } from "./config";
import { replay } from "./input";
import { listen } from "./live";
import { SocketFailure } from "./socket";
import { StateError } from "./state";

const help = `Ein (아인) — Slack receiver and session orchestrator
  bun run ein setup [--help]
  bun run ein check
  bun run ein replay < events.jsonl
  bun run ein listen
  bun run ein orchestrate

EIN_CONFIG selects the JSON config (default ~/.config/ein/config.json).
listen writes INBOUND records to stdout and diagnostics to stderr.
orchestrate runs the configured agent sessions and sends replies to Slack.`;

async function main(args: string[]) {
  const [command] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  const configPath = process.env["EIN_CONFIG"] ?? "~/.config/ein/config.json";
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
