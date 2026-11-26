import { expect, jest, test } from "bun:test";
import { listenSocket } from "../src/socket";
import { SocketSession, type SocketOptions } from "../src/socket-session";

const appId = "A01BOGRECVR";
const message = { type: "message", ts: "123.456789" };
const event = { type: "event_callback", api_app_id: appId, team_id: "T123", event: message };
const limited = {
  type: "app_rate_limited", api_app_id: appId, team_id: "T123", minute_rate_limited: 1_700_000_040,
};

function fixture(overrides: Partial<SocketOptions> = {}) {
  const activity: unknown[] = [];
  const end = jest.fn();
  const options: SocketOptions = {
    appToken: "xapp-offline", appId, signal: new AbortController().signal,
    onIssue: reason => { activity.push(["issue", reason]); },
    onReady: () => { activity.push("ready"); },
    onHealthy: () => { activity.push("healthy"); },
    onDisconnected: () => { activity.push("disconnected"); },
    onEvent: (body, team) => { activity.push(["message", team, body]); },
    onRateLimited: (minute, team) => { activity.push(["limited", team, minute]); },
    ...overrides,
  };
  const session = new SocketSession(options, end);
  const ack = jest.fn(async () => { activity.push("ack"); });
  function receive(body: unknown, type = "events_api") {
    return session.envelope({ body, type, envelope_id: "e1", ack });
  }
  function connect() {
    session.hello({ app_id: appId });
  }
  return { session, options, end, activity, ack, receive, connect };
}

test("delivers a Slack event and its team before invoking the SDK acknowledgment", async () => {
  const f = fixture();
  f.connect();
  await f.receive(event);
  expect(f.activity).toEqual(["ready", "healthy", ["message", "T123", message], "ack"]);
  expect(f.ack).toHaveBeenCalledTimes(1);
  expect(f.end).not.toHaveBeenCalled();
});

test.each([
  { description: "callback", body: event },
  { description: "rate-limit notice", body: limited },
])("does not acknowledge a $description after a storage error", async ({ body }) => {
  const failure = () => { throw new Error("private storage details"); };
  const f = fixture({ onEvent: failure, onRateLimited: failure });
  f.connect();
  await f.receive(body);
  expect(f.end).toHaveBeenCalledTimes(1);
  const error = f.end.mock.calls[0]?.[1];
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/local event processing failed/);
  expect(error.message).not.toContain("private");
  expect(f.ack).not.toHaveBeenCalled();
});

test.each([{ app_id: "AOTHER" }, undefined])("rejects a hello for a missing or different app", (info) => {
  const f = fixture();
  expect(f.session.hello(info)).toBe(false);
  expect(f.end).toHaveBeenCalledTimes(1);
  expect(f.end.mock.calls[0]?.[1]?.message).toContain("app ID");
  expect(f.activity).toEqual([]);
});

test("only accepts callbacks after their connection belongs to this Slack app", async () => {
  const f = fixture();
  await f.receive(event);
  expect(f.activity).toEqual([]);
});

test.each([
  { type: "event_callback", api_app_id: appId, event: message },
  { ...event, api_app_id: "AOTHER" },
  { ...limited, api_app_id: "AOTHER" },
  { ...limited, team_id: "" },
])("acknowledges filtered Slack envelopes without handing off their contents", async body => {
  const f = fixture();
  f.connect();
  await f.receive(body);
  expect(f.activity).toEqual(["ready", "healthy", "ack"]);
});

test("delivers the affected team and minute before acknowledging the rate-limit notice", async () => {
  const f = fixture();
  f.connect();
  await f.receive(limited);
  expect(f.activity).toEqual(["ready", "healthy", ["limited", "T123", 1_700_000_040], "ack"]);
});

test("a rejected acknowledgment does not dispatch the event a second time", async () => {
  const f = fixture();
  f.connect();
  const ack = jest.fn(async () => { throw Error("private socket credentials"); });
  await f.session.envelope({ body: event, type: "events_api", envelope_id: "a", ack });
  expect(f.activity).toEqual(["ready", "healthy", ["message", "T123", message], "disconnected"]);
  expect(ack).toHaveBeenCalledTimes(1);
  expect(f.end).toHaveBeenCalledTimes(1);
});

test("one accepted hello opens one recovery window; duplicate close calls end it once", () => {
  const f = fixture();
  f.connect();
  f.connect();
  f.session.close();
  f.session.close();
  expect(f.activity).toEqual(["ready", "healthy", "disconnected"]);
});

test("a heartbeat advances checkpoints only within a ready session", () => {
  const f = fixture();
  f.session.heartbeat();
  f.connect();
  f.session.heartbeat();
  f.session.close();
  f.session.heartbeat();
  expect(f.activity).toEqual(["ready", "healthy", "healthy", "disconnected"]);
});

test.each([91_000, 500])("a wall-clock jump to %d cannot advance a stale checkpoint", (now) => {
  jest.useFakeTimers({ now: 1_000 });
  try {
    const f = fixture();
    f.connect();
    jest.setSystemTime(now);
    f.session.heartbeat();
    expect(f.activity.filter(item => item === "healthy")).toHaveLength(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test("a returning event is stored after a long sleep without advancing the old checkpoint", async () => {
  jest.useFakeTimers({ now: 1_000 });
  try {
    const f = fixture();
    f.connect();
    jest.setSystemTime(91_000);
    await f.receive(event);
    expect(f.activity.filter(item => item === "healthy")).toHaveLength(1);
    expect(f.activity).toContainEqual(["message", "T123", message]);
    expect(f.ack).toHaveBeenCalledTimes(1);
    expect(f.end).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});

test("waits at least the connection API Retry-After before another attempt", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  const delays: number[] = [];
  let requests = 0;
  await listenSocket(f.options, {
    fetch: async () => {
      requests++;
      return new Response("", { status: 429, headers: { "Retry-After": "90" } });
    },
    wait: async ms => { delays.push(ms); controller.abort(); },
  });
  expect(requests).toBe(1);
  expect(delays).toHaveLength(1);
  expect(delays[0]).toBeGreaterThanOrEqual(90_000);
  expect(f.activity).toContainEqual(["issue", "slack_rate_limited"]);
});

test("reports a rejected app token without echoing Slack's response body", async () => {
  const f = fixture();
  const fetch = async () => Response.json({ ok: false, error: "invalid_auth", detail: "private detail" });
  await expect(listenSocket(f.options, { fetch })).rejects.toThrow(/^Slack apps.connections.open: invalid_auth$/);
});

test("rejects an insecure WebSocket URL from the connection API", async () => {
  const controller = new AbortController();
  const f = fixture({ signal: controller.signal });
  await listenSocket(f.options, {
    fetch: async () => Response.json({ ok: true, url: "ws://example.invalid/private" }),
    wait: async () => { controller.abort(); },
  });
  expect(f.activity).toContainEqual(["issue", "invalid_slack_response"]);
  expect(f.activity).not.toContain("ready");
});
