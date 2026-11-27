import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { Runner } from "./config";
import { omoIdentity } from "./herdr-omo";
import { findCodexSession } from "./herdr-codex-index";
import { ensurePrivateDirectory } from "./private-directory";
import { snifferPaneEnvironment } from "./sniffer";
import type { ProjectMemoryEnvironment } from "./turn-contract";
import { standalone } from "./cli-invocation";

export interface SessionRef {
  id: string;
  runner: Runner;
  cwd: string;
  paneId?: string;
  nativeId?: string;
  resultDir?: string;
}

export class RunnerError extends Error {}
const uuid = z.string().uuid();
const pane = z.object({ pane_id: z.string(), tab_id: z.string(), cwd: z.string().nullish() });
const agent = z.object({
  pane_id: z.string(), agent: z.string().nullish(), name: z.string().nullish(),
  agent_status: z.string(), interactive_ready: z.boolean().optional(),
  launch_pending: z.boolean().optional(),
  agent_session: z.object({ agent: z.string(), kind: z.string(), value: z.string() }).nullish(),
});
const snapshot = z.object({
  workspaces: z.array(z.object({ workspace_id: z.string() })),
  tabs: z.array(z.object({ tab_id: z.string(), label: z.string() })),
  panes: z.array(pane), agents: z.array(agent),
});
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
const quote = (arg: string) => "'" + arg.replaceAll("'", "'\\''") + "'";
const legacySessionId = /^hogu-[0-9a-f]{32}$/u;

interface RunnerOptions {
  namespace?: string;
  installationId?: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export class HerdrRunner {
  private readonly namespace: string | undefined;
  private readonly installationId: string;
  private readonly stateDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly codexHome: string;
  private readonly workspaces = new Map<string, Promise<string>>();

  constructor(options: RunnerOptions = {}) {
    this.namespace = options.namespace;
    this.installationId = options.installationId ?? "";
    this.stateDir = options.stateDir ?? join(homedir(), ".local", "state", "ein", "sessions");
    const { HERDR_SOCKET_PATH, HERDR_ENV, HERDR_WORKSPACE_ID, HERDR_TAB_ID, HERDR_PANE_ID,
      EIN_APP_TOKEN, EIN_BOT_TOKEN, HOGU_APP_TOKEN, HOGU_BOT_TOKEN, ...env } = options.env ?? process.env;
    this.env = env;
    this.codexHome = resolve(env.CODEX_HOME || join(env.HOME || homedir(), ".codex"));
  }

  private legacy(id: string) { return legacySessionId.test(id); }

  private namespaceFor(id: string) { return this.namespace ?? (this.legacy(id) ? "hogu" : "ein"); }

  private labelFor(id: string) {
    const prefix = this.legacy(id) ? "hogu" : "ein";
    return `${prefix}-${digest(JSON.stringify([this.stateDir, this.installationId, id])).slice(0, 26)}`;
  }

  private executable(name: string) {
    const path = Bun.which(name, { PATH: this.env.PATH ?? "" });
    if (!path) throw new RunnerError(`Missing executable on PATH: ${name}.`);
    return path;
  }

  private async call(args: string[], signal: AbortSignal, sessionId: string) {
    signal.throwIfAborted();
    const namespace = this.namespaceFor(sessionId);
    const child = Bun.spawn([this.executable("herdr"), "--session", namespace, ...args], {
      env: this.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
      signal: AbortSignal.any([signal, AbortSignal.timeout(42_000)]),
    });
    const [code, stdout, stderr] = await Promise.all([child.exited,
      new Response(child.stdout).text(), new Response(child.stderr).text()]);
    signal.throwIfAborted();
    if (code !== 0) {
      // Herdr stderr may echo the submitted prompt or include private command arguments.
      const error = /"code"\s*:\s*"([a-z][a-z0-9_]{0,62})"/.exec(stderr)?.[1];
      throw new RunnerError(`herdr ${args.slice(0, 2).join(" ")} failed (${error ?? code}). Check the ${namespace} server and pane.`);
    }
    if (!stdout.trim() && ((args[0] === "pane" && args[1] === "run") ||
        (args[0] === "agent" && args[1] === "prompt"))) return undefined;
    try { return z.object({ result: z.unknown() }).parse(JSON.parse(stdout)).result; }
    catch { throw new RunnerError("Invalid response from herdr."); }
  }

  private async layout(ref: SessionRef, signal: AbortSignal) {
    return z.object({ snapshot }).parse(await this.call(["api", "snapshot"], signal, ref.id)).snapshot;
  }

  private async createTab(label: string, ref: SessionRef, workspaceId: string | undefined, signal: AbortSignal,
    projectEnv?: ProjectMemoryEnvironment) {
    const { cwd } = ref;
    // A new headless server can have no workspace; concurrent first reservations share initialization.
    if (!workspaceId) {
      const namespace = this.namespaceFor(ref.id);
      const pending = this.workspaces.get(namespace) ?? this.call(
        ["workspace", "create", "--label", "Ein", "--cwd", cwd, "--no-focus"], signal, ref.id)
        .then(result => z.object({ workspace: z.object({ workspace_id: z.string() }) }).parse(result).workspace.workspace_id)
        .finally(() => { this.workspaces.delete(namespace); });
      this.workspaces.set(namespace, pending);
      workspaceId = await pending;
    }
    const args = ["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"];
    const memory = snifferPaneEnvironment(projectEnv, this.env);
    for (const [name, value] of Object.entries(memory)) args.push("--env", name + "=" + value);
    // The native index and the pane must address the same Codex profile.
    if (ref.runner === "codex") args.push("--env", "CODEX_HOME=" + this.codexHome);
    const result = await this.call(args, signal, ref.id);
    return z.object({ root_pane: z.object({ pane_id: z.string() }) }).parse(result).root_pane.pane_id;
  }

  private socket(ref: SessionRef) {
    // sockaddr_un is limited to ~100 bytes on macOS; configured state paths can be much longer.
    const uid = process.getuid?.();
    if (uid === undefined) throw new RunnerError("OMO bridge requires a Unix user.");
    const prefix = this.legacy(ref.id) ? "hogu" : "ein";
    const dir = join("/tmp", `${prefix}-rpc-${uid}`);
    ensurePrivateDirectory(dir);
    return join(dir, digest(JSON.stringify([this.stateDir, this.namespaceFor(ref.id), ref.id, ref.paneId])).slice(0, 32) + ".sock");
  }

  private async omoRequest(ref: SessionRef, body: object, signal: AbortSignal) {
    const reply = await fetch("http://localhost/rpc", {
      unix: this.socket(ref), method: "POST", body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!reply.ok) throw new RunnerError("OMO session refused the request or could not confirm admission.");
    return reply.json();
  }

  private async atShell(ref: SessionRef, paneId: string, signal: AbortSignal) {
    const reply = await this.call(["pane", "process-info", "--pane", paneId], signal, ref.id);
    const info = z.object({ process_info: z.object({
      pane_id: z.string(), shell_pid: z.number().nullish(), foreground_process_group_id: z.number().nullish(),
      foreground_processes: z.array(z.object({ pid: z.number(), name: z.string() })).optional(),
    }) }).parse(reply).process_info;
    return info.pane_id === paneId && !!info.shell_pid && info.foreground_process_group_id === info.shell_pid &&
      !!info.foreground_processes?.some(p => p.pid === info.shell_pid && /^-?(bash|zsh|sh|dash|ksh|fish)$/.test(p.name));
  }

  private async ensureOmo(ref: SessionRef, start: boolean, signal: AbortSignal) {
    const file = join(this.stateDir, this.labelFor(ref.id) + ".jsonl");
    if (!start && ref.nativeId && ref.paneId && await this.atShell(ref, ref.paneId, signal)) {
      // A restored herdr layout can reopen the old tab as a shell. Resume only its verified file.
      try {
        const identity = omoIdentity.parse(await this.omoRequest(ref, { command: "state" }, signal));
        if (identity.nativeId !== ref.nativeId) throw new RunnerError("OMO native session identity changed.");
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error && "code" in error &&
            ["ECONNREFUSED", "ENOENT", "FailedToOpenSocket", "ConnectionRefused"].includes(String(error.code)))) throw error;
        start = true;
      }
    }
    if (start) {
      if (!ref.paneId || !await this.atShell(ref, ref.paneId, signal))
        throw new RunnerError("OMO launch requires an idle shell in the reserved pane.");
      const executable = this.executable("omo");
      mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
      if (ref.nativeId) {
        if (!existsSync(file)) throw new RunnerError("OMO native session file is missing.");
        // Check the durable header before opening: a missing or replaced file could start a fresh conversation.
        const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(handle);
          if (!stat.isFile() || stat.uid !== process.getuid?.()) throw new RunnerError("Invalid OMO native session file.");
          const buffer = Buffer.alloc(16_384);
          const length = readSync(handle, buffer);
          const header = z.object({ type: z.literal("session"), id: uuid, cwd: z.string() }).parse(
            JSON.parse(buffer.toString("utf8", 0, length).split("\n")[0] ?? ""));
          if (header.id !== ref.nativeId || realpathSync(header.cwd) !== realpathSync(ref.cwd)) throw new RunnerError("OMO native session identity changed.");
        } finally { closeSync(handle); }
      }
      const bridge = standalone ? [process.execPath, "__omo-bridge"] : [process.execPath, join(import.meta.dir, "herdr-omo.ts")];
      const command = [...bridge, executable, file, this.socket(ref)];
      await this.call(["pane", "run", ref.paneId ?? "", "exec " + command.map(quote).join(" ")], signal, ref.id);
    }
    const deadline = Date.now() + 30_000;
    const connectDeadline = start ? deadline : Date.now() + 1_500;
    for (;;) {
      let identity: z.infer<typeof omoIdentity> | undefined;
      try { identity = omoIdentity.parse(await this.omoRequest(ref, { command: "state" }, signal)); }
      catch (error) {
        signal.throwIfAborted();
        if (Date.now() >= connectDeadline) throw new RunnerError("OMO bridge could not verify the session.", { cause: error });
      }
      if (identity) {
        if (identity.blocked || (ref.nativeId && ref.nativeId !== identity.nativeId))
          throw new RunnerError("OMO session identity or readiness could not be confirmed.");
        if (identity.ready) return identity.nativeId;
        if (Date.now() >= deadline) throw new RunnerError("OMO session is still working.");
      }
      await delay(150, undefined, { signal });
    }
  }

  private async builtIn(ref: SessionRef, label: string, start: boolean, signal: AbortSignal, captureOnly = false) {
    const binding = join(this.stateDir, label + ".codex-pane");
    if (start) {
      // A former pane's local rename receipt must never attest a new foreground process.
      if (ref.runner === "codex") rmSync(binding, { force: true });
      const args = ["agent", "start", label, "--kind", ref.runner, "--pane", ref.paneId ?? ""];
      const native: string[] = [];
      if (ref.nativeId) {
        if (!uuid.safeParse(ref.nativeId).success) throw new RunnerError("Invalid native session ID.");
        native.push(ref.runner === "claude" ? "--resume" : "resume", ref.nativeId);
      }
      if (ref.resultDir) native.push("--add-dir", ref.resultDir);
      await this.call(native.length ? [...args, "--", ...native] : args, signal, ref.id);
    }
    const deadline = Date.now() + 30_000;
    const resumeDeadline = Date.now() + 2_500;
    for (;;) {
      const result = await this.call(["agent", "get", ref.paneId ?? ""], signal, ref.id);
      const live = z.object({ agent }).parse(result).agent;
      if (live.pane_id !== ref.paneId || live.agent !== ref.runner || live.name !== label)
        throw new RunnerError("Agent foreground identity changed.");
      const recorded = live.agent_session;
      let id = recorded?.agent === ref.runner && recorded.kind === "id" && uuid.safeParse(recorded.value).success
        ? recorded.value : undefined;
      if (!recorded && ref.runner === "codex" && !start && this.namedInPane(binding, live.pane_id)) {
        id = findCodexSession(this.codexHome, label, ref.cwd);
      }
      if (ref.nativeId && ref.nativeId !== id) {
        // Disk indexes describe past sessions. Only the newly started live agent can
        // confirm a cold resume; a missing initial hook report may arrive just after startup.
        if (start && !recorded && Date.now() < resumeDeadline) {
          await delay(100, undefined, { signal });
          continue;
        }
        throw new RunnerError("Native session identity could not be verified.");
      }
      if (captureOnly) return id;
      if (["idle", "done"].includes(live.agent_status) && live.interactive_ready !== false && !live.launch_pending) {
        if (!recorded && start && !ref.nativeId && ref.runner === "codex")
          return this.identifyNewCodex(label, ref, live.pane_id, binding, signal);
        return id;
      }
      if (live.agent_status !== "working" || Date.now() >= deadline)
        throw new RunnerError(`${ref.runner} session is not ready for input.`);
      await delay(250, undefined, { signal });
    }
  }

  private namedInPane(file: string, paneId: string) {
    try {
      const info = lstatSync(file);
      return info.isFile() && info.size === Buffer.byteLength(paneId) && readFileSync(file, "utf8") === paneId;
    } catch { return false; }
  }

  private async identifyNewCodex(label: string, ref: SessionRef, paneId: string, binding: string, signal: AbortSignal) {
    // 0.140 can expose the first UUID only after a local /rename. Older or unavailable
    // stores keep using the verified live agent until herdr reports a native UUID.
    if (!existsSync(join(this.codexHome, "state_5.sqlite"))) return undefined;
    if (findCodexSession(this.codexHome, label, ref.cwd))
      throw new RunnerError("Codex reservation name already belongs to an indexed session.");
    try { await this.call(["agent", "prompt", label, "/rename " + label], signal, ref.id); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof RunnerError)) throw error;
      return undefined;
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(binding, paneId, { mode: 0o600, flag: "wx" });
    const deadline = Date.now() + 2_500;
    do {
      const id = findCodexSession(this.codexHome, label, ref.cwd);
      if (id) return id;
      await delay(100, undefined, { signal });
    } while (Date.now() < deadline);
    return undefined;
  }

  async ensure(ref: SessionRef, signal: AbortSignal, onUpdate: (current: SessionRef) => void,
    projectEnv?: ProjectMemoryEnvironment): Promise<SessionRef> {
    this.executable(ref.runner);
    const label = this.labelFor(ref.id);
    const layout = await this.layout(ref, signal);
    const tabs = layout.tabs.filter(tab => tab.label === label);
    const matches = layout.panes.filter(p => tabs.some(t => t.tab_id === p.tab_id));
    if (tabs.length > 1 || (tabs.length && matches.length !== 1))
      throw new RunnerError("Ein reservation has an ambiguous pane.");
    const matched = matches[0];
    if (matched && (!matched.cwd || realpathSync(matched.cwd) !== realpathSync(ref.cwd)))
      throw new RunnerError("Reserved pane working directory differs from its registered project.");
    const found = matched?.pane_id;
    if ((ref.paneId && ref.paneId !== found && layout.panes.some(p => p.pane_id === ref.paneId)) ||
        (!found && layout.agents.some(a => a.name === label)))
      throw new RunnerError("Reserved session moved; its pane could not be reconciled.");
    if (ref.paneId && ref.paneId !== found && !ref.nativeId)
      throw new RunnerError("Previous pane is missing and no verified native session ID is available.");
    const paneId = found ?? await this.createTab(label, ref, layout.workspaces[0]?.workspace_id, signal, projectEnv);
    const current = { ...ref, paneId };
    if (paneId !== ref.paneId) onUpdate(current);
    const existing = layout.agents.find(a => a.pane_id === paneId && a.agent);
    // A persisted pane without a live agent may have run previously. Never restart it as a fresh session.
    let start = !found || (!existing && !ref.paneId);
    if (found && ref.runner !== "omo" && !existing && ref.nativeId) start = true;
    const nativeId = ref.runner === "omo"
      ? await this.ensureOmo(current, start, signal)
      : await this.builtIn(current, label, start, signal);
    if (!nativeId || nativeId === ref.nativeId) return current;
    const verified = { ...current, nativeId };
    onUpdate(verified);
    return verified;
  }

  async capture(ref: SessionRef, signal: AbortSignal): Promise<SessionRef | undefined> {
    if (ref.runner === "omo" || !ref.paneId || ref.nativeId) return undefined;
    try {
      const id = await this.builtIn(ref, this.labelFor(ref.id), false, signal, true);
      return id ? { ...ref, nativeId: id } : undefined;
    } catch { return undefined; } // Completion already has a valid result; identity is best-effort.
  }

  async prompt(ref: SessionRef, text: string, signal: AbortSignal): Promise<void> {
    if (!ref.paneId) throw new RunnerError("Session has no verified pane.");
    if (ref.runner === "omo") {
      if (!ref.nativeId) throw new RunnerError("Missing OMO native session identity.");
      z.object({ accepted: z.literal(true) }).parse(await this.omoRequest(ref, { command: "prompt", nativeId: ref.nativeId, text }, signal));
      return;
    }
    await this.builtIn(ref, this.labelFor(ref.id), false, signal);
    if (/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(text))
      throw new RunnerError("Prompt contains unsupported terminal controls.");
    // This CLI parses a standalone "--" as prompt text. Keep leading dashes out of option position.
    const input = text.startsWith("-") ? "Ein\n" + text : text;
    await this.call(["agent", "prompt", this.labelFor(ref.id), input], signal, ref.id);
  }
}
