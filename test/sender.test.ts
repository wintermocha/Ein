import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ky from "ky";
import { DeliveryStore, type DeliverySettlement, type OutgoingDelivery } from "../src/delivery-store";
import { deliverNext, runSender } from "../src/sender";

const reply: OutgoingDelivery = {
  id: "question-1", channel: "C1", threadTs: "100.000001", text: "질문입니다.",
  mode: "send", createdAt: 200_000,
};
const posted = "201.000003";
type FakeRequest = (request: Request) => Response | Promise<Response>;

function fixture(delivery: OutgoingDelivery, respond: FakeRequest) {
  const outcomes: DeliverySettlement[] = [];
  const issues: string[] = [];
  const queue = {
    claimDelivery: () => delivery,
    settleDelivery: (id: string, result: DeliverySettlement) => {
      expect(id).toBe(delivery.id);
      outcomes.push(result);
    },
  };
  const controller = new AbortController();
  const options = {
    queue, botToken: "test-token", botUser: "Ubot", signal: controller.signal,
    http: ky.create({ fetch: async (input) => respond(new Request(input)) }),
    onIssue: (reason: string) => issues.push(reason),
  };
  return { options, outcomes, issues, controller };
}

test("posts to the original thread or top-level DM and records the acknowledged ts", async () => {
  for (const delivery of [reply, { ...reply, channel: "D1", threadTs: null }]) {
    const requests: Record<string, unknown>[] = [];
    const f = fixture(delivery, async request => {
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/api/chat.postMessage");
      expect(request.headers.get("authorization")).toBe("Bearer test-token");
      requests.push(await request.json() as Record<string, unknown>);
      return Response.json({ ok: true, channel: delivery.channel, ts: posted });
    });
    await deliverNext(f.options);
    const [body] = requests;
    expect(body?.channel).toBe(delivery.channel);
    expect(body?.text).toBe(delivery.text);
    expect(body?.thread_ts).toBe(delivery.threadTs ?? undefined);
    expect(body?.metadata).toEqual({
      event_type: "ein_delivery",
      event_payload: { delivery_id: "71abe31e793bcc3cd4e2eba2a3cf781a32e638facb414d783a35289200ee6b7c" },
    });
    expect(f.outcomes).toEqual([{ kind: "sent", ts: posted }]);
  }
});

test("an accepted POST with a lost response is found after restart using our metadata in the correct conversation", async () => {
  for (const threadTs of [reply.threadTs, null]) {
    let metadata: unknown;
    let writes = 0;
    const target = { ...reply, threadTs };
    const lost = fixture(target, async request => {
      writes++;
      metadata = (await request.json() as { metadata: unknown }).metadata;
      throw new TypeError("private contents must never appear in diagnostic output");
    });
    await deliverNext(lost.options);
    expect(lost.outcomes[0]?.kind).toBe("uncertain");
    const cursors: (string | null)[] = [];
    const restored = fixture({ ...target, mode: "reconcile" }, async request => {
      if (request.method === "POST") writes++;
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      expect(url.pathname).toBe(threadTs ? "/api/conversations.replies" : "/api/conversations.history");
      expect(url.searchParams.get("ts")).toBe(threadTs);
      expect(url.searchParams.get("include_all_metadata")).toBe("true");
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      const message = { ts: posted, user: "Ubot", thread_ts: threadTs ?? posted, metadata };
      if (cursor) return Response.json({ ok: true, messages: [message] });
      return Response.json({
        ok: true, response_metadata: { next_cursor: "page2" },
        messages: [
          { ...message, ts: "201.000001", user: "Uother" },
          { ...message, ts: "201.000002", thread_ts: "99.000003" },
          { ...message, ts: "201.000004", metadata: undefined, text: reply.text },
        ],
      });
    });
    await deliverNext(restored.options);
    expect(writes).toBe(1);
    expect(cursors).toEqual([null, "page2"]);
    expect(restored.outcomes).toEqual([{ kind: "sent", ts: posted }]);
    expect(lost.issues.join(" ")).not.toContain("private contents");
  }
});

test("reconciliation recognizes an immutable pre-rename receipt only with its legacy hash/type pair", async () => {
  const oldMarker = "4cddf39c238f31e8add81a3ee335fb32f295bfe5a04302be13584538cf31c28f";
  const newMarker = "71abe31e793bcc3cd4e2eba2a3cf781a32e638facb414d783a35289200ee6b7c";
  const f = fixture({ ...reply, mode: "reconcile" }, () => Response.json({
    ok: true,
    messages: [
      {
        ts: "201.000001", user: "Ubot", thread_ts: reply.threadTs,
        metadata: { event_type: "hogu_delivery", event_payload: { delivery_id: newMarker } },
      },
      {
        ts: "201.000002", user: "Ubot", thread_ts: reply.threadTs,
        metadata: { event_type: "ein_delivery", event_payload: { delivery_id: oldMarker } },
      },
      {
        ts: posted, user: "Ubot", thread_ts: reply.threadTs,
        metadata: { event_type: "hogu_delivery", event_payload: { delivery_id: oldMarker } },
      },
    ],
  }));

  await deliverNext(f.options);

  expect(f.outcomes).toEqual([{ kind: "sent", ts: posted }]);
});

test("ambiguous, denied or incomplete reconciliation holds the delivery without another POST", async () => {
  const pages = [
    { ok: true, messages: [] },
    { ok: false, error: "missing_scope" },
    { ok: true, has_more: true, messages: [] },
  ];
  for (const page of pages) {
    const methods: string[] = [];
    const f = fixture({ ...reply, mode: "reconcile" }, request => {
      methods.push(request.method);
      return Response.json(page);
    });
    await deliverNext(f.options);
    expect(methods).toEqual(["GET"]);
    expect(f.outcomes[0]?.kind).toBe("held");
  }
});

test("429 persists Retry-After separately for a rejected write or a throttled read", async () => {
  for (const mode of ["send", "reconcile"] as const) {
    let requests = 0;
    const f = fixture({ ...reply, mode }, () => {
      requests++;
      return new Response(null, { status: 429, headers: { "Retry-After": "45" } });
    });
    const start = Date.now();
    await deliverNext(f.options);
    const result = f.outcomes[0];
    expect(requests).toBe(1);
    expect(result?.kind).toBe(mode === "send" ? "retry" : "uncertain");
    if (result && "at" in result) expect(result.at).toBeGreaterThanOrEqual(start + 45_000);
  }
});

test("an invalid success response or a server error during POST leaves the outcome uncertain", async () => {
  for (const response of [
    new Response("confidential content", { status: 500 }),
    Response.json({ ok: true, ts: posted, channel: "wrong" }),
    Response.json({ ok: false, error: "fatal_error" }),
    Response.json({ ok: true }),
  ]) {
    const f = fixture(reply, () => response);
    await deliverNext(f.options);
    expect(f.outcomes[0]?.kind).toBe("uncertain");
    expect(f.issues.join(" ")).not.toContain("confidential");
    expect(f.issues.join(" ")).not.toContain(f.options.botToken);
  }
});

test("a throttled second GET persists the cursor and resumes from that page", async () => {
  const delivery = { ...reply, mode: "reconcile" as const };
  const seen: (string | null)[] = [];
  const f = fixture(delivery, request => {
    const cursor = new URL(request.url).searchParams.get("cursor");
    seen.push(cursor);
    if (cursor) return new Response(null, { status: 429, headers: { "retry-after": "10" } });
    return Response.json({ ok: true, messages: [], response_metadata: { next_cursor: "next-page" } });
  });
  await deliverNext(f.options);
  expect(f.outcomes[0]).toMatchObject({ kind: "uncertain", readLimited: true, cursor: "next-page" });
  const resumed = fixture({ ...delivery, cursor: "next-page" }, request => {
    seen.push(new URL(request.url).searchParams.get("cursor"));
    return Response.json({ ok: true, messages: [] });
  });
  await deliverNext(resumed.options);
  expect(seen).toEqual([null, "next-page", "next-page"]);
  expect(resumed.outcomes[0]?.kind).toBe("held");
});

test("the idle pump can shut down and an aborted pump never claims another delivery", async () => {
  const controller = new AbortController();
  let claimed = 0;
  const base = fixture(reply, () => { throw new Error("unexpected network request"); });
  const queue = { ...base.options.queue, claimDelivery: () => {
    claimed++;
    return null;
  } };
  const options = { ...base.options, queue, signal: controller.signal };
  const pump = runSender(options);
  controller.abort();
  await pump;
  await runSender(options);
  expect(claimed).toBe(1);
});

test("a long reconciliation scan yields to other deliveries between page batches", async () => {
  let pages = 0;
  const f = fixture({ ...reply, mode: "reconcile" }, () => {
    pages++;
    return Response.json({ ok: true, messages: [], response_metadata: { next_cursor: String(pages) } });
  });
  await deliverNext(f.options);
  expect(pages).toBe(4);
  expect(f.outcomes[0]).toMatchObject({ kind: "uncertain", cursor: "4" });
});

test("a crash between Slack receipt and local commit resumes with one read and no second post", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ein-sender-test-"));
  const file = join(dir, "state.sqlite");
  let db = new Database(file, { strict: true });
  try {
    const store = new DeliveryStore(db);
    const fakeToken = ["xoxp", "fixture", "credential"].join("-");
    store.queueDelivery(reply.id, "conv", reply.channel, reply.threadTs, `Summary ${fakeToken} Bearer fixture-secret`);
    const methods: string[] = [];
    const bodies: string[] = [];
    let metadata: unknown;
    const f = fixture(reply, async request => {
      methods.push(request.method);
      if (request.method === "POST") {
        const body = await request.json() as { text: string; metadata: unknown };
        bodies.push(body.text);
        metadata = body.metadata;
        return Response.json({ ok: true, channel: reply.channel, ts: posted });
      }
      return Response.json({ ok: true, messages: [{ ts: posted, user: "Ubot", thread_ts: reply.threadTs, metadata }] });
    });
    const crashing = {
      claimDelivery: (now: number) => store.claimDelivery(now),
      settleDelivery: () => { throw new Error("interrupted local commit"); },
    };
    await expect(deliverNext({ ...f.options, queue: crashing })).rejects.toThrow("interrupted local commit");
    db.close();
    db = new Database(file, { strict: true });
    const restarted = new DeliveryStore(db);
    expect(await deliverNext({ ...f.options, queue: restarted })).toBe(true);
    expect(await deliverNext({ ...f.options, queue: restarted })).toBe(false);
    expect(methods).toEqual(["POST", "GET"]);
    expect(bodies).toEqual(["Summary [REDACTED] Bearer [REDACTED]"]);
    expect(db.query("SELECT status, slackTs FROM slack_deliveries").get()).toEqual({ status: "sent", slackTs: posted });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
