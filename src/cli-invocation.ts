import { fileURLToPath } from "node:url";

// The release build sets this constant when Bun embeds the CLI and its dependencies.
declare const EIN_STANDALONE: boolean;
export const standalone = typeof EIN_STANDALONE !== "undefined" && EIN_STANDALONE;
export const einCommand = standalone ? "ein" : "bun run ein";

// A connected agent may run from a different repository or have a different PATH.
export function agentEinCommand(env: Readonly<Record<"EIN_HOME" | "EIN_CONFIG", string>>): string {
  const args = standalone ? [process.execPath] : [process.execPath, fileURLToPath(new URL("./cli.ts", import.meta.url))];
  const command = [...Object.entries(env).map(([key, value]) => key + "=" + value), ...args];
  return "/usr/bin/env " + command.map(arg => "'" + arg.replaceAll("'", "'\\''") + "'").join(" ");
}
