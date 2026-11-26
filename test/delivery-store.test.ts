import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryStore } from "../src/delivery-store";

let directory: string;
let db: Database;
let store: DeliveryStore;

function openStore(): void {
  db = new Database(join(directory, "state.sqlite"), { strict: true });
  store = new DeliveryStore(db);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ein-deliveries-"));
  openStore();
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

test("immutable IDs and destination FIFO survive restart, and unrelated destinations can proceed", () => {
  store.queueDelivery("first", "thread", "C1", "100.100", "one");
  store.queueDelivery("second", "alternate key", "C1", "100.100", "two");
  store.queueDelivery("first", "alternate key", "C2", "100.100", "replacement");
  store.queueDelivery("third", "another thread", "C1", "200.200", "three");

  expect(store.claimDelivery(0)).toMatchObject({id: "first", mode: "send", channel: "C1", text: "one"});
  expect(store.claimDelivery(0)).toMatchObject({id: "third", mode: "send"});
  store.settleDelivery("third", {kind: "sent", ts: "300.300"});
  expect(store.claimDelivery(0)).toBeNull();

  db.close();
  openStore();
  expect(store.claimDelivery(0)).toMatchObject({id: "first", mode: "reconcile"});
  db.close();
  openStore();
  expect(store.claimDelivery(0)).toMatchObject({id: "first", mode: "reconcile"});
  store.settleDelivery("first", {kind: "sent", ts: "400.400"});
  expect(store.claimDelivery(0)).toMatchObject({id: "second", mode: "send", text: "two"});
  store.settleDelivery("second", {kind: "sent", ts: "500.500"});
  store.queueDelivery("first", "thread", "C1", "100.100", "duplicate");
  expect(store.claimDelivery(0)).toBeNull();
  expect(db.query("SELECT slackTs, text FROM slack_deliveries WHERE id = 'first'").get())
    .toEqual({slackTs: "400.400", text: null});
});

test("a rate-limited post defers all POSTs across restart while reads continue", () => {
  store.queueDelivery("read", "a", "D1", null, "a");
  store.queueDelivery("post", "b", "D2", null, "b");
  expect(store.claimDelivery(0)?.id).toBe("read");
  store.settleDelivery("read", {kind: "uncertain", at: 5});
  expect(store.claimDelivery(0)?.id).toBe("post");
  store.settleDelivery("post", {kind: "retry", at: 100});
  store.queueDelivery("new", "c", "D3", null, "c");

  db.close();
  openStore();
  expect(store.claimDelivery(4)).toBeNull();
  expect(store.claimDelivery(5)).toMatchObject({id: "read", mode: "reconcile"});
  store.settleDelivery("read", {kind: "sent", ts: "101.1"});
  expect(store.claimDelivery(99)).toBeNull();
  expect(store.claimDelivery(100)).toMatchObject({id: "post", mode: "send"});
  expect(store.claimDelivery(100)).toMatchObject({id: "new", mode: "send"});
});

test("throttled verification saves the next page and pauses only the affected Slack read method", () => {
  store.queueDelivery("dmA", "a", "DA", null, "a");
  store.queueDelivery("dmB", "b", "DB", null, "b");
  store.queueDelivery("thread", "c", "C1", "200.1", "c");
  for (const id of ["dmA", "dmB", "thread"]) {
    expect(store.claimDelivery(0)?.id).toBe(id);
    store.settleDelivery(id, {kind: "uncertain", at: 10});
  }
  expect(store.claimDelivery(10)?.id).toBe("dmA");
  store.settleDelivery("dmA", {kind: "uncertain", at: 100, cursor: "page2", readLimited: true});
  db.close();
  openStore();
  expect(store.claimDelivery(11)).toMatchObject({id: "thread", mode: "reconcile"});
  store.settleDelivery("thread", {kind: "sent", ts: "203.3"});
  store.queueDelivery("dmC", "d", "DC", null, "d");
  expect(store.claimDelivery(11)).toMatchObject({id: "dmC", mode: "send"});
  expect(store.claimDelivery(99)).toBeNull();
  expect(store.claimDelivery(100)).toMatchObject({id: "dmA", cursor: "page2"});
  store.settleDelivery("dmA", {kind: "uncertain", at: 200});
  expect(store.claimDelivery(100)?.id).toBe("dmB");
  expect(store.claimDelivery(200)).not.toHaveProperty("cursor");
});

test("unresolved and held sends block later top-level DMs without blocking other destinations", () => {
  store.queueDelivery("dm1", "dm", "D1", null, "one");
  store.queueDelivery("dm2", "dm", "D1", null, "two");
  expect(store.claimDelivery(0)?.id).toBe("dm1");
  store.settleDelivery("dm1", {kind: "uncertain", at: 15});
  expect(store.claimDelivery(14)).toBeNull();
  expect(store.claimDelivery(15)).toMatchObject({id: "dm1", mode: "reconcile"});
  store.settleDelivery("dm1", {kind: "held", reason: "unconfirmed"});
  store.queueDelivery("thread", "dm thread", "D1", "200.2", "thread");
  expect(store.claimDelivery(1000)?.id).toBe("thread");
  expect(store.claimDelivery(1000)).toBeNull();
  // A stale completion cannot silently release a held delivery.
  store.settleDelivery("dm1", {kind: "sent", ts: "100.1"});
  expect(store.claimDelivery(1000)).toBeNull();
});
