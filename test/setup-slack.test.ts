import { expect, test } from "bun:test";
import { setupIdentity } from "../src/setup-slack";
import { startPeerTLS, waitFor } from "./fixtures/sdk-peer";

const setup = {
  appId: "AEIN", team: "TTEST", botUser: "UBOT", appToken: "xapp-fixture", code: "ein-0123456789",
};
const dm = { type: "message", channel_type: "im", channel: "DROOM", user: "WOWNER", text: setup.code };
const installation = { team_id: setup.team, user_id: setup.botUser, is_bot: true };
const callback = {
  type: "event_callback", team_id: setup.team, api_app_id: setup.appId, authorizations: [installation], event: dm,
};
function runSocket(peer: ReturnType<typeof startPeerTLS>, stop: "abort" | "deadline" | "match" = "match") {
  return Bun.spawn([process.execPath, "--no-env-file", "--preload", "./test/fixtures/sdk-slack-redirect.ts", "-e",
    `import { waitForSetupDm } from "./src/setup-slack";
    const stop = new AbortController();
    if (${stop === "deadline"}) {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => timeout(ms === 300_000 ? 300 : ms);
    }
    try {
      console.log(JSON.stringify(await waitForSetupDm({
        ...${JSON.stringify(setup)}, signal: stop.signal,
        onReady() { if (${stop === "abort"}) stop.abort(); }
      })));
    } catch (error) { console.error(error.message); process.exitCode = 1; }`],
  { env: { EIN_TEST_SLACK_API: peer.apiUrl, NODE_EXTRA_CA_CERTS: peer.caFile },
    stdout: "pipe", stderr: "pipe", timeout: 10_000 });
}

test("only an exact human top-level DM from the selected installation completes setup", async () => {
  const peer = startPeerTLS();
  const child = runSocket(peer);
  try {
    await waitFor(() => peer.connections === 1, "setup socket");
    const ignored = [
      { ...callback, api_app_id: "AOTHER" }, { ...callback, team_id: "TOTHER" },
      ...[{ channel: "CTEST" }, { channel_type: "mpim" }, { text: " " + setup.code },
        { subtype: "message_changed" }, { edited: {} }, { bot_id: "BBOT" }, { user: setup.botUser },
        { app_id: "ABOT" }, { thread_ts: "123.123456" },
      ].map(fields => ({ ...callback, event: { ...dm, ...fields } })),
    ];
    for (const [id, payload] of ignored.entries()) {
      peer.send(1, { type: "events_api", envelope_id: String(id), payload });
    }
    await waitFor(() => peer.acks.length === ignored.length, "ignored envelopes acknowledged");
    peer.send(1, { type: "events_api", envelope_id: "owner", payload: callback });
    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).json()).toEqual({ ownerUser: "WOWNER", ownerDm: "DROOM" });
    expect(peer.acks.map(a => a.id)).toContain("owner");
  } finally {
    child.kill();
    await peer.stop();
  }
}, 15_000);

test.each([
  { name: "wrong installation", stop: "match", diagnostic: "봇 토큰" },
  { name: "interrupted wait", stop: "abort", diagnostic: "중단" },
  { name: "expired wait", stop: "deadline", diagnostic: "시간이 지났습니다" },
] as const)("$name closes the socket without returning an owner", async ({ stop, diagnostic }) => {
  const peer = startPeerTLS(stop === "match" ? { afterHello: { type: "events_api", envelope_id: "wrong-bot", payload: {
    ...callback, authorizations: [{ ...installation, user_id: "UOTHER" }],
  } } } : {});
  const child = runSocket(peer, stop);
  try {
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stdout).text()).toBe("");
    expect(await new Response(child.stderr).text()).toContain(diagnostic);
  } finally {
    child.kill();
    await peer.stop();
  }
}, 15_000);

test("the bot identifies itself and keeps raw API failures out of setup diagnostics", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  if (!descriptor) throw Error("Missing fetch");
  const seen: { method: string; authorization: string | null; body: string }[] = [];
  const responses = [
    { ok: true, team_id: "TTEST", user_id: "UBOT" },
    { ok: false, error: "private-payload" },
  ];
  Object.defineProperty(globalThis, "fetch", { ...descriptor, value: async (request: Request) => {
    seen.push({ method: request.url, authorization: request.headers.get("authorization"), body: await request.text() });
    return Response.json(responses.shift());
  } });
  try {
    const signal = new AbortController().signal;
    expect(await setupIdentity("xoxb-fixture", signal)).toEqual({ team: "TTEST", botUser: "UBOT" });
    expect(seen).toEqual([
      { method: "https://slack.com/api/auth.test", authorization: "Bearer xoxb-fixture", body: "" },
    ]);
    await expect(setupIdentity("xoxb-fixture", signal)).rejects.toThrow("Slack auth.test에 실패했습니다. 봇 토큰을 확인하세요.");
  } finally {
    Object.defineProperty(globalThis, "fetch", descriptor);
  }
});
