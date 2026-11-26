import { z } from "zod";

export type SocketOptions = {
  readonly appToken: string;
  readonly appId: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: unknown, team: string, authorizations: unknown) => void;
  readonly onRateLimited: (minute: number, team: string) => void;
  readonly onReady: () => void;
  readonly onDisconnected?: () => void;
  readonly onIssue: (reason: string) => void;
  readonly onHealthy: () => void;
};

export class SocketFailure extends Error {
  override readonly name = "SocketFailure";
}

const helloInfo = z.object({ app_id: z.string().min(1) });
const payloadType = z.object({ type: z.string(), api_app_id: z.string().nullish() });
const callback = z.object({
  team_id: z.string().nullish(),
  authorizations: z.unknown().optional(),
  event: z.looseObject({ type: z.string() }),
});
const rateLimit = z.object({
  minute_rate_limited: z.number().int().nonnegative(),
  team_id: z.string().min(1),
});

function dispatch(payload: unknown, options: SocketOptions): boolean {
  const tag = payloadType.safeParse(payload);
  if (!tag.success) return false;
  if (tag.data.api_app_id !== options.appId) return true;
  switch (tag.data.type) {
    case "event_callback": {
      const item = callback.safeParse(payload);
      if (!item.success) return false;
      if (item.data.team_id) options.onEvent(item.data.event, item.data.team_id, item.data.authorizations);
      return true;
    }
    case "app_rate_limited": {
      const notice = rateLimit.safeParse(payload);
      if (notice.success) options.onRateLimited(notice.data.minute_rate_limited, notice.data.team_id);
      return true;
    }
    default:
      return true;
  }
}

export type SocketEnvelope = {
  readonly type: string;
  readonly envelope_id: string;
  readonly body: unknown;
  readonly ack: () => Promise<void>;
};

export type EndSession = (reason: string, failure?: SocketFailure) => void;
const livenessGapMs = 45_000;

/** Ein's durable intake boundary. The SDK owns the WebSocket and the envelope's ack function. */
export class SocketSession {
  #ready = false;
  #closed = false;
  #lastActivity = 0;

  constructor(private readonly options: SocketOptions, private readonly end: EndSession) {}

  hello(info: unknown): boolean {
    if (this.#closed) return false;
    const parsed = helloInfo.safeParse(info);
    if (!parsed.success || parsed.data.app_id !== this.options.appId) {
      this.finish("app_id_mismatch", new SocketFailure("Check that the Slack app token matches the configured app ID"));
      return false;
    }
    if (this.#ready) return false;
    this.#ready = true;
    this.#lastActivity = Date.now();
    try {
      this.options.onReady();
      this.options.onHealthy();
      return true;
    } catch {
      this.finish("setup_failed", new SocketFailure("local receiver setup failed"));
      return false;
    }
  }

  async envelope({ type, envelope_id, body, ack }: SocketEnvelope): Promise<void> {
    if (this.#closed) return;
    if (!this.#ready || typeof envelope_id !== "string" || !envelope_id) return this.finish("invalid_socket_frame");
    if (type === "events_api") {
      try {
        if (!dispatch(body, this.options)) return this.finish("invalid_event_payload");
      } catch {
        return this.finish("processing_failed", new SocketFailure("local event processing failed"));
      }
    }
    // dispatch synchronously commits new work and dedup keys (or a rate-limit notice).
    // No async agent, recovery scan or stdout operation is awaited before acknowledging.
    try { await ack(); }
    catch { return this.finish("socket_ack_failed"); }
    if (!this.#closed && this.recordActivity()) this.finish("socket_liveness_gap");
  }

  heartbeat(): void {
    if (!this.#ready || this.#closed) return;
    if (this.recordActivity()) return this.finish("socket_liveness_gap");
    try { this.options.onHealthy(); }
    catch { this.finish("checkpoint_failed", new SocketFailure("local receiver checkpoint failed")); }
  }

  private recordActivity(): boolean {
    const now = Date.now();
    const gap = now < this.#lastActivity || now - this.#lastActivity > livenessGapMs;
    this.#lastActivity = now;
    return gap;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#ready) this.options.onDisconnected?.();
  }

  finish(reason: string, error?: SocketFailure): void {
    if (this.#closed) return;
    try { this.close(); }
    catch { error = new SocketFailure("local disconnect handling failed"); }
    this.end(reason, error);
  }
}
