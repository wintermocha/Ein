// Child-only fixture: redirect Slack's HTTP methods. The real SDK opens its own TLS WebSocket.
const peer = new URL(process.env.EIN_TEST_SLACK_API!);
if (peer.protocol !== "https:" || peer.hostname !== "127.0.0.1") throw new Error("Expected a loopback TLS peer");
const network = globalThis.fetch.bind(globalThis);
async function localOnly(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const origin = new URL(request.url);
  if (origin.origin !== "https://slack.com" || !origin.pathname.startsWith("/api/"))
    throw new Error("Unexpected HTTP destination in Slack test");
  const target = new URL(origin.pathname + origin.search, peer.origin);
  return network(new Request(target.href, request), { redirect: "error" });
}
Object.defineProperty(globalThis, "fetch", { value: localOnly });
export {};
