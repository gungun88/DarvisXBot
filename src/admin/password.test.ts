import assert from "node:assert/strict";
import test from "node:test";
import { hashAdminPassword, verifyAdminPassword, verifyTotpCode } from "./password.js";

test("admin passwords are salted and verified with scrypt", () => {
  const first = hashAdminPassword("correct horse battery staple");
  const second = hashAdminPassword("correct horse battery staple");

  assert.notEqual(first, second);
  assert.equal(verifyAdminPassword(first, "correct horse battery staple"), true);
  assert.equal(verifyAdminPassword(first, "wrong password"), false);
  assert.equal(verifyAdminPassword("invalid", "correct horse battery staple"), false);
});

test("TOTP verification accepts the RFC 6238 value and adjacent clock steps", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  assert.equal(verifyTotpCode(secret, "287082", 59_000), true);
  assert.equal(verifyTotpCode(secret, "287082", 89_000), true);
  assert.equal(verifyTotpCode(secret, "287082", 119_000), false);
  assert.equal(verifyTotpCode(secret, "not-six-digits", 59_000), false);
  assert.equal(verifyTotpCode("invalid!", "287082", 59_000), false);
});
