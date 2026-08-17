import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { adminSessionExpiresAt } from "./auth.js";
import { botFeatureLimits, getMembershipPlan, verifyPayloadSignature } from "../subscriptions/subscription.service.js";

test("membership plans expose fixed server-side price and duration", () => {
  assert.deepEqual(getMembershipPlan("1m"), { key: "1m", months: 1, amountUsd: "10", label: "10U 1个月" });
  assert.equal(getMembershipPlan("unknown"), null);
});

test("NOWPayments signatures use recursively sorted JSON", () => {
  const payload = { payment_status: "finished", nested: { z: 2, a: 1 }, order_id: "order-1" };
  const canonical = JSON.stringify({ nested: { a: 1, z: 2 }, order_id: "order-1", payment_status: "finished" });
  const signature = createHmac("sha512", "test-secret-123456").update(canonical).digest("hex");
  assert.equal(verifyPayloadSignature(payload, signature, "test-secret-123456"), true);
  assert.equal(verifyPayloadSignature(payload, "0".repeat(128), "test-secret-123456"), false);
});

test("free and premium feature limits match the membership offer", () => {
  assert.deepEqual(botFeatureLimits.free, {
    scheduledMessagesPerChat: 5,
    channelSyncTargetsPerSource: 2,
    autoReplyRulesPerChat: 10,
    requiredChannelSubscriptions: 1
  });
  assert.deepEqual(botFeatureLimits.premium, {
    scheduledMessagesPerChat: 50,
    channelSyncTargetsPerSource: 20,
    autoReplyRulesPerChat: 300,
    requiredChannelSubscriptions: 3
  });
});

test("admin session TTL parsing uses explicit units", () => {
  const now = new Date("2026-08-17T00:00:00.000Z");
  assert.equal(adminSessionExpiresAt("8h", now).toISOString(), "2026-08-17T08:00:00.000Z");
  assert.equal(adminSessionExpiresAt("30m", now).toISOString(), "2026-08-17T00:30:00.000Z");
});
