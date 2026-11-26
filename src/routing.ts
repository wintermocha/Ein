import { z } from "zod";
import { redactCredentials } from "./redaction";

export type Policy = {
  readonly botUser: string;
  readonly ownerUser: string;
  readonly watchChannels: readonly string[];
  readonly blockedUsers: readonly string[];
  readonly otherUserReplyRate: Readonly<Record<string, number>>;
};

export type RoutingContext = {
  readonly ownsThread: (channel: string, threadTs: string) => boolean;
  readonly parentOf: (channel: string, ts: string) => string | undefined;
  readonly random: () => number;
};

type Thread = { readonly channel: string; readonly threadTs: string };
type Inbound = RecordFields & {
  readonly line: string;
  readonly recoverThread?: false;
  readonly allowReply: boolean;
};
export type RoutedEvent = {
  readonly track?: Thread & { readonly ts: string };
  readonly inbound?: Inbound;
};

const channelId = z.string().regex(/^[CDG][A-Z0-9]+$/);
const userId = z.string().regex(/^[UW][A-Z0-9]+$/);
const timestamp = z.string().regex(/^\d+\.\d{1,6}$/);
const messageSchema = z.object({
  type: z.enum(["message", "app_mention"]),
  channel: channelId,
  ts: timestamp,
  thread_ts: timestamp.optional(),
  parent_user_id: userId.optional(),
  user: userId.optional(),
  text: z.string().default(""),
  subtype: z.enum(["file_share", "thread_broadcast", "me_message", "bot_message"]).optional(),
  hidden: z.literal(false).optional(),
  bot_id: z.string().optional(),
  app_id: z.string().optional(),
  bot_profile: z.object({ user_id: userId.optional() }).optional(),
  files: z.array(z.object({ name: z.string().optional(), title: z.string().optional() })).optional(),
});
const reactionSchema = z.object({
  type: z.literal("reaction_added"),
  reaction: z.string().regex(/^[A-Za-z0-9_+:.-]+$/),
  event_ts: timestamp,
  item: z.object({ type: z.literal("message"), channel: channelId, ts: timestamp }),
  user: userId,
  item_user: userId.optional(),
});
const eventSchema = z.discriminatedUnion("type", [messageSchema, reactionSchema]);
type Message = z.infer<typeof messageSchema>;
type Reaction = z.infer<typeof reactionSchema>;

type RecordFields = Thread & {
  readonly source: "dm" | "dm-thread" | "mention" | "thread-mention" | "own-thread" | "reaction";
  readonly ts: string;
  readonly user: string;
  readonly text: string;
  readonly key: string;
};

function inbound(record: RecordFields, policy: Policy, context: RoutingContext): Inbound {
  const { channel, threadTs, ts, user, text, source } = record;
  const redacted = redactCredentials(text);
  const quoted = JSON.stringify(redacted).replace(
    /[\u0085\u2028\u2029]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const rate = policy.otherUserReplyRate[channel];
  const reply = user !== policy.ownerUser && rate !== undefined ? context.random() < rate : undefined;
  const tag = reply === undefined ? "" : reply ? " REPLY=yes" : " REPLY=no";
  const line = `INBOUND ${source} ${channel} ${threadTs} ${ts} ${user} ${quoted}${tag}`;
  return { ...record, text: redacted, line, allowReply: reply !== false };
}

function routeMessage(event: Message, policy: Policy, context: RoutingContext): RoutedEvent {
  const { channel, ts, user } = event;
  const threadTs = event.thread_ts ?? ts;
  if ((user ?? event.bot_profile?.user_id) === policy.botUser) {
    return { track: { channel, threadTs, ts } };
  }
  const botPost = event.bot_id || event.bot_profile || event.app_id || event.subtype === "bot_message";
  if (!user || user === "USLACKBOT" || botPost || policy.blockedUsers.includes(user)) return {};

  const reply = threadTs !== ts;
  const ownRoot = reply && event.parent_user_id === policy.botUser;
  const mention = event.type === "app_mention" ||
    [...event.text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^<>]+)?>/gu)].some((match) => match[1] === policy.botUser);
  let source: RecordFields["source"];
  if (channel.startsWith("D")) {
    source = reply ? "dm-thread" : "dm";
  } else if (mention && policy.watchChannels.includes(channel)) {
    source = reply ? "thread-mention" : "mention";
  } else if (reply && (ownRoot || context.ownsThread(channel, threadTs))) {
    source = "own-thread";
  } else {
    return {};
  }
  const fileNames = event.files?.map((file) => file.title || file.name || "file").join(", ");
  const text = event.text || (fileNames ? `[file] ${fileNames}` : "");
  const record = { source, channel, threadTs, ts, user, text, key: `m:${channel}:${ts}` };
  return {
    ...(ownRoot ? { track: { channel, threadTs, ts: threadTs } } : {}),
    inbound: inbound(record, policy, context),
  };
}

function routeReaction(event: Reaction, policy: Policy, context: RoutingContext): RoutedEvent {
  const { user, item, item_user, event_ts, reaction } = event;
  if (user === policy.botUser || user === "USLACKBOT" || policy.blockedUsers.includes(user)) return {};
  if (item_user !== undefined && item_user !== policy.botUser) return {};
  const parent = context.parentOf(item.channel, item.ts);
  const monitored = item.channel.startsWith("D") || policy.watchChannels.includes(item.channel);
  if (parent === undefined && (item_user !== policy.botUser || !monitored)) return {};
  const record: RecordFields = {
    source: "reaction",
    channel: item.channel,
    threadTs: parent ?? item.ts,
    ts: event_ts,
    user,
    text: `:${reaction}:`,
    key: `r:${item.channel}:${item.ts}:${user}:${reaction}:${event_ts}`,
  };
  const result = inbound(record, policy, context);
  return { inbound: parent === undefined ? { ...result, recoverThread: false } : result };
}

export function route(event: unknown, policy: Policy, context: RoutingContext): RoutedEvent {
  const parsed = eventSchema.safeParse(event);
  if (!parsed.success) return {};
  switch (parsed.data.type) {
    case "message":
    case "app_mention":
      return routeMessage(parsed.data, policy, context);
    case "reaction_added":
      return routeReaction(parsed.data, policy, context);
    default:
      return parsed.data satisfies never;
  }
}
