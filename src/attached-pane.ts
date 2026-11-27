import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { SetupError } from "./config";
import { herdrEnvironment } from "./herdr-environment";

export interface AttachedPane {
  readonly id: string;
  readonly cwd: string;
  prompt(text: string, signal: AbortSignal): Promise<void>;
}

class AttachmentError extends SetupError {}
const execute = promisify(execFile);
const server = z.object({ running: z.literal(true), socket: z.string().refine(isAbsolute) });
const agentKind = z.enum(["codex", "claude"]);
const agent = z.object({
  pane_id: z.string(), terminal_id: z.string().min(1), agent: agentKind,
  name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).nullish(),
  agent_session: z.object({ agent: agentKind, kind: z.literal("id"), value: z.string().uuid() }),
  interactive_ready: z.boolean().optional(), launch_pending: z.boolean().optional(), agent_status: z.string(),
  foreground_cwd: z.string().nullish(),
});
const agentReply = z.object({ result: z.object({ agent }) });
const processReply = z.object({ result: z.object({ process_info: z.object({
  pane_id: z.string(), shell_pid: z.number().int().positive().nullish(), foreground_process_group_id: z.number().int().positive(),
  foreground_processes: z.array(z.object({
    pid: z.number().int().positive(), name: z.string(), argv0: z.string().nullish(), cwd: z.string().nullish(),
  })),
}) }) });

async function call(args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  try {
    const { stdout } = await execute("herdr", args, { env, signal, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    signal.throwIfAborted();
    // A subprocess error may contain both the Slack message and the reply capability in argv.
    throw new AttachmentError(`herdr ${args.slice(0, 2).join(" ")} failed. Check the running server and agent.`);
  }
}

async function socketIdentity(path: string) {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isSocket()) throw new AttachmentError("Herdr did not report a local server socket.");
  return [stat.dev, stat.ino, stat.birthtimeNs].join("/");
}

function executableMatches(kind: z.infer<typeof agentKind>, name: string) {
  const binary = basename(name);
  return kind === "claude" ? binary === "claude" :
    /^(?:codex|codex-(?:aarch64|x86_64)-(?:apple-darwin|unknown-linux-(?:musl|gnu)))$/.test(binary);
}

export async function resolveAttachedPane(pane: string, signal: AbortSignal): Promise<AttachedPane> {
  if (!/^w[1-9][0-9]*:p[1-9][0-9]*$/.test(pane))
    throw new AttachmentError("Specify the herdr pane ID, for example w1:p2.");
  const env = herdrEnvironment();
  // Discover the caller's local server, then address the verified socket explicitly on every request.
  const discovery = { ...env, HERDR_SESSION: process.env.HERDR_SESSION, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  const status = server.safeParse(await call(["status", "server", "--json"], discovery, signal));
  if (!status.success) throw new AttachmentError("Cannot find the running herdr server. Check HERDR_SESSION or HERDR_SOCKET_PATH.");
  const socket = join(await realpath(dirname(status.data.socket)), basename(status.data.socket));
  env.HERDR_SOCKET_PATH = socket;
  const serverId = await socketIdentity(socket);
  const cwd = await realpath(process.cwd());

  async function inspect(stop: AbortSignal) {
    if (await socketIdentity(socket) !== serverId) throw new AttachmentError("The attached herdr server changed.");
    const live = agentReply.safeParse(await call(["agent", "get", pane], env, stop));
    if (!live.success) throw new AttachmentError("Cannot verify the Codex or Claude native session ID. Check the herdr agent integration.");
    const info = live.data.result.agent;
    if (info.pane_id !== pane || info.agent_session.agent !== info.agent)
      throw new AttachmentError("The attached pane or native agent changed.");
    const processes = processReply.safeParse(await call(["pane", "process-info", "--pane", pane], env, stop));
    if (!processes.success) throw new AttachmentError("Cannot verify the foreground agent process.");
    const group = processes.data.result.process_info;
    const candidates = group.foreground_processes.filter(p => executableMatches(info.agent, p.name) ||
      (p.argv0 && p.name.length === 15 && basename(p.argv0).startsWith(p.name) && executableMatches(info.agent, p.argv0)));
    const proc = candidates[0];
    if (group.pane_id !== pane || group.foreground_process_group_id === group.shell_pid || candidates.length !== 1 || !proc)
      throw new AttachmentError("The attached agent is no longer the verified foreground process.");
    const directory = proc.cwd ?? info.foreground_cwd;
    if (!directory || !isAbsolute(directory) || await realpath(directory) !== cwd)
      throw new AttachmentError("Run ein from the same working directory as the foreground agent.");
    const identity = JSON.stringify([socket, serverId, pane, info.terminal_id, info.agent, info.agent_session.value,
      group.foreground_process_group_id, proc.pid]);
    return { info, identity };
  }

  const bound = await inspect(signal);
  // Herdr releases an agent's unique name on replacement. A pane ID alone would follow the new occupant.
  const target = bound.info.name ?? "ein-" + randomUUID().replaceAll("-", "").slice(0, 24);
  async function verify(stop: AbortSignal) {
    const current = await inspect(stop);
    if (current.identity !== bound.identity || current.info.name !== target)
      throw new AttachmentError("The bound herdr agent changed. Reconnect to the intended session.");
    return current.info;
  }
  if (!bound.info.name) {
    await call(["agent", "rename", pane, target], env, signal);
    await verify(signal);
  }
  return {
    id: createHash("sha256").update(JSON.stringify([socket, bound.info.agent, bound.info.agent_session.value, cwd])).digest("hex"), cwd,
    async prompt(text, stop) {
      const safeText = text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").trim();
      if (!safeText || /^[-/]/.test(safeText)) throw new AttachmentError("Expected a framed plain-text prompt.");
      for (;;) {
        const live = await verify(stop);
        if (live.interactive_ready !== false && !live.launch_pending && (live.agent_status === "idle" || live.agent_status === "done")) {
          await call(["agent", "prompt", target, safeText], env, stop);
          return;
        }
        if (live.agent_status !== "working" && !live.launch_pending)
          throw new AttachmentError("The foreground agent is not ready for a prompt. Resolve its dialog or pause and reconnect.");
        await delay(500, undefined, { signal: stop });
      }
    },
  };
}
