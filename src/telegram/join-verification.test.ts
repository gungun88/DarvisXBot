import test from "node:test";
import assert from "node:assert/strict";
import {
  createJoinVerificationChallenge,
  isJoinVerifyMode,
  type JoinVerifyMode
} from "./join-verification.js";

test("join verification modes are recognized", () => {
  assert.equal(isJoinVerifyMode("button"), true);
  assert.equal(isJoinVerifyMode("math"), true);
  assert.equal(isJoinVerifyMode("captcha"), true);
  assert.equal(isJoinVerifyMode("emoji"), true);
  assert.equal(isJoinVerifyMode("unknown"), false);
});

test("join verification challenges include the correct answer", () => {
  const modes: JoinVerifyMode[] = ["button", "math", "captcha", "emoji"];

  for (const mode of modes) {
    const challenge = createJoinVerificationChallenge(mode);
    assert.ok(challenge.prompt.length > 0);
    assert.ok(challenge.choices.length > 0);
    assert.ok(challenge.choices.some((choice) => choice.value === challenge.answer));
  }
});

test("button verification has a stable callback answer", () => {
  const challenge = createJoinVerificationChallenge("button");
  assert.equal(challenge.answer, "button");
  assert.deepEqual(challenge.choices, [{ label: "✅ 我不是机器人", value: "button" }]);
});
