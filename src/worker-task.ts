import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { sessionModel, sessionModels, SetupError, type Runner } from "./config";
import { agentEinCommand } from "./cli-invocation";
import { herdrEnvironment } from "./herdr-environment";
import { snifferEnvironment } from "./sniffer";

const usage = "Usage: ein orchestration enable [codex|claude|omo] | disable | status";

function parseRunner(value: string): Runner {
  if (value === "codex" || value === "claude" || value === "omo") return value;
  throw new SetupError(usage);
}

function settingPath(cwd: string) {
  const key = createHash("sha256").update(realpathSync(cwd)).digest("hex");
  return join(snifferEnvironment().EIN_HOME, "orchestration", key);
}

export function orchestrationRunner(cwd = process.cwd()): Runner | undefined {
  const path = settingPath(cwd);
  try { return parseRunner(readFileSync(path, "utf8").trim()); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function showEnabled(runner: Runner) {
  console.log("enabled " + runner);
  console.log(`To delegate work in this folder, run ${agentEinCommand(snifferEnvironment())} task 'TASK' with the task instructions. Read the worker's stdout and report the result to the user.`);
}

export function orchestrationCommand(args: string[]) {
  const [command, value] = args;
  if (args.length > (command === "enable" ? 2 : 1)) throw new SetupError(usage);
  const path = settingPath(process.cwd());
  switch (command) {
    case "enable": {
      const runner = parseRunner(value ?? "codex");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = path + "." + randomUUID();
      try {
        writeFileSync(temp, runner + "\n", { mode: 0o600, flag: "wx" });
        renameSync(temp, path);
      } finally { rmSync(temp, { force: true }); }
      showEnabled(runner);
      return;
    }
    case "disable":
      rmSync(path, { force: true });
      console.log("disabled");
      return;
    case "status": {
      const runner = orchestrationRunner();
      if (runner) showEnabled(runner);
      else console.log("disabled");
      return;
    }
    default: throw new SetupError(usage);
  }
}

const textBlock = z.object({ type: z.literal("text"), text: z.string() });
const codexItem = z.object({ type: z.literal("item.completed"),
  item: z.object({ type: z.literal("agent_message"), text: z.string() }) });
const omoMessage = z.object({ type: z.literal("message_end"), message: z.object({
  role: z.literal("assistant"), stopReason: z.string(), content: z.array(z.unknown()),
}) });

async function finalReply(runner: Runner, stream: Readable) {
  if (runner === "claude") return text(stream);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let reply = "";
  let completed = false;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw new SetupError(`Invalid ${runner} task output.`); }
    if (runner === "codex") {
      const type = z.object({ type: z.string() }).parse(event).type;
      if (type === "turn.failed") throw new SetupError("Codex task failed before completion.");
      if (type === "turn.completed") completed = true;
      const result = codexItem.safeParse(event);
      if (result.success) reply = result.data.item.text;
    } else {
      const result = omoMessage.safeParse(event);
      if (!result.success) continue;
      const { stopReason, content } = result.data.message;
      reply = stopReason === "stop" ? content.flatMap(block => {
        const parsed = textBlock.safeParse(block);
        return parsed.success ? [parsed.data.text] : [];
      }).join("\n") : "";
    }
  }
  return runner === "codex" && !completed ? "" : reply;
}

function workerModel(runner: Runner) {
  try {
    const input: unknown = JSON.parse(readFileSync(snifferEnvironment().EIN_CONFIG, "utf8"));
    return sessionModel(runner, z.object({ models: sessionModels.optional() }).parse(input).models);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return sessionModel(runner);
    throw new SetupError("Could not read session models from EIN_CONFIG.");
  }
}

function workerArgs(runner: Runner, executable: string, env: NodeJS.ProcessEnv): string[] {
  const model = workerModel(runner);
  const modelArgs = model ? ["--model", model] : [];
  switch (runner) {
    case "codex": {
      const isolation = ["--disable", "plugins", "--disable", "hooks"];
      // Codex merges MCP table overrides, so an empty table would retain inherited servers.
      const inventory = spawnSync(executable, [...isolation, "mcp", "list", "--json"], {
        env, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
      });
      let overrides: string;
      try {
        if (inventory.status !== 0) throw new Error();
        const servers = z.array(z.object({ name: z.string(), enabled: z.boolean() })).parse(JSON.parse(inventory.stdout));
        overrides = servers.filter(s => s.enabled).map(s => JSON.stringify(s.name) + "={enabled=false}").join(",");
      } catch { throw new SetupError("Could not verify the worker's Codex MCP configuration."); }
      return ["exec", ...modelArgs, ...isolation, "--ephemeral", "--skip-git-repo-check", "--json",
        "-c", "mcp_servers={" + overrides + "}", "-c", 'shell_environment_policy.set.EIN_SNIFFER_DELEGATION="none"', "-"];
    }
    case "claude": return ["--print", ...modelArgs, "--output-format", "text", "--no-session-persistence", "--strict-mcp-config", "--safe-mode"];
    case "omo": return ["--print", ...modelArgs, "--mode", "json", "--no-session", "--no-extensions",
      "--tools", "read,bash,edit,write,grep,find,ls", "-"];
  }
}

export async function workerTask(args: string[]) {
  const runner = orchestrationRunner();
  if (!runner) throw new SetupError("Run ein orchestration enable in this directory first.");
  if (args.length > 1) throw new SetupError("Usage: ein task 'TEXT' (or pipe text to stdin)");
  const task = args[0] ?? (process.stdin.isTTY ? "" : await Bun.stdin.text());
  if (!task.trim()) throw new SetupError("Provide task text as one argument or on stdin.");
  const executable = Bun.which(runner);
  if (!executable) throw new SetupError(`Missing executable on PATH: ${runner}.`);
  const inheritedSession = /^(?:EIN_(?:SNIFFER_|AGENT_SESSION$)|SLACK_|CLAUDECODE$|CLAUDE_CODE_(?:SESSION|ENTRYPOINT|PARENT|SSE|REMOTE_SESSION)|CODEX_(?:THREAD|SESSION|PARENT|INTERNAL|APP_TOOLS_PIPE|TOOL_CALL|TASK_WORKSPACE)|(?:OMO|PI|SENPI)_(?:RPC|SESSION|PARENT|TASK|AGENT_ID))/;
  const env = Object.fromEntries(Object.entries(herdrEnvironment()).filter(([key]) => !inheritedSession.test(key)));
  env.EIN_SNIFFER_DELEGATION = "none";
  const child = spawn(executable, workerArgs(runner, executable, env), {
    cwd: realpathSync(process.cwd()), env,
    stdio: ["pipe", "pipe", "inherit"], detached: true,
  });
  const closed = once(child, "close").catch(() => {
    throw new SetupError(`Could not start the ${runner} worker. Check its executable on PATH.`);
  });
  // A CLI may exit before reading stdin, for example if it rejects an option.
  child.stdin.on("error", () => {});
  child.stdin.end(task);
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function kill(signal: NodeJS.Signals) {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  function cancel() {
    cancelled = true;
    kill("SIGTERM");
    timer ??= setTimeout(() => kill("SIGKILL"), 1500);
  }
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  try {
    const [[code, signal], reply] = await Promise.all([closed, finalReply(runner, child.stdout)]);
    if (cancelled || code !== 0) throw new SetupError(`${runner} task failed (${signal ?? code}).`);
    if (!reply.trim()) throw new SetupError(`${runner} returned no final reply.`);
    process.stdout.write(reply.endsWith("\n") ? reply : reply + "\n");
  } catch (error) {
    kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
    process.off("SIGTERM", cancel);
    process.off("SIGINT", cancel);
  }
}
