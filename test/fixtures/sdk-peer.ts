import { setTimeout as delay } from "node:timers/promises";
import type { ServerWebSocket } from "bun";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type HistoryMethod = "conversations.history" | "conversations.replies";
type PeerOptions = {
  readonly appId?: string;
  readonly afterHello?: unknown;
  readonly onAck?: (id: string, connection: number) => void;
  readonly onPost?: (request: Request) => Promise<Response>;
  readonly onHistory?: (method: HistoryMethod, params: URLSearchParams) =>
    Record<string, unknown> | Promise<Record<string, unknown>>;
};

function servePeer(options: PeerOptions, caFile: string, key: string, cleanup: () => void) {
  const acks: { id: string; connection: number }[] = [];
  const calls: { method: string; params: URLSearchParams }[] = [];
  const sockets = new Map<number, ServerWebSocket<number>>();
  const pings: number[] = [];
  const pongs: number[] = [];
  let connections = 0;
  let nextConnection = 1;
  const server = Bun.serve<number>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: readFileSync(caFile, "utf8"), key: readFileSync(key, "utf8") },
    async fetch(req, server) {
      const url = new URL(req.url);
      if (url.pathname === "/ws" && server.upgrade(req, { data: nextConnection++ })) return;
      const method = url.pathname.replace(/^\/api\//, "");
      calls.push({ method, params: url.searchParams });
      switch (method) {
        case "apps.connections.open":
          return Response.json({ ok: true, url: `wss://127.0.0.1:${server.port}/ws` });
        case "auth.test":
          return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT" });
        case "chat.postMessage":
          if (options.onPost) return options.onPost(req);
          return Response.json({ ok: false, error: "missing_scope" });
        case "conversations.history":
        case "conversations.replies":
          return Response.json(await options.onHistory?.(method, url.searchParams) ?? { ok: true, messages: [] });
        default:
          return Response.json({ ok: false, error: "unknown_method" }, { status: 404 });
      }
    },
    websocket: {
      sendPings: false,
      idleTimeout: 0,
      open(ws) {
        connections++;
        sockets.set(ws.data, ws);
        ws.send(JSON.stringify({ type: "hello", connection_info: { app_id: options.appId ?? "AEIN" } }));
        if (options.afterHello !== undefined) ws.send(JSON.stringify(options.afterHello));
      },
      message(ws, bytes) {
        const { envelope_id: id } = JSON.parse(bytes.toString());
        if (typeof id !== "string") throw new Error("Expected an envelope acknowledgment");
        acks.push({ id, connection: ws.data });
        options.onAck?.(id, ws.data);
      },
      ping(ws) { pings.push(ws.data); },
      pong(ws) { pongs.push(ws.data); },
      close(ws) {
        sockets.delete(ws.data);
      },
    },
  });

  function socket(connection: number) {
    const ws = sockets.get(connection);
    if (!ws) throw new Error(`Test Slack connection ${connection} is not open`);
    return ws;
  }
  return {
    apiUrl: new URL("/api/", server.url).href,
    caFile,
    get connections() { return connections; },
    acks, calls, pings, pongs,
    send(connection: number, frame: unknown) { socket(connection).send(JSON.stringify(frame)); },
    ping(connection: number) { socket(connection).ping("slack-sdk-test"); },
    drop(connection: number) { socket(connection).terminate(); },
    async stop() {
      try {
        await server.stop(true);
      } finally {
        cleanup();
      }
    },
  };
}

/** The child trusts this test server only. The test never changes system trust. */
export function startPeerTLS(options: PeerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ein-sdk-cert-"));
  const caFile = join(dir, "peer.pem");
  const key = join(dir, "key.pem");
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=Ein test peer", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", caFile],
    { stdio: "ignore" });
    return servePeer(options, caFile, key, cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await delay(10);
  }
}
