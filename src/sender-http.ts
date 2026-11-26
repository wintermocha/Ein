import { createHash } from "node:crypto";
import ky, { type KyInstance } from "ky";
import { z } from "zod";
import type { DeliverySettlement, OutgoingDelivery } from "./delivery-store";
import { redactCredentials } from "./redaction";

export type SenderConnection = {
  readonly botToken: string;
  readonly botUser: string;
  readonly signal: AbortSignal;
  readonly http?: KyInstance;
};

const timestamp = z.string().regex(/^\d{1,12}\.\d{6}$/);
const apiFailure = z.object({ ok: z.literal(false), error: z.string() });
const postReceipt = z.object({ ok: z.literal(true), channel: z.string(), ts: timestamp });
const slackPage = z.object({
  ok: z.literal(true),
  messages: z.array(z.object({
    ts: timestamp, user: z.string().optional(), thread_ts: z.string().optional(), metadata: z.unknown().optional(),
  })),
  has_more: z.boolean().optional(),
  is_limited: z.boolean().optional(),
  response_metadata: z.object({ next_cursor: z.string().nullish() }).optional(),
});
const receiptHashDomains = {
  ein_delivery: "ein-delivery-v1\0",
  hogu_delivery: "hogu-delivery-v1\0",
} as const;
const deliveryMetadata = z.object({
  event_type: z.enum(["ein_delivery", "hogu_delivery"]),
  event_payload: z.object({ delivery_id: z.string() }),
});
const permanentErrors = new Set([
  "not_authed", "invalid_auth", "account_inactive", "token_expired", "token_revoked",
  "missing_scope", "not_allowed_token_type", "channel_not_found", "not_in_channel",
  "no_permission", "access_denied", "restricted_action", "thread_not_found", "is_archived",
  "invalid_arguments", "invalid_metadata", "msg_too_long", "no_text", "invalid_cursor",
]);
const endpoint = "https://slack.com/api/";

function connection(options: SenderConnection) {
  return {
    headers: { Authorization: `Bearer ${options.botToken}` },
    retry: 0, timeout: 15_000, throwHttpErrors: false, redirect: "error" as const,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
  };
}

function marker(id: string, hashDomain: string): string {
  // Slack metadata is visible to others. The queue ID can include inbound identifiers.
  return createHash("sha256").update(hashDomain).update(id).digest("hex");
}

function throttled(delivery: OutgoingDelivery, response: Response): DeliverySettlement {
  const raw = response.headers.get("retry-after");
  const seconds = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 60;
  const at = Date.now() + Math.max(1, seconds) * 1_000;
  if (!Number.isSafeInteger(at)) return { kind: "held", reason: "invalid_retry_after" };
  if (delivery.mode === "send") return { kind: "retry", at };
  return { kind: "uncertain", at, ...(delivery.cursor ? { cursor: delivery.cursor } : {}), readLimited: true };
}

function retryRead(cursor?: string): DeliverySettlement {
  return { kind: "uncertain", at: Date.now() + 60_000, ...(cursor ? { cursor } : {}) };
}

function checkApiFailure(raw: unknown, delivery: OutgoingDelivery, response: Response): DeliverySettlement | undefined {
  const failure = apiFailure.safeParse(raw);
  if (!failure.success) return;
  const code = failure.data.error;
  if (code === "ratelimited" || code === "rate_limited") return throttled(delivery, response);
  // Only preselected diagnostic strings reach SQLite or the operator.
  if (permanentErrors.has(code)) return { kind: "held", reason: code };
  if (delivery.mode === "reconcile") {
    if (["internal_error", "fatal_error", "request_timeout", "service_unavailable"].includes(code)) {
      return retryRead(delivery.cursor);
    }
    return { kind: "held", reason: "history_api_error" };
  }
  return { kind: "uncertain", at: Date.now() + 5_000 };
}

export async function postDelivery(options: SenderConnection, delivery: OutgoingDelivery): Promise<DeliverySettlement> {
  const http = options.http ?? ky;
  try {
    const response = await http.post(endpoint + "chat.postMessage", {
      ...connection(options),
      json: {
        channel: delivery.channel, text: redactCredentials(delivery.text),
        ...(delivery.threadTs ? { thread_ts: delivery.threadTs } : {}),
        metadata: {
          event_type: "ein_delivery",
          event_payload: { delivery_id: marker(delivery.id, receiptHashDomains.ein_delivery) },
        },
      },
    });
    if (response.status === 429) {
      await response.body?.cancel();
      return throttled(delivery, response);
    }
    if (response.ok) {
      const raw: unknown = await response.json();
      const failure = checkApiFailure(raw, delivery, response);
      if (failure) return failure;
      const receipt = postReceipt.safeParse(raw);
      if (receipt.success && receipt.data.channel === delivery.channel) return { kind: "sent", ts: receipt.data.ts };
    } else {
      await response.body?.cancel();
    }
  } catch {
    // The server may have committed even if an abort, timeout or disconnect hid its receipt.
  }
  return { kind: "uncertain", at: Date.now() + 5_000 };
}

export async function reconcileDelivery(options: SenderConnection, delivery: OutgoingDelivery): Promise<DeliverySettlement> {
  const http = options.http ?? ky;
  const method = delivery.threadTs ? "conversations.replies" : "conversations.history";
  const query = new URLSearchParams({
    channel: delivery.channel, include_all_metadata: "true", limit: "100",
    oldest: (Math.max(0, delivery.createdAt - 300_000) / 1_000).toFixed(6), inclusive: "true",
  });
  if (delivery.threadTs) query.set("ts", delivery.threadTs);
  const visited = new Set<string>();
  let cursor = delivery.cursor;
  try {
    while (!options.signal.aborted) {
      if (cursor) {
        query.set("cursor", cursor);
        visited.add(cursor);
      }
      const response = await http.get(endpoint + method, { ...connection(options), searchParams: query });
      const pageTarget = { ...delivery, ...(cursor ? { cursor } : {}) };
      if (response.status === 429) {
        await response.body?.cancel();
        return throttled(pageTarget, response);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 401, 403, 404, 405].includes(response.status)) {
          return { kind: "held", reason: `history_http_${response.status}` };
        }
        return retryRead(cursor);
      }
      const raw: unknown = await response.json();
      const failure = checkApiFailure(raw, pageTarget, response);
      if (failure) return failure;
      const parsed = slackPage.safeParse(raw);
      if (!parsed.success) return { kind: "held", reason: "invalid_history_response" };
      const page = parsed.data;
      for (const message of page.messages) {
        const parent = message.thread_ts === message.ts ? null : message.thread_ts ?? null;
        if (message.user !== options.botUser || parent !== delivery.threadTs) continue;
        const metadata = deliveryMetadata.safeParse(message.metadata);
        if (metadata.success && metadata.data.event_payload.delivery_id === marker(
          delivery.id, receiptHashDomains[metadata.data.event_type],
        )) {
          return { kind: "sent", ts: message.ts };
        }
      }
      const next = page.response_metadata?.next_cursor;
      if (page.is_limited || (!next && page.has_more) || (next && visited.has(next))) {
        return { kind: "held", reason: "incomplete_history" };
      }
      if (!next) return { kind: "held", reason: "delivery_unconfirmed" };
      // Yield between batches so an old, busy thread cannot monopolize all outgoing traffic.
      if (visited.size >= 3) return { kind: "uncertain", at: Date.now() + 1_000, cursor: next };
      cursor = next;
    }
  } catch {
    // A failed read is safe to repeat from this page. A second write is unsafe.
  }
  return retryRead(cursor);
}
