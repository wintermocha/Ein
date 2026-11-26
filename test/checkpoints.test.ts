import { expect, test } from "bun:test";
import { setImmediate } from "node:timers/promises";
import { Checkpoints } from "../src/checkpoints";

function setup(cursor?: string, limitEnd?: number) {
  const attempts: {
    window: { oldest: string; latest: string };
    signal: AbortSignal;
    resolve: (result: boolean) => void;
    reject: (reason: unknown) => void;
  }[] = [];
  const saves: string[] = [];
  const limits: {oldest: string; end: number}[] = [];
  let cleared = 0;
  const errors: unknown[] = [];
  let seconds = 1_700_000_000;
  const now = () => seconds.toFixed(6);
  const checkpoints = new Checkpoints({
    read: () => cursor,
    save: (ts) => saves.push(ts),
    readLimitEnd: () => limitEnd,
    saveRateLimit: (oldest, end) => limits.push({oldest, end}),
    clearLimit: () => {cleared++;},
    recover: (window, signal) => {
      const {promise, resolve, reject} = Promise.withResolvers<boolean>();
      attempts.push({window, signal, resolve, reject});
      return promise;
    },
    now,
    onFatal: (error) => errors.push(error),
  });
  return {checkpoints, attempts, saves, errors, limits, cleared: () => cleared, advance: (by: number) => {seconds += by;}};
}

test("a throttled minute rewinds a fresh connection before waiting until the minute ends", async () => {
  const {checkpoints, attempts, saves, limits, cleared, advance} = setup();
  checkpoints.ready();
  checkpoints.rateLimited(1_699_999_980);
  advance(39);
  checkpoints.tick();
  expect(limits).toEqual([{oldest: "1699999980.000000", end: 1_700_000_040}]);
  expect(saves).toEqual(["1700000000.000000"]);
  expect(attempts).toHaveLength(0);
  advance(7);
  checkpoints.tick();
  expect(attempts.at(0)?.window).toEqual({oldest: "1699999980.000000", latest: "1700000046.000000"});
  attempts.at(0)?.resolve(true);
  await setImmediate();
  expect(saves.at(-1)).toBe("1700000046.000000");
  expect(cleared()).toBe(1);
});

test("restart within a persisted rate limit still holds the original cursor and delay", async () => {
  const {checkpoints, attempts, saves, cleared, advance} = setup("1699900000.000000", 1_700_000_040);
  checkpoints.ready();
  advance(35);
  checkpoints.tick();
  expect(attempts).toHaveLength(0);
  expect(saves).toEqual([]);
  advance(10);
  checkpoints.tick();
  expect(attempts.at(0)?.window).toEqual({oldest: "1699900000.000000", latest: "1700000045.000000"});
  attempts.at(0)?.resolve(false);
  await setImmediate();
  expect(saves).toEqual([]);
  expect(cleared()).toBe(0);
});

test("merges overlapping notices and aborts a recovery that can no longer close the gap", async () => {
  const {checkpoints, attempts, saves, limits, cleared, advance} = setup("1699999900.000000");
  checkpoints.ready();
  checkpoints.rateLimited(1_699_999_980);
  checkpoints.rateLimited(1_700_000_040);
  checkpoints.rateLimited(1_699_999_860);
  expect(limits.at(-1)).toEqual({oldest: "1699999860.000000", end: 1_700_000_100});
  advance(110);
  checkpoints.tick();
  expect(attempts.at(0)?.signal.aborted).toBe(true);
  expect(attempts).toHaveLength(1);
  attempts.at(0)?.resolve(true);
  await setImmediate();
  expect(cleared()).toBe(0);
  expect(saves).toEqual([]);
  expect(attempts.at(1)?.window).toEqual({oldest: "1699999860.000000", latest: "1700000110.000000"});
});

test("starts a fresh database at hello without downloading old history", () => {
  const {checkpoints, saves, attempts} = setup();
  checkpoints.ready();
  expect(saves).toEqual(["1700000000.000000"]);
  expect(attempts).toHaveLength(0);
});

test("records live progress periodically and leaves the cursor alone while disconnected", () => {
  const {checkpoints, saves, advance} = setup();
  checkpoints.ready();
  advance(1);
  checkpoints.tick();
  advance(40);
  checkpoints.tick();
  checkpoints.disconnected();
  advance(100);
  checkpoints.tick();
  expect(saves).toEqual(["1700000000.000000", "1700000041.000000"]);
});

test("retries partial recovery at the same fixed upper bound before resuming live progress", async () => {
  const {checkpoints, attempts, saves, advance} = setup("1600000000.000000");
  checkpoints.ready();
  const first = attempts.at(0);
  expect(first?.window).toEqual({oldest: "1600000000.000000", latest: "1700000000.000000"});
  advance(45);
  checkpoints.tick();
  first?.resolve(false);
  await setImmediate();
  advance(299);
  checkpoints.tick();
  expect(attempts).toHaveLength(1);
  expect(saves).toEqual([]);
  advance(1);
  checkpoints.tick();
  expect(attempts.at(1)?.window).toEqual(first?.window);
  attempts.at(1)?.resolve(true);
  await setImmediate();
  checkpoints.tick();
  expect(saves).toEqual(["1700000000.000000", "1700000345.000000"]);
});

test("serializes reconnect work and ignores results from the old connection", async () => {
  const {checkpoints, attempts, saves, advance} = setup("1699999900.000000");
  checkpoints.ready();
  checkpoints.disconnected();
  advance(2);
  checkpoints.ready();
  checkpoints.ready();
  expect(attempts).toHaveLength(1);
  expect(attempts.at(0)?.signal.aborted).toBe(true);
  attempts.at(0)?.resolve(true);
  await setImmediate();
  expect(saves).toEqual([]);
  expect(attempts.at(1)?.window).toEqual({oldest: "1699999900.000000", latest: "1700000002.000000"});
  attempts.at(1)?.resolve(true);
  await setImmediate();
  expect(saves).toEqual(["1700000002.000000"]);
});

test("shutdown aborts and joins the active recovery before resources close", async () => {
  const {checkpoints, attempts, saves, errors} = setup("1699999900.000000");
  checkpoints.ready();
  let stopped = false;
  const closing = checkpoints.stop().then(() => {stopped = true;});
  await setImmediate();
  expect(stopped).toBe(false);
  expect(attempts.at(0)?.signal.aborted).toBe(true);
  attempts.at(0)?.resolve(true);
  await closing;
  checkpoints.ready();
  expect(stopped).toBe(true);
  expect(saves).toEqual([]);
  expect(errors).toEqual([]);
  expect(attempts).toHaveLength(1);
});

test("reports fatal processing errors once and leaves the cursor available for restart", async () => {
  const {checkpoints, attempts, saves, errors, advance} = setup("1699999900.000000");
  const diskError = new Error("failed persistence");
  checkpoints.ready();
  attempts.at(0)?.reject(diskError);
  await setImmediate();
  advance(1000);
  checkpoints.tick();
  checkpoints.ready();
  expect(errors).toEqual([diskError]);
  expect(attempts).toHaveLength(1);
  expect(saves).toEqual([]);
});
