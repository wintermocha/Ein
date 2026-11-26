import { join } from "node:path";
import { z } from "zod";
import { createRunTurn } from "./agent-turn";
import type { Config, Runner } from "./config";
import { Dispatcher } from "./dispatch";
import type { JobQueue } from "./job-queue";
import { ensurePrivateDirectory } from "./private-directory";
import { HerdrRunner } from "./runners";
import { runSender } from "./sender";
import { fetchThreadHistory } from "./thread-history";

type ServiceOptions = {
  readonly config: Config;
  readonly runner: Runner;
  readonly queue: JobQueue;
  readonly botToken: string;
  readonly signal: AbortSignal;
  readonly onFatal: () => void;
};

export type Orchestration = {
  readonly start: () => void;
  readonly wake: () => void;
  readonly stop: () => Promise<void>;
};

/** Prepare local storage now. Work starts after the first authenticated Socket Mode hello. */
export function prepareOrchestration(options: ServiceOptions): Orchestration {
  const { config, runner, queue, onFatal } = options;
  const base = ensurePrivateDirectory(config.stateFile + ".orchestration");
  // A database recreated at the same path must not consume an older installation's results.
  const installationId = z.uuid().parse(queue.installationId);
  const root = ensurePrivateDirectory(join(base, installationId));
  const neutralDirectory = ensurePrivateDirectory(join(root, "workspaces"));
  const stateDir = ensurePrivateDirectory(join(root, "sessions"));
  const turnDir = ensurePrivateDirectory(join(root, "turns"));
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, options.signal]);
  const onIssue = (reason: string) => console.error(`Ein: ${reason}`);
  const dispatcher = new Dispatcher({
    config, queue, runner, neutralDirectory, onFatal, onIssue,
    runTurn: createRunTurn(new HerdrRunner({ stateDir, installationId }), turnDir, {
      readThread: (window, signal) => fetchThreadHistory({
        ...window, botToken: options.botToken, blockedUsers: config.blockedUsers, signal,
      }),
    }),
  });
  let sender: Promise<void> | undefined;
  function wake() {
    if (sender && !signal.aborted) dispatcher.wake();
  }
  return {
    start() {
      if (sender || signal.aborted) return;
      sender = runSender({
        queue, signal, botUser: config.botUser, botToken: options.botToken, onIssue, onSettled: wake,
      }).catch(() => { if (!signal.aborted) onFatal(); });
      wake();
    },
    wake,
    async stop() {
      controller.abort();
      await Promise.all([dispatcher.stop().catch(onFatal), sender]);
    },
  };
}
