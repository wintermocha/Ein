import { installLocalSlack } from "./cli-slack-wire";

const url = "wss://attached.invalid/";
const channel = "CPROJECT";
const rootTs = "1810000000.000001";
let sendEvent: ((id: string, event: object) => void) | undefined;
let posts = 0;

installLocalSlack({
  url,
  connected(receive) {
    receive({ type: "hello", connection_info: { app_id: "AEIN" } });
    sendEvent = (id, event) => receive({
      type: "events_api", envelope_id: id,
      payload: { type: "event_callback", api_app_id: "AEIN", team_id: "TTEST", event: { channel, ...event } },
    });
    sendEvent("outsider", { type: "app_mention", user: "UOTHER", ts: "1810000000.000000", text: "<@UBOT> other user's task" });
    sendEvent("root", { type: "app_mention", user: "UOWNER", ts: rootTs, text: process.env.FIXTURE_ROOT_TEXT ?? "<@UBOT> Stand by for the inventory." });
  },
  acknowledged(id) { process.send?.(id); },
  async fetch(input, init) {
    const request = new Request(input, init);
    const { origin, pathname } = new URL(request.url);
    if (origin !== "https://slack.com") throw new Error("Unexpected fixture HTTP origin");
    switch (pathname) {
      case "/api/auth.test": return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT" });
      case "/api/apps.connections.open": return Response.json({ ok: true, url });
      case "/api/conversations.history":
      case "/api/conversations.replies": return Response.json({ ok: true, messages: [] });
      case "/api/chat.postMessage": {
        const body = await request.json();
        process.send?.({ channel: body.channel, thread: body.thread_ts, text: body.text });
        posts++;
        const ts = (1810000000 + posts).toFixed(6);
        if (posts <= 2) {
          const text = posts === 1 ? "Count ready items" : "Confirm the handoff";
          sendEvent?.("followup-" + posts, { type: "message", user: "UOWNER", ts, thread_ts: rootTs, text });
        }
        return Response.json({ ok: true, channel, ts: (1810000020 + posts).toFixed(6) });
      }
      default: throw new Error("Unexpected fixture Slack method");
    }
  },
});
