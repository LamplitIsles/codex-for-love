import assert from "node:assert/strict";
import test from "node:test";
import { CompanionNotificationObserver } from "../src/lib/companion/client/notifications.ts";

test("notification observer establishes a silent completion baseline", () => {
  const observer = new CompanionNotificationObserver();
  assert.deepEqual(observer.observe([
    { turnId: "old-complete", status: "completed" },
    { turnId: "old-failed", status: "failed" },
  ]), []);
  assert.deepEqual(observer.observe([
    { turnId: "old-complete", status: "completed" },
    { turnId: "new-complete", status: "completed" },
  ]), ["new-complete"]);
});

test("notification observer emits each successfully completed turn once", () => {
  const observer = new CompanionNotificationObserver();
  observer.observe([]);
  assert.deepEqual(observer.observe([{ turnId: "turn-1", status: "running" }]), []);
  assert.deepEqual(observer.observe([{ turnId: "turn-1", status: "completed" }]), ["turn-1"]);
  assert.deepEqual(observer.observe([{ turnId: "turn-1", status: "completed" }]), []);
  assert.deepEqual(observer.observe([
    { turnId: "turn-1", status: "completed" },
    { turnId: "turn-2", status: "interrupted" },
    { turnId: "turn-3", status: "failed" },
  ]), []);
});
