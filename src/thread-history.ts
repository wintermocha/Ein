import type { KyInstance } from "ky";
import { z } from "zod";
import { redactCredentials } from "./redaction";
import { readMessages } from "./slack-api";

export type ThreadMessage = { ts: string; user: string; text: string };

type Options = {
  readonly botToken: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly after: string | null;
  readonly before: string;
  readonly blockedUsers: readonly string[];
  readonly signal: AbortSignal;
  readonly http?: KyInstance;
};

function micros(ts: string): bigint {
  const [seconds, fraction = ""] = ts.split(".");
  return BigInt(`${seconds}${fraction.padEnd(6, "0")}`);
}

/** Compare seconds and microseconds exactly, even when the socket event omits trailing zeros. */
export function compareSlackTs(a: string, b: string): number {
  const left = micros(a);
  const right = micros(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

const conversationMessage = z.object({
  type: z.literal("message"),
  hidden: z.literal(false).optional(),
  subtype: z.enum(["me_message", "file_share", "thread_broadcast", "bot_message"]).optional(),
  user: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
  bot_id: z.string().regex(/^B[A-Z0-9]+$/).optional(),
  bot_profile: z.object({ user_id: z.string().regex(/^[UW][A-Z0-9]+$/).optional() }).optional(),
  text: z.string().optional(),
  blocks: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
  files: z.array(z.object({ title: z.string().optional(), name: z.string().optional() })).optional(),
});

const slackText = z.object({ type: z.enum(["mrkdwn", "plain_text"]), text: z.string() });
const richLine = z.object({
  type: z.enum(["rich_text_section", "rich_text_quote", "rich_text_preformatted"]),
  elements: z.array(z.object({ type: z.string(), text: z.string().optional(), url: z.string().optional() })),
});
const readableBlock = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["section", "header"]), text: slackText.optional(), fields: z.array(slackText).optional() }),
  z.object({ type: z.literal("rich_text"), elements: z.array(z.union([
    richLine, z.object({ type: z.literal("rich_text_list"), elements: z.array(richLine) }),
  ])) }),
]);
const attachment = z.object({
  text: z.string().optional(), fallback: z.string().optional(), blocks: z.array(z.unknown()).optional(),
});

function blockText(value: unknown): string {
  const block = readableBlock.safeParse(value);
  if (!block.success) return "";
  const data = block.data;
  if (data.type !== "rich_text") {
    return [data.text?.text, ...(data.fields ?? []).map(field => field.text)].filter(Boolean).join("\n");
  }
  const lines = data.elements.flatMap(part => part.type === "rich_text_list" ? part.elements : [part]);
  return lines.map(line => line.elements.map(element => {
    if (element.type === "text") return element.text;
    if (element.type === "link") return element.text || element.url;
    return "";
  }).join("")).filter(Boolean).join("\n");
}

function messageText(message: z.infer<typeof conversationMessage>): string {
  if (message.text) return message.text;
  const parts = (message.blocks ?? []).map(blockText);
  for (const item of message.attachments ?? []) {
    const parsed = attachment.safeParse(item);
    if (!parsed.success) continue;
    const { blocks, text, fallback } = parsed.data;
    parts.push((blocks ?? []).map(blockText).filter(Boolean).join("\n") || text || fallback || "");
  }
  const visible = parts.filter(Boolean).join("\n");
  if (visible) return visible;
  const fileNames = message.files?.map(file => file.title || file.name || "file").join(", ");
  return fileNames ? `[file] ${fileNames}` : "";
}

export async function fetchThreadHistory(options: Options): Promise<ThreadMessage[]> {
  const { channel, threadTs, after, before, signal } = options;
  signal.throwIfAborted();
  const oldest = after && compareSlackTs(after, threadTs) > 0 ? after : threadTs;
  if (compareSlackTs(oldest, before) >= 0) return [];
  const blocked = new Set(options.blockedUsers);
  blocked.add("USLACKBOT");
  const messages = new Map<string, ThreadMessage>();
  const pages = readMessages({ ...options, window: { oldest, latest: before } },
    { channel, threadTs, requireThread: true });
  for await (const row of pages) {
    // Slack can include the parent even outside the requested window. The trigger is sent separately.
    if (compareSlackTs(row.ts, oldest) < 0 || compareSlackTs(row.ts, before) >= 0 ||
        (after !== null && compareSlackTs(row.ts, after) <= 0)) continue;
    if ((row.channel !== undefined && row.channel !== channel) ||
        (row.thread_ts && compareSlackTs(row.thread_ts, threadTs) !== 0)) continue;
    const parsed = conversationMessage.safeParse(row);
    if (!parsed.success) continue;
    const { user, bot_profile, bot_id } = parsed.data;
    const author = user ?? bot_profile?.user_id ?? bot_id;
    if (!author || blocked.has(author) || (bot_profile?.user_id && blocked.has(bot_profile.user_id))) continue;
    const body = messageText(parsed.data);
    if (body) messages.set(row.ts, { ts: row.ts, user: author, text: redactCredentials(body) });
  }
  // readMessages also serves recovery, which intentionally allows an aborted scan to return early.
  signal.throwIfAborted();
  return [...messages.values()].sort((a, b) => compareSlackTs(a.ts, b.ts));
}
