import { installLocalSlack } from "./cli-slack-wire";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sandbox = process.env["FIXTURE_ROOT"]!;
const phase = process.env["FIXTURE_PHASE"]!;
const url = "wss://orchestrate.invalid/";
const channel = "CPROJECT";
const rootTs = "1000000000.000001";

function log(name: string, value: unknown) {
  appendFileSync(join(sandbox, name), JSON.stringify(value) + "\n");
}

async function localSlack(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname, origin, searchParams } = new URL(request.url);
  if (origin !== "https://slack.com") throw Error("Unexpected fixture HTTP origin");
  switch (pathname) {
    case "/api/auth.test": return Response.json({ ok: true, team_id: "TTEST", user_id: "UBOT" });
    case "/api/apps.connections.open": return Response.json({ ok: true, url });
    case "/api/conversations.history": return Response.json({ ok: true, messages: [] });
    case "/api/conversations.replies": {
      if (searchParams.get("include_all_metadata") !== "true") return Response.json({ ok: true, messages: [] });
      log("reconciled.jsonl", [searchParams.get("channel"), searchParams.get("ts")]);
      const posted = JSON.parse(readFileSync(join(sandbox, "posts.jsonl"), "utf8").trimEnd().split("\n")[0]!);
      const inWindow = Number(posted.ts) >= Number(searchParams.get("oldest"));
      return Response.json({ ok: true, messages: inWindow ? [
        { ts: posted.ts, user: "UBOT", thread_ts: posted.thread_ts, metadata: posted.metadata },
      ] : [] });
    }
    case "/api/chat.postMessage": {
      const body = request.headers.get("content-type")?.includes("application/json")
        ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
      const ts = (Date.now() / 1_000).toFixed(6);
      log("posts.jsonl", { ...body, ts });
      // Slack accepted the message, but the process never sees the response.
      if (phase === "recover") process.exit(43);
      setImmediate(() => process.kill(process.pid, "SIGTERM"));
      return Response.json({ ok: true, channel, ts });
    }
    default: throw Error("Unexpected fixture Slack method");
  }
}

installLocalSlack({
  url,
  fetch: localSlack,
  connected(receive) {
    receive({ type: "hello", connection_info: { app_id: "AEIN" } });
    if (phase === "recover") return; // The first delivery was acknowledged before the crash.
    const event = (id: string, message: unknown) => receive({
      type: "events_api", envelope_id: id,
      payload: { type: "event_callback", api_app_id: "AEIN", team_id: "TTEST", event: message },
    });
    const root = { type: "app_mention", channel, ts: rootTs, user: "UOWNER", text: "<@UBOT> project:ein summarize the project" };
    event("root", root);
    if (phase === "followup") {
      event("overlap", { ...root, type: "message" });
      event("reply", { ...root, ts: "1000000002.000001", thread_ts: rootTs, text: "<@UBOT> what changed since then?" });
    }
  },
  acknowledged(id) {
    log("acks.jsonl", [phase, id]);
    if (phase === "crash") process.exit(42);
  },
});
