import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReceiverState } from "../src/state";

const policy = { botUser: "UBOT", ownerUser: "UOWNER", blockedUsers: [], watchChannels: ["CCHAN"], otherUserReplyRate: {} };
const mention = { type: "app_mention", channel: "CCHAN", user: "UOWNER", ts: "1700000000.000001", text: "<@UBOT> check" };
const followup = { ...mention, type: "message", ts: "1700000002.000001", thread_ts: mention.ts, text: "also check the tests" };
let dir: string;
let state: ReceiverState;
function switchToListen() {
  state.close();
  state = new ReceiverState(join(dir, "state.db"), "TTEAM", policy.botUser);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ein-intake-"));
  state = new ReceiverState(join(dir, "state.db"), "TTEAM", policy.botUser, "orchestrate");
  state.consume(mention, policy);
});
afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a pending orchestration job alone does not enroll the thread in listen mode", () => {
  switchToListen();
  state.consume(followup, policy);
  const lines: string[] = [];
  state.drain(line => lines.push(line));
  expect(lines).toEqual([]);
});

test("a confirmed post enrolls the thread and records the bot reaction target without a socket echo", () => {
  const [job] = state.jobs.ready();
  if (!job) throw new Error("Expected queued mention");
  state.jobs.answer(job.id, job.attempt, "done");
  const delivery = state.jobs.claimDelivery(Date.now());
  if (!delivery) throw new Error("Expected outgoing reply");
  const botTs = "1700000001.000001";
  state.jobs.settleDelivery(delivery.id, { kind: "sent", ts: botTs });
  switchToListen();

  state.consume(followup, policy);
  state.consume({ type: "reaction_added", user: "UOWNER", reaction: "eyes", event_ts: "1700000003.000001",
    item: { type: "message", channel: mention.channel, ts: botTs } }, policy);
  const lines: string[] = [];
  state.drain(line => lines.push(line));
  expect(lines).toEqual([
    `INBOUND own-thread CCHAN ${mention.ts} ${followup.ts} UOWNER "also check the tests"`,
    `INBOUND reaction CCHAN ${mention.ts} 1700000003.000001 UOWNER ":eyes:"`,
  ]);
});
