import { installLocalSlack } from "./cli-slack-wire";

const socketUrl = "wss://socket.invalid/";
const delivery = process.env["LOCAL_DELIVERY"];

async function localFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { origin, pathname } = new URL(request.url);
  if (origin !== "https://slack.com") throw new TypeError("Unexpected test request");
  switch (pathname) {
    case "/api/auth.test":
      return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT" });
    case "/api/apps.connections.open":
      return Response.json({ ok: true, url: socketUrl });
    case "/api/conversations.history":
    case "/api/conversations.replies":
      return Response.json({ ok: true, messages: [] });
    default:
      throw new TypeError("Unexpected Slack method");
  }
}

installLocalSlack({
  url: socketUrl,
  fetch: localFetch,
  connected(receive) {
    receive({ type: "hello", connection_info: { app_id: "AEIN" } });
    // After a successful ACK Slack need not redeliver. The second process must drain its database.
    const event = delivery === "resume" ? { type: "unhandled" } : {
      type: "message", ts: "1000000000.000001", channel: "DTEST", user: "UOWNER", text: "hello",
    };
    receive({ type: "events_api", envelope_id: "E1", payload: {
      type: "event_callback", api_app_id: "AEIN", team_id: "TTEST", event,
    } });
  },
  acknowledged(id) {
    if (id !== "E1") throw new Error("Unexpected acknowledgment");
    if (delivery === "crash") process.exit(42);
    setImmediate(() => process.kill(process.pid, "SIGTERM"));
  },
});
