import { writeFileSync } from "node:fs";
import { compareSlackTs, type ThreadMessage } from "./thread-history";
import type { ThreadWindow } from "./turn-contract";

const inlineCharacters = 1_000;

// Count the readable transcript: "author: body" lines joined by a newline.
// Slack timestamps and JSON escaping are transport metadata.
function lineLength(message: ThreadMessage): number {
  return Array.from(message.user).length + 2 + Array.from(message.text).length;
}

function fitsInline(messages: readonly ThreadMessage[]): boolean {
  let length = Math.max(0, messages.length - 1);
  for (const message of messages) {
    length += lineLength(message);
    if (length > inlineCharacters) return false;
  }
  return true;
}

function excerpt(message: ThreadMessage, budget: number): ThreadMessage | undefined {
  const room = budget - Array.from(message.user).length - 2;
  if (room < 1) return undefined;
  const text = Array.from(message.text);
  if (text.length <= room) return message;
  return { ...message, text: text.slice(0, room - 1).join("") + "…" };
}

function initialPreview(messages: readonly ThreadMessage[], threadTs: string): ThreadMessage[] {
  const first = messages[0];
  const hasRoot = first !== undefined && compareSlackTs(first.ts, threadTs) === 0;
  const rootBudget = messages.length > 1 ? inlineCharacters / 2 : inlineCharacters;
  const root = hasRoot ? excerpt(first, rootBudget) : undefined;
  let remaining = inlineCharacters - (root ? lineLength(root) + 1 : 0);
  const recent: ThreadMessage[] = [];
  for (let i = messages.length - 1; i >= (hasRoot ? 1 : 0); i--) {
    const item = excerpt(messages[i]!, remaining);
    if (!item) break;
    recent.push(item);
    remaining -= lineLength(item) + 1;
  }
  recent.reverse();
  return root ? [root, ...recent] : recent;
}

export function threadFrame(window: ThreadWindow, messages: readonly ThreadMessage[], resultFile: string) {
  const kind = window.after === null ? "initial" : "delta";
  if (fitsInline(messages)) return { kind, messages };

  const fullTranscriptFile = resultFile + ".thread.json";
  writeFileSync(fullTranscriptFile, JSON.stringify(messages), { flag: "wx", mode: 0o600, flush: true });
  // A delta file contains the whole new interval. Its prompt tells the session to read it.
  if (kind === "delta") return { kind, fullTranscriptFile, messageCount: messages.length };

  const preview = initialPreview(messages, window.threadTs);
  return { kind, messages: preview, omittedMessages: messages.length - preview.length, fullTranscriptFile };
}
