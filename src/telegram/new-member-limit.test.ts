import test from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  parseDurationMinutes,
  parseNewMemberLimitSettings
} from "./new-member-limit.js";

test("new member limit settings fall back safely", () => {
  assert.deepEqual(parseNewMemberLimitSettings(undefined), {
    enabled: false,
    durationMinutes: 1
  });
  assert.deepEqual(parseNewMemberLimitSettings({ enabled: true, durationMinutes: 90 }), {
    enabled: true,
    durationMinutes: 90
  });
  assert.deepEqual(parseNewMemberLimitSettings({ enabled: "yes", durationMinutes: -1 }), {
    enabled: false,
    durationMinutes: 1
  });
});

test("new member limit duration parser accepts common units", () => {
  assert.equal(parseDurationMinutes("1m"), 1);
  assert.equal(parseDurationMinutes("2h"), 120);
  assert.equal(parseDurationMinutes("3d"), 4320);
  assert.equal(parseDurationMinutes("10 minutes"), 10);
  assert.equal(parseDurationMinutes("120"), 120);
  assert.equal(parseDurationMinutes("120 \u5355\u4f4d/\u5206\u949f"), 120);
  assert.equal(parseDurationMinutes("2 hours"), 120);
  assert.equal(parseDurationMinutes("1 day"), 1440);
  assert.equal(parseDurationMinutes("5\u5206\u949f"), 5);
  assert.equal(parseDurationMinutes("6\u5c0f\u65f6"), 360);
  assert.equal(parseDurationMinutes("2\u5929"), 2880);
});

test("new member limit duration parser rejects invalid input", () => {
  assert.equal(parseDurationMinutes("0m"), null);
  assert.equal(parseDurationMinutes("abc"), null);
  assert.equal(parseDurationMinutes("1w"), null);
});

test("new member limit duration formatter uses readable labels", () => {
  assert.equal(formatDuration("en", 1), "1 minute");
  assert.equal(formatDuration("en", 60), "1 hour");
  assert.equal(formatDuration("en", 1440), "1 day");
  assert.equal(formatDuration("zh-CN", 1), "1 \u5206\u949f");
  assert.equal(formatDuration("zh-CN", 60), "1 \u5c0f\u65f6");
  assert.equal(formatDuration("zh-CN", 1440), "1 \u5929");
});
