import { channel } from "node:diagnostics_channel";
import { setTimeout as delay } from "node:timers/promises";
import { LogLevel, SocketModeClient, type Logger, type SocketModeOptions } from "@slack/socket-mode";
import { z } from "zod";
import { SocketFailure, SocketSession, type SocketEnvelope, type SocketOptions } from "./socket-session";

export { SocketFailure } from "./socket-session";

type SdkFetch = NonNullable<NonNullable<SocketModeOptions["clientOptions"]>["fetch"]>;
type SocketIO = {
  fetch?: SdkFetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
};
type Outcome = { reason: string; failure?: SocketFailure; retryAfter?: number };

const configurationErrors = new Set([
  "invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive",
  "missing_scope", "not_allowed_token_type", "app_not_found", "feature_not_enabled",
  "socket_mode_disabled",
]);
const secureUrl = z.url({ protocol: /^wss$/ });
const metadata = z.object({
  type: z.string(),
  reason: z.string().optional(),
  connection_info: z.unknown().optional(),
});
const apiError = z.object({
  code: z.string(), retryAfter: z.number().nonnegative().optional(),
  data: z.object({ error: z.string() }).optional(), statusCode: z.number().optional(),
});
const pong = z.object({ websocket: z.object({ url: z.string() }), payload: z.instanceof(Buffer) });
const pongChannel = channel("undici:websocket:pong");

// SDK diagnostics can contain signed connection URLs and entire Slack frames.
const silent: Logger = {
  setName() {}, setLevel() {}, getLevel: () => LogLevel.ERROR,
  debug() {}, info() {}, warn() {}, error() {},
};

class InvalidSocketUrl extends Error {}

function startupIssue(error: unknown): Outcome {
  if (error instanceof InvalidSocketUrl) return { reason: "invalid_slack_response" };
  const parsed = apiError.safeParse(error);
  if (parsed.success) {
    const { code, data, retryAfter, statusCode } = parsed.data;
    if (code === "slack_webapi_rate_limited_error") {
      return { reason: "slack_rate_limited", retryAfter: (retryAfter ?? 60) * 1000 };
    }
    if (data && configurationErrors.has(data.error)) {
      return { reason: "slack_auth_error", failure: new SocketFailure(`Slack apps.connections.open: ${data.error}`) };
    }
    if (statusCode === 401 || statusCode === 403) {
      return { reason: "slack_auth_error", failure: new SocketFailure("Slack rejected the app token or its connections:write scope") };
    }
  }
  return { reason: "slack_connection_failed" };
}

/** The SDK's connected event omits raw hello.connection_info. Check it before allowing
 * the SDK to announce readiness or dispatch any envelope to Ein's durable intake. */
class EinSocketClient extends SocketModeClient {
  constructor(settings: SocketModeOptions, private readonly intake: SocketSession) {
    super(settings);
  }

  protected override async onWebSocketMessage(...args: Parameters<SocketModeClient["onWebSocketMessage"]>) {
    const [data, binary] = args;
    if (binary || typeof data !== "string") return this.intake.finish("invalid_socket_frame");
    let parsed;
    try { parsed = metadata.safeParse(JSON.parse(data)); }
    catch { return this.intake.finish("invalid_socket_frame"); }
    if (!parsed.success) return this.intake.finish("invalid_socket_frame");
    const { type, reason, connection_info } = parsed.data;
    if (type === "hello" && !this.intake.hello(connection_info)) return;
    if (type === "disconnect" && reason === "link_disabled") {
      return this.intake.finish("link_disabled", new SocketFailure("Slack Socket Mode is disabled"));
    }
    try { await super.onWebSocketMessage(...args); }
    catch { this.intake.finish("invalid_socket_frame"); }
  }
}

async function connect(options: SocketOptions, io: SocketIO): Promise<Outcome & { ready: boolean }> {
  const ended = Promise.withResolvers<Outcome>();
  const network = new AbortController();
  const signal = AbortSignal.any([network.signal, options.signal]);
  const intake = new SocketSession(options, (reason, failure) => ended.resolve(
    failure ? { reason, failure } : { reason },
  ));
  const client = new EinSocketClient({
    appToken: options.appToken, logger: silent, clientPingTimeout: 15_000,
    // Ein opens one client per recovery window, including on Slack's requested rotation.
    autoReconnectEnabled: false,
    clientOptions: {
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 15_000,
      fetch: (url, init) => (io.fetch ?? globalThis.fetch)(url, { ...init, redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]) }),
    },
  }, intake);
  let ready = false;
  let activeUrl: string | undefined;
  let helloDeadline: ReturnType<typeof setTimeout> | undefined;
  client.on("authenticated", (result: { url?: unknown }) => {
    const parsed = secureUrl.safeParse(result.url);
    if (!parsed.success) throw new InvalidSocketUrl();
    activeUrl = new URL(parsed.data).href;
  });
  client.on("connecting", () => {
    helloDeadline = setTimeout(() => intake.finish("socket_hello_timeout"), 15_000);
  });
  client.on("connected", () => { clearTimeout(helloDeadline); ready = true; });
  client.on("disconnected", () => intake.finish("socket_disconnected"));
  client.on("slack_event", (event: SocketEnvelope) => { void intake.envelope(event); });
  // The SDK drives ping/pong. Only a pong from this signed connection can move
  // Ein's recovery cursor while idle; a timer alone cannot establish health.
  const onPong = (frame: unknown) => {
    const parsed = pong.safeParse(frame);
    if (ready && parsed.success && parsed.data.websocket.url === activeUrl) intake.heartbeat();
  };
  const stop = () => intake.finish("stopped");
  options.signal.addEventListener("abort", stop, { once: true });
  pongChannel.subscribe(onPong);
  try {
    if (options.signal.aborted) stop();
    else void client.start().catch(error => ended.resolve(startupIssue(error)));
    return { ...await ended.promise, ready };
  } finally {
    options.signal.removeEventListener("abort", stop);
    pongChannel.unsubscribe(onPong);
    clearTimeout(helloDeadline);
    network.abort();
    intake.close();
    await client.disconnect();
  }
}

export async function listenSocket(options: SocketOptions, io: SocketIO = {}): Promise<void> {
  let backoff = 1_000;
  while (!options.signal.aborted) {
    const result = await connect(options, io);
    if (result.failure) throw result.failure;
    if (options.signal.aborted) return;
    if (result.ready) backoff = 1_000;
    options.onIssue(result.reason);
    const ms = Math.max(result.retryAfter ?? 0, backoff);
    try {
      if (io.wait) await io.wait(ms, options.signal);
      else await delay(ms, undefined, { signal: options.signal });
    } catch (error) {
      if (options.signal.aborted) return;
      throw error;
    }
    backoff = Math.min(60_000, backoff * 2);
  }
}
