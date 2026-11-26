import type { KyInstance } from "ky";
import { type HistoryMessage, readMessages, RecoveryIssue, type RecoveryWindow } from "./slack-api";

type Thread = { readonly channel: string; readonly threadTs: string };
type RecoveryOptions = {
  readonly botToken: string;
  readonly channels: readonly string[];
  readonly threads: readonly Thread[];
  readonly window: RecoveryWindow;
  readonly signal: AbortSignal;
  readonly onEvent: (event: unknown) => void;
  readonly onIssue: (reason: string) => void;
  readonly http?: KyInstance;
};

// Slack timestamps have six fractional digits. Compare whole seconds first without precision loss.
function compareTs(a: string, b: string): number {
  return a.length - b.length || a.localeCompare(b, "en");
}

export async function recover(options: RecoveryOptions): Promise<boolean> {
  const historyChannels = new Set(options.channels);
  const threads = new Map<string, Set<string>>();
  for (const channel of historyChannels) threads.set(channel, new Set());
  for (const { channel, threadTs } of options.threads) {
    const known = threads.get(channel) ?? new Set<string>();
    known.add(threadTs);
    threads.set(channel, known);
  }
  const issues = new Set<string>();
  let stopScan = false;
  for (const [channel, roots] of threads) {
    if (stopScan || options.signal.aborted) break;
    const messages = new Map<string, HistoryMessage>();
    let repliesDenied = false;
    async function scan(threadTs?: string): Promise<void> {
      const target = threadTs ? { channel, threadTs } : { channel };
      try {
        for await (const msg of readMessages(options, target)) {
          if (compareTs(msg.ts, options.window.oldest) < 0 || compareTs(msg.ts, options.window.latest) > 0) continue;
          if (!threadTs && (msg.reply_count || msg.thread_ts)) roots.add(msg.thread_ts ?? msg.ts);
          const parent = msg.thread_ts ?? (threadTs !== msg.ts ? threadTs : undefined);
          messages.set(msg.ts, parent ? { ...msg, thread_ts: parent } : msg);
        }
      } catch (error) {
        if (!(error instanceof RecoveryIssue)) throw error;
        if (options.signal.aborted) return;
        const diagnostic = error.scope === "channel" && /^[CDG][A-Z0-9]{1,31}$/.test(channel)
          ? `${error.message} ${channel}` : error.message;
        if (!issues.has(diagnostic)) options.onIssue(diagnostic);
        issues.add(diagnostic);
        stopScan = error.scope === "scan";
        repliesDenied = threadTs !== undefined && error.scope === "channel";
      }
    }
    if (historyChannels.has(channel)) await scan();
    for (const parent of roots) {
      if (stopScan || repliesDenied || options.signal.aborted) break;
      await scan(parent);
    }
    // A bot post early in the interval can make a later reply eligible as an own-thread event.
    const ordered = [...messages.values()].sort((a, b) => compareTs(a.ts, b.ts));
    const channelType = channel.startsWith("D") ? "im" : channel.startsWith("G") ? "group" : "channel";
    for (const msg of ordered) {
      if (options.signal.aborted) return false;
      options.onEvent({ ...msg, channel, channel_type: channelType });
    }
  }
  return !options.signal.aborted && issues.size === 0;
}
