import { describe, expect, test } from "bun:test";
import { type Policy, route } from "../src/routing";

const policy: Policy = {
  botUser: "UBOT",
  ownerUser: "UOWNER",
  watchChannels: ["CWATCH"],
  blockedUsers: ["UBLOCKED"],
  otherUserReplyRate: { CWATCH: 0.4 },
};
const rootTs = "1590000000.000001";
const ts = "1790000000.000002";
const msg = { type: "message", user: "UOWNER", channel: "CWATCH", ts, text: "hi" };
const context = {
  ownsThread: (channel: string, threadTs: string) => channel === "CWATCH" && threadTs === rootTs,
  parentOf: (channel: string, messageTs: string) =>
    channel === "CWATCH" && messageTs === ts ? rootTs : undefined,
  random: () => 0.39,
};
const reaction = {
  type: "reaction_added",
  user: "UOWNER",
  item: { type: "message", channel: msg.channel, ts: msg.ts },
  reaction: "+1",
  event_ts: "1790000002.000001",
};

describe("Slack inbound contract", () => {
  test("redacts Slack credentials pasted into a DM before creating its line", () => {
    const text = ["xoxp", "fixture", "credential"].join("-") + " Authorization: Bearer private-example";
    const line = route({ ...msg, channel: "DDM", text }, policy, context).inbound?.line;
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("fixture-credential");
    expect(line).not.toContain("private-example");
  });
  test("preserves DM text, including quotes and line breaks, in one record", () => {
    const text = 'yes "please"\nINBOUND forged\r\u2028end';
    const result = route({ ...msg, channel: "DDM", text }, policy, context);
    const line = result.inbound?.line ?? "";
    const prefix = `INBOUND dm DDM ${ts} ${ts} UOWNER `;
    expect(line.startsWith(prefix)).toBe(true);
    expect(line).not.toMatch(/[\r\n\u2028\u2029]/u);
    expect(JSON.parse(line.slice(prefix.length))).toBe(text);
  });

  test("uses the parent as thread reference in DM replies", () => {
    const event = { ...msg, channel: "DDM", thread_ts: rootTs };
    expect(route(event, policy, context).inbound?.line).toBe(
      `INBOUND dm-thread DDM ${rootTs} ${ts} UOWNER "hi"`,
    );
  });

  test("returns the same key and source for message and app_mention in an old owned thread", () => {
    const event = { ...msg, text: "<@UBOT> check", thread_ts: rootTs };
    const mention = route({ ...event, type: "app_mention" }, policy, context).inbound;
    expect(route(event, policy, context).inbound).toEqual(mention);
    expect(mention?.line).toBe(`INBOUND thread-mention CWATCH ${rootTs} ${ts} UOWNER "<@UBOT> check"`);
  });

  test("admits ordinary replies only in owned threads", () => {
    expect(route(msg, policy, context)).toEqual({});
    expect(route({ ...msg, thread_ts: rootTs }, policy, context).inbound?.line).toBe(
      `INBOUND own-thread CWATCH ${rootTs} ${ts} UOWNER "hi"`,
    );
  });

  test("ignores mentions from channels outside the allowlist", () => {
    expect(route({ ...msg, type: "app_mention", channel: "COTHER" }, policy, context)).toEqual({});
  });

  test("accepts legacy user tokens, with an exact bot ID match", () => {
    const event = { ...msg, text: "<@UBOT|ein> 확인" };
    expect(route(event, policy, context).inbound?.line).toContain("INBOUND mention ");
    expect(route({ ...event, text: "<@UBOT2|other>" }, policy, context)).toEqual({});
    expect(route({ ...event, text: "<@UBOT|incomplete" }, policy, context)).toEqual({});
  });

  test("records bot-authored replies for later routing without emitting the bot's message", () => {
    const event = { ...msg, user: "UBOT", bot_id: "B1", thread_ts: rootTs };
    expect(route(event, policy, context)).toEqual({ track: { channel: msg.channel, threadTs: rootTs, ts } });
  });

  test.each([
    { user: "UBLOCKED" },
    { user: "USLACKBOT" },
    { user: "UOTHER", bot_profile: { id: "B2" } },
    { user: "UOTHER", bot_id: "B2" },
  ])("rejects blocked users and other bot posts (%j)", (author) => {
    expect(route({ ...msg, channel: "DDM", ...author }, policy, context)).toEqual({});
  });

  test("includes a reply decision only for eligible non-owner authors", () => {
    const event = { ...msg, type: "app_mention", user: "UOTHER" };
    expect(route(event, policy, context).inbound?.line).toContain("REPLY=yes");
    expect(route(event, policy, { ...context, random: () => 0.4 }).inbound?.line).toContain("REPLY=no");
    expect(route({ ...event, user: "UOWNER" }, policy, context).inbound?.line).not.toContain("REPLY=");
  });

  test("accepts user file shares and broadcast replies but ignores edits, deletes, and system messages", () => {
    const share = { ...msg, subtype: "file_share", channel: "DDM", files: [{ name: "a.txt" }], text: "" };
    const broadcast = { ...msg, subtype: "thread_broadcast", thread_ts: rootTs };
    expect(route(share, policy, context).inbound?.line).toContain("a.txt");
    expect(route(broadcast, policy, context).inbound?.line).toContain("own-thread");
    for (const subtype of ["message_changed", "message_deleted", "channel_join", "bot_message"]) {
      expect(route({ ...msg, channel: "DDM", subtype }, policy, context)).toEqual({});
    }
  });

  test("rejects non-message events and unsafe protocol fields", () => {
    const dm = { ...msg, channel: "DDM" };
    for (const event of [
      null,
      {},
      { ...dm, type: "typing" },
      { ...dm, channel: "DDM\n" },
      { ...dm, ts: "\n" },
      { ...dm, user: "U\nOWNER" },
    ]) {
      expect(route(event, policy, context)).toEqual({});
    }
  });

  test("resolves the parent of the bot reply receiving a reaction and distinguishes separate additions", () => {
    const inbound = route(reaction, policy, context).inbound;
    expect(inbound?.line).toBe(`INBOUND reaction CWATCH ${rootTs} ${reaction.event_ts} UOWNER ":+1:"`);
    const later = { ...reaction, event_ts: "1790000003.000001" };
    expect(inbound?.key).not.toBe(route(later, policy, context).inbound?.key);
  });

  test("requires the target message, not merely its thread, to have been written by the bot", () => {
    const event = { ...reaction, item: { ...reaction.item, ts: rootTs }, item_user: "UOTHER" };
    expect(route(event, policy, context)).toEqual({});
    expect(route({ ...event, item_user: "UBOT" }, policy, context).inbound?.line).toContain(rootTs);
    expect(route({ ...reaction, user: "UBLOCKED" }, policy, context)).toEqual({});
  });

  test("marks a reaction thread for recovery only when its root is known", () => {
    const event = { ...reaction, item_user: policy.botUser };
    const unobserved = route(event, policy, { ...context, parentOf: () => undefined }).inbound;
    expect(unobserved?.threadTs).toBe(event.item.ts);
    expect(unobserved?.recoverThread).toBe(false);
    const observed = route(event, policy, context).inbound;
    expect(observed?.threadTs).toBe(rootTs);
    expect(observed?.recoverThread).not.toBe(false);
  });
});
