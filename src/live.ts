import { setTimeout as delay } from "node:timers/promises";
import ky from "ky";
import { z } from "zod";
import { Checkpoints } from "./checkpoints";
import { credentials, requireOrchestration, type Config, SetupError } from "./config";
import { writeRecord } from "./input";
import type { Orchestration } from "./orchestrator";
import { recover } from "./recovery";
import { listenSocket } from "./socket";
import { ReceiverState } from "./state";

// One operator diagnostic per sustained outage. stdout belongs to the lead.
class Outage {
  #timer: ReturnType<typeof setTimeout> | undefined;
  fail(reason: string): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => console.error(`Ein: ${reason} (2 min); retrying.`), 120_000);
  }
  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

const identity = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), team_id: z.string(), user_id: z.string() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

async function verifyIdentity(config: Config, botToken: string, signal: AbortSignal) {
  const outage = new Outage();
  try {
    while (!signal.aborted) {
      let retryMs = 15_000;
      try {
        const response = await ky.post("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${botToken}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
          retry: 0, timeout: 15_000, redirect: "error", throwHttpErrors: false,
        });
        if (response.ok) {
          const parsed = identity.safeParse(await response.json());
          if (!parsed.success) throw new SetupError("Slack returned an unexpected auth.test response.");
          if (parsed.data.ok) {
            if (parsed.data.user_id !== config.botUser || parsed.data.team_id !== config.team) {
              throw new SetupError("The bot token identity does not match team and botUser in config.");
            }
            return;
          }
          if (!["internal_error", "service_unavailable", "ratelimited"].includes(parsed.data.error)) {
            throw new SetupError("Slack rejected the configured bot token (auth.test).");
          }
        } else if (response.status === 429) {
          const seconds = Number(response.headers.get("Retry-After"));
          if (Number.isFinite(seconds)) retryMs = Math.max(retryMs, seconds * 1_000);
        } else if (response.status < 500) {
          throw new SetupError(`Slack auth.test returned HTTP ${response.status}.`);
        }
      } catch (error) {
        if (error instanceof SetupError) throw error;
        if (signal.aborted) return;
      }
      outage.fail("Slack auth.test unavailable");
      await delay(retryMs, undefined, { signal });
    }
  } finally {
    outage.clear();
  }
}

export async function listen(config: Config, controller: AbortController, mode: "listen" | "orchestrate" = "listen"): Promise<void> {
  const runner = mode === "orchestrate" ? requireOrchestration(config) : undefined;
  const { appToken, botToken } = credentials(config);
  const { signal } = controller;
  const state = new ReceiverState(config.stateFile, config.team, config.botUser, mode);
  const connection = new Outage();
  const history = new Outage();
  let delivery: ReturnType<typeof setImmediate> | undefined;
  let orchestration: Orchestration | undefined;
  let failure: SetupError | undefined;
  function failLocal() {
    failure ??= new SetupError(mode === "listen"
      ? "Local persistence or stdout failed. Check state storage and the lead's input pipe."
      : "Orchestration stopped. Check local state storage and permissions.");
    controller.abort();
  }
  function receive(event: unknown) {
    const tracked = state.consume(event, config);
    if (orchestration) {
      orchestration.wake();
    } else if (mode === "listen" && !delivery) {
      delivery = setImmediate(() => {
        delivery = undefined;
        try { state.drain(writeRecord); }
        catch { failLocal(); }
      });
    }
    return tracked;
  }
  const now = () => (Date.now() / 1000).toFixed(6);
  const checkpoints = new Checkpoints({
    read: () => state.recoveryCursor(),
    save: ts => state.setRecoveryCursor(ts),
    readLimitEnd: () => state.readLimitEnd(),
    saveRateLimit: (oldest, end) => state.saveRateLimit(oldest, end),
    clearLimit: () => state.clearLimit(),
    now,
    onFatal: failLocal,
    recover: async (window, gapSignal) => {
      const channels = [...config.watchChannels, ...state.channels()];
      if (config.ownerDm) channels.push(config.ownerDm);
      const affected = new Map<string, { channel: string; threadTs: string }>();
      const options = {
        botToken, channels, threads: state.threads(), window, signal: gapSignal,
        onEvent: receive, onIssue: (reason: string) => history.fail(reason),
      };
      const historyComplete = await recover({ ...options, onEvent: event => {
        const tracked = receive(event);
        if (tracked) affected.set(`${tracked.channel}/${tracked.threadTs}`, tracked);
      } });
      // Live replies could have arrived before history established that the bot owned a thread.
      const overlapComplete = gapSignal.aborted || affected.size === 0 || await recover({
        ...options, channels: [], threads: [...affected.values()], window: { oldest: window.latest, latest: now() },
      });
      const complete = historyComplete && overlapComplete && !gapSignal.aborted;
      if (complete) history.clear();
      return complete;
    },
  });
  try {
    if (mode === "listen") state.drain(writeRecord);
    await verifyIdentity(config, botToken, signal);
    if (runner && !signal.aborted) {
      const { prepareOrchestration } = await import("./orchestrator");
      orchestration = prepareOrchestration({ config, queue: state.jobs, runner, botToken, signal, onFatal: failLocal });
    }
    if (!signal.aborted) await listenSocket({
      appToken, appId: config.appId, signal,
      onRateLimited: (minute, team) => {
        if (team === config.team) {
          checkpoints.rateLimited(minute);
          history.fail("Slack event delivery rate limited");
        }
      },
      onEvent: (event, team) => { if (team === config.team) receive(event); },
      onReady: () => { checkpoints.ready(); orchestration?.start(); },
      onDisconnected: () => checkpoints.disconnected(),
      onHealthy: () => { connection.clear(); checkpoints.tick(); },
      onIssue: reason => connection.fail(reason),
    });
  } finally {
    try {
      await Promise.all([checkpoints.stop().catch(failLocal), orchestration?.stop()]);
    } finally {
      if (delivery) clearImmediate(delivery);
      connection.clear();
      history.clear();
      state.close();
    }
  }
  if (failure) throw failure;
}
