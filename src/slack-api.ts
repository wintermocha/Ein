import { setTimeout as delay } from "node:timers/promises";
import ky, { type KyInstance } from "ky";
import { z } from "zod";

const timestamp = z.string().regex(/^\d{1,12}\.\d{6}$/);
const message = z.looseObject({
  ts: timestamp,
  type: z.string().default("message"),
  thread_ts: timestamp.optional(),
  reply_count: z.number().int().nonnegative().optional(),
});
const pageSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false), error: z.string() }),
  z.object({
    ok: z.literal(true),
    messages: z.array(message),
    has_more: z.boolean().optional(),
    is_limited: z.boolean().optional(),
    response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
  }),
]);
export type HistoryMessage = z.infer<typeof message>;
export type RecoveryWindow = { readonly oldest: string; readonly latest: string };
type Target = { readonly channel: string; readonly threadTs?: string; readonly requireThread?: boolean };
type WebOptions = {
  readonly botToken: string;
  readonly signal: AbortSignal;
  readonly window: RecoveryWindow;
  readonly http?: KyInstance;
};
type Method = "conversations.history" | "conversations.replies";

export class RecoveryIssue extends Error {
  override readonly name = "RecoveryIssue";
  constructor(method: Method, reason: string, readonly scope: "target" | "channel" | "scan" = "target") {
    super(`recovery ${method} ${reason}`);
  }
}

const accessErrors = new Set([
  "missing_scope", "not_in_channel", "channel_not_found",
  "no_permission", "access_denied", "restricted_action",
]);
const authErrors = new Set([
  "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive",
  "not_allowed_token_type", "ratelimited",
]);

async function readPage(options: WebOptions, method: Method, params: URLSearchParams) {
  const http = options.http ?? ky;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await http.get(`https://slack.com/api/${method}`, {
        headers: { Authorization: `Bearer ${options.botToken}` },
        searchParams: params,
        redirect: "error",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
        retry: 0,
        timeout: 15_000,
        throwHttpErrors: false,
      });
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : 60;
        await response.body?.cancel();
        if (seconds > 2_147_483) throw new RecoveryIssue(method, "invalid_retry_after", "scan");
        await delay(seconds * 1_000, undefined, { signal: options.signal });
        if (attempt >= 2) throw new RecoveryIssue(method, "ratelimited", "scan");
        continue;
      }
      if (!response.ok) throw new RecoveryIssue(method, `http_${response.status}`, "scan");
      const decoded = pageSchema.safeParse(await response.json());
      if (!decoded.success) throw new RecoveryIssue(method, "invalid_response");
      const page = decoded.data;
      if (!page.ok) {
        const reason = page.error;
        if (method === "conversations.replies" && reason === "thread_not_found") return undefined;
        if (accessErrors.has(reason)) throw new RecoveryIssue(method, reason, "channel");
        throw new RecoveryIssue(method, authErrors.has(reason) ? reason : "api_error", "scan");
      }
      return page;
    } catch (error) {
      if (error instanceof RecoveryIssue) throw error;
      if (error instanceof SyntaxError) throw new RecoveryIssue(method, "invalid_response");
      throw new RecoveryIssue(method, "unavailable", "scan");
    }
  }
}

export async function* readMessages(options: WebOptions, target: Target) {
  const method = target.threadTs ? "conversations.replies" : "conversations.history";
  const params = new URLSearchParams({
    channel: target.channel,
    ...options.window,
    inclusive: "true",
    limit: "100",
  });
  if (target.threadTs) params.set("ts", target.threadTs);
  const cursors = new Set<string>();
  while (!options.signal.aborted) {
    const page = await readPage(options, method, params);
    // Recovery can skip a deleted root. A turn requesting that thread needs to know it was unavailable.
    if (page === undefined) {
      if (target.requireThread) throw new RecoveryIssue(method, "thread_not_found");
      return;
    }
    yield* page.messages;
    if (page.is_limited) throw new RecoveryIssue(method, "history_limited");
    const next = page.response_metadata?.next_cursor;
    if (!next && !page.has_more) return;
    if (!next || cursors.has(next)) throw new RecoveryIssue(method, "incomplete_pagination");
    cursors.add(next);
    params.set("cursor", next);
  }
}
