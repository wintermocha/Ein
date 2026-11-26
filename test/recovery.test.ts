import { expect, test } from "bun:test";
import ky from "ky";
import { recover } from "../src/recovery";

const window = { oldest: "1800000000.000000", latest: "1800000005.000000" };
const at = (second: number) => `180000000${second}.000001`;
const message = (ts: string, extra = {}) => ({ ts, text: "hi", user: "U01", ...extra });
const page = (messages: readonly unknown[], next = "") =>
  Response.json({ ok: true, messages, response_metadata: { next_cursor: next } });

function setup(respond: (url: URL, request: Request) => Response) {
  const requests: URL[] = [];
  const events: unknown[] = [];
  const issues: string[] = [];
  const controller = new AbortController();
  const http = ky.create({
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      requests.push(url);
      return respond(url, request);
    },
  });
  const options = {
    botToken: "test-credential",
    signal: controller.signal,
    channels: ["D01"],
    threads: [],
    window,
    http,
    onIssue: (reason: string) => { issues.push(reason); },
    onEvent: (event: unknown) => { events.push(event); },
  };
  return { requests, events, issues, options, controller };
}

test("reads all history and reply pages, discovers parents and adds DM context", async () => {
  const setupRun = setup((url, request) => {
    expect(url.origin).toBe("https://slack.com");
    expect(request.headers.get("authorization")).toBe("Bearer test-credential");
    expect(url.searchParams.get("oldest")).toBe(window.oldest);
    expect(url.searchParams.get("latest")).toBe(window.latest);
    const cursor = url.searchParams.get("cursor");
    if (url.pathname.endsWith("history")) {
      return cursor === null ? page([message(at(2), { reply_count: 1 })], "h2") : page([message(at(1))]);
    }
    expect(url.searchParams.get("ts")).toBe(at(2));
    return cursor === null ? page([message(at(2)), message(at(3))], "r2") : page([message(at(4))]);
  });
  expect(await recover(setupRun.options)).toBe(true);
  expect(setupRun.requests).toHaveLength(4);
  expect(setupRun.events).toEqual([1, 2, 3, 4].map(n => expect.objectContaining({ ts: at(n) })));
  expect(setupRun.events).toContainEqual(expect.objectContaining({ channel: "D01", channel_type: "im", ts: at(3), thread_ts: at(2) }));
  expect(setupRun.issues).toBeEmpty();
});

test("fetches a known old thread even if its root is absent from history", async () => {
  const old = "1700000000.000001";
  const run = setup(url => url.pathname.endsWith("history") ? page([]) : page([message(old), message(at(4))]));
  expect(await recover({ ...run.options, threads: [{ channel: "D01", threadTs: old }] })).toBe(true);
  expect(run.events).toEqual([expect.objectContaining({ ts: at(4), thread_ts: old })]);
});

test("finishes a gap after a deleted root and still reads the next known thread", async () => {
  const old = "1700000000.000001";
  const active = "1700000001.000002";
  const run = setup(url => {
    if (url.pathname.endsWith("history")) return page([]);
    if (url.searchParams.get("ts") === old) return Response.json({ ok: false, error: "thread_not_found" });
    return page([message(at(1))]);
  });
  const threads = [old, active].map(threadTs => ({ channel: "D01", threadTs }));
  expect(await recover({ ...run.options, threads })).toBe(true);
  expect(run.events).toEqual([expect.objectContaining({ ts: at(1), thread_ts: active })]);
  expect(run.issues).toBeEmpty();
});

test("retains a gap on thread_not_found when it did not request a thread", async () => {
  const run = setup(() => Response.json({ ok: false, error: "thread_not_found" }));
  expect(await recover(run.options)).toBe(false);
});

test("leaves the checkpoint pending while continuing independent channels on missing scope", async () => {
  const run = setup(url => url.searchParams.get("channel")?.startsWith("C")
    ? Response.json({ ok: false, error: "missing_scope", detail: "SECRET-DATA" })
    : page([message(at(1))]));
  expect(await recover({ ...run.options, channels: ["C01", "C02", "D01", "C02"] })).toBe(false);
  expect(run.issues).toHaveLength(2);
  expect(run.issues).toContainEqual(expect.stringMatching(/missing_scope.*C01/));
  expect(run.issues).toContainEqual(expect.stringMatching(/missing_scope.*C02/));
  expect(run.issues.join(" ")).not.toContain("SECRET-DATA");
  expect(run.events).toHaveLength(1);
});

test("keeps untrusted content out of permission diagnostics", async () => {
  const run = setup(() => Response.json({ ok: false, error: "channel_not_found" }));
  expect(await recover({ ...run.options, channels: ["C01\nsecret"] })).toBe(false);
  expect(run.issues).toHaveLength(1);
  expect(run.issues[0]).not.toContain("secret");
});

test.each([
  { ok: true, messages: {} },
  { ok: true, messages: [{ text: "missing timestamp" }] },
  { ok: true, messages: [], has_more: true },
  { ok: true, messages: [], response_metadata: { next_cursor: "again" } },
])("reports malformed or stalled pagination as incomplete", async body => {
  const run = setup(() => Response.json(body));
  expect(await recover(run.options)).toBe(false);
  expect(run.requests.length).toBeLessThanOrEqual(2);
  expect(run.issues).toHaveLength(1);
});

test("retries the same page after Slack returns HTTP 429", async () => {
  let limited = true;
  const run = setup(() => {
    if (limited) {
      limited = false;
      return new Response(null, { status: 429, headers: { "retry-after": "0" } });
    }
    return page([message(at(1))]);
  });
  expect(await recover(run.options)).toBe(true);
  expect(run.requests).toHaveLength(2);
  expect(run.events).toHaveLength(1);
});

test("stops the recovery scan on cancellation without advancing its checkpoint", async () => {
  const run = setup(() => page([]));
  run.controller.abort();
  expect(await recover(run.options)).toBe(false);
  expect(run.requests).toBeEmpty();
  expect(run.issues).toBeEmpty();
});

test("cancels a Slack rate-limit wait without polling more targets", async () => {
  const requested = Promise.withResolvers<void>();
  const run = setup(() => {
    requested.resolve();
    return new Response(null, { status: 429, headers: { "retry-after": "600" } });
  });
  const pending = recover({ ...run.options, channels: ["D01", "D02"] });
  await requested.promise;
  run.controller.abort();
  expect(await pending).toBe(false);
  expect(run.requests).toHaveLength(1);
  expect(run.issues).toBeEmpty();
});

test("does not probe every thread of a channel after Slack rejects thread access", async () => {
  const run = setup(url => url.pathname.endsWith("history") ? page([]) : Response.json({ ok: false, error: "missing_scope" }));
  const threads = [1, 2, 3].map(n => ({ channel: "D01", threadTs: at(n) }));
  expect(await recover({ ...run.options, threads })).toBe(false);
  expect(run.requests.filter(url => url.pathname.endsWith("replies"))).toHaveLength(1);
});

test("propagates sink failures without claiming the checkpoint or mislabeling storage errors", async () => {
  const run = setup(() => page([message(at(1))]));
  const failure = new Error("fixture storage failure");
  await expect(recover({ ...run.options, onEvent: () => { throw failure; } })).rejects.toThrow(failure);
  expect(run.issues).toBeEmpty();
});
