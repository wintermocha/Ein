import { expect, test } from "bun:test";
import ky from "ky";
import { compareSlackTs, fetchThreadHistory } from "../src/thread-history";

const root = "1700000000.000001";
const at = (suffix: string) => "1700000000." + suffix;
const row = (ts: string, text: string, extra = {}) => ({ ts, text, user: "UOWNER", thread_ts: root, ...extra });
const page = (messages: unknown[], cursor = "") =>
  Response.json({ ok: true, messages, response_metadata: { next_cursor: cursor } });

function setup(reply: (url: URL) => Response) {
  const urls: URL[] = [];
  const http = ky.create({ fetch: async input => {
    const url = new URL(new Request(input).url);
    urls.push(url);
    return reply(url);
  } });
  const options = { botToken: "test", channel: "CTEAM", threadTs: root, after: null,
    before: at("200004"), blockedUsers: ["UBLOCK"], signal: new AbortController().signal, http };
  return { urls, options };
}

test("first mention reads scoped prior posts across pages and orders overlapping messages once", async () => {
  const { urls, options } = setup(url => url.searchParams.has("cursor")
    ? page([row(at("200000"), "Bearer top-secret"), row(at("010000"), "earlier")])
    : page([
      row(root, "original"), row(at("200004"), "current trigger"), row(at("300000"), "future"),
      row(at("200003"), "wrong parent", { thread_ts: at("000002") }),
      row(at("200002"), "wrong channel", { channel: "COTHER" }),
      row(at("200000"), "Bearer top-secret"),
    ], "two"));
  expect(await fetchThreadHistory(options)).toEqual([
    { ts: root, user: "UOWNER", text: "original" },
    { ts: at("010000"), user: "UOWNER", text: "earlier" },
    { ts: at("200000"), user: "UOWNER", text: "Bearer [REDACTED]" },
  ]);
  expect(urls).toHaveLength(2);
  for (const url of urls) {
    expect(url.pathname).toBe("/api/conversations.replies");
    expect(url.searchParams.get("channel")).toBe("CTEAM");
    expect(url.searchParams.get("ts")).toBe(root);
    expect(url.searchParams.get("oldest")).toBe(root);
    expect(url.searchParams.get("latest")).toBe(options.before);
  }
});

test("follow-up returns only the interval after that session's previous turn", async () => {
  const { urls, options } = setup(() => page([
    row(root, "always returned"), row(at("100000"), "previous trigger"), row(at("100001"), "new reply"),
    row(at("200004"), "current trigger"),
  ]));
  expect(await fetchThreadHistory({ ...options, after: at("1") })).toEqual([
    { ts: at("100001"), user: "UOWNER", text: "new reply" },
  ]);
  expect(urls[0]?.searchParams.get("oldest")).toBe(at("1"));
  expect(compareSlackTs("999999999999.100001", "999999999999.1")).toBeGreaterThan(0);
  expect(compareSlackTs("9.0123", "9.012300")).toBe(0);
});

test("preserves participant and bot context with redaction, but omits blocked users and hidden events", async () => {
  const { options } = setup(() => page([
    row(root, "from bot", { user: undefined, bot_id: "B01", subtype: "bot_message" }),
    row(at("020000"), "restricted", { user: "UBLOCK" }),
    row(at("030000"), "deleted", { subtype: "message_deleted" }),
    row(at("040000"), "hidden", { hidden: true }),
    row(at("050000"), "notify", { user: "USLACKBOT" }),
    row(at("060000"), "", { user: "UPEER", subtype: "file_share", files: [{ title: "meeting.txt" }] }),
    row(at("070000"), "credentials xoxb-example", { user: "UPEER" }),
  ]));
  expect(await fetchThreadHistory(options)).toEqual([
    { ts: root, user: "B01", text: "from bot" },
    { ts: at("060000"), user: "UPEER", text: "[file] meeting.txt" },
    { ts: at("070000"), user: "UPEER", text: "credentials [REDACTED]" },
  ]);
});

test("no network for a top-level mention or an already seen interval", async () => {
  const { options, urls } = setup(() => { throw Error("Unexpected Slack read"); });
  expect(await fetchThreadHistory({ ...options, before: root })).toEqual([]);
  expect(await fetchThreadHistory({ ...options, after: options.before })).toEqual([]);
  expect(urls).toBeEmpty();
});

test("uses visible app block or attachment text when the Slack post has no text of its own", async () => {
  const plain = (text: string) => ({ type: "plain_text", text });
  const blocks = [
    { type: "header", text: plain("Build report") },
    { type: "section", text: { type: "mrkdwn", text: "*Status*" }, fields: [plain("OK")],
      accessory: { type: "button", value: "private-button-data" } },
    { type: "actions", elements: [{ type: "button", text: plain("private action"), value: "private" }] },
    { type: "rich_text", elements: [{ type: "rich_text_list", elements: [
      { type: "rich_text_section", elements: [
        { type: "text", text: "See " }, { type: "link", text: "details", url: "https://example.com/signed" },
      ] },
      { type: "rich_text_section", elements: [{ type: "link", url: "https://example.com/docs" }] },
    ] }] },
  ];
  const { options } = setup(() => page([
    row(root, "", { user: undefined, bot_id: "BNOTIFY", blocks }),
    row(at("010000"), "", { attachments: [
      { text: "Bearer abc-123", fallback: "alternate text", callback_id: "private" },
      { fallback: "Deploy finished" }, { blocks: [{ type: "header", text: plain("Next steps") }] },
    ] }),
    row(at("020000"), "Preferred Slack text", { blocks }),
  ]));
  expect(await fetchThreadHistory(options)).toEqual([
    { ts: root, user: "BNOTIFY", text: "Build report\n*Status*\nOK\nSee details\nhttps://example.com/docs" },
    { ts: at("010000"), user: "UOWNER", text: "Bearer [REDACTED]\nDeploy finished\nNext steps" },
    { ts: at("020000"), user: "UOWNER", text: "Preferred Slack text" },
  ]);
});

test.each(["missing_scope", "thread_not_found"])("surfaces unavailable history: %s", async error => {
  const { options } = setup(() => Response.json({ ok: false, error }));
  await expect(fetchThreadHistory(options)).rejects.toThrow(error);
});

test("incomplete pages never return a misleading partial transcript", async () => {
  const { options } = setup(() => Response.json({ ok: true, messages: [row(root, "partial")], has_more: true }));
  await expect(fetchThreadHistory(options)).rejects.toThrow("incomplete_pagination");
});
