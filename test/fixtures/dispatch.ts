import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, Runner } from "../../src/config";
import type { OutgoingDelivery } from "../../src/delivery-store";
import { Dispatcher } from "../../src/dispatch";
import { ReceiverState } from "../../src/state";
import type { RunTurn, TurnRequest } from "../../src/turn-contract";

type SendOptions = { readonly channel?: string; readonly root?: string; readonly user?: string };
type Options = { readonly file?: string; readonly runner?: Runner };
let sequence = 0;
export const timestamp = () => `1700000000.${String(++sequence).padStart(6, "0")}`;

export function createHarness(runTurn: RunTurn, options: Options = {}) {
  const neutralDirectory = options.file ? join(dirname(options.file), "neutral") : mkdtempSync(join(tmpdir(), "ein-neutral-"));
  if (options.file) mkdirSync(neutralDirectory, { recursive: true, mode: 0o700 });
  const config: Config = {
    team: "TTEST", appId: "ATEST", ownerUser: "UOWNER", botUser: "UBOT",
    watchChannels: ["CSHARED", "CWEB", "CAPI"], blockedUsers: [], otherUserReplyRate: {},
    stateFile: options.file ?? ":memory:", runner: options.runner ?? "omo",
    projects: { web: { path: "/repo/web", channels: ["CWEB"] }, api: { path: "/repo/api", channels: ["CAPI"] } },
  };
  const state = new ReceiverState(config.stateFile, config.team, config.botUser, "orchestrate");
  const calls: TurnRequest[] = [];
  let fatal = false;
  const dispatcher = new Dispatcher({
    queue: state.jobs, config, runner: options.runner ?? "omo", neutralDirectory, onFatal() { fatal = true; },
    runTurn(request, signal, update) {
      calls.push(request);
      return runTurn(request, signal, update);
    },
  });
  function send(text: string, { channel = "CSHARED", root, user = "UOWNER" }: SendOptions = {}) {
    const ts = timestamp();
    state.consume({
      type: channel.startsWith("D") ? "message" : "app_mention",
      channel, ts, thread_ts: root, text, user,
    }, config);
    dispatcher.wake();
    return ts;
  }
  function settle(sentAt?: string): OutgoingDelivery[] {
    const deliveries: OutgoingDelivery[] = [];
    for (let item = state.jobs.claimDelivery(Date.now()); item; item = state.jobs.claimDelivery(Date.now())) {
      deliveries.push(item);
      state.jobs.settleDelivery(item.id, { kind: "sent", ts: sentAt ?? timestamp() });
    }
    dispatcher.wake();
    return deliveries;
  }
  async function close() {
    await dispatcher.stop();
    state.close();
    if (!options.file) rmSync(neutralDirectory, { recursive: true, force: true });
    if (fatal) throw new Error("Dispatcher signalled fatal shutdown");
  }
  return { state, calls, neutralDirectory, dispatcher, send, settle, close };
}
