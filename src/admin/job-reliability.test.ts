import assert from "node:assert/strict";
import test from "node:test";
import { currentJobAttempt, isFinalJobAttempt, jobErrorMessage } from "../lib/job-reliability.js";

test("job attempts are counted from one and only the last configured attempt is final", () => {
  assert.equal(currentJobAttempt({ attemptsMade: 0, opts: { attempts: 3 } }), 1);
  assert.equal(isFinalJobAttempt({ attemptsMade: 0, opts: { attempts: 3 } }), false);
  assert.equal(isFinalJobAttempt({ attemptsMade: 1, opts: { attempts: 3 } }), false);
  assert.equal(isFinalJobAttempt({ attemptsMade: 2, opts: { attempts: 3 } }), true);
  assert.equal(isFinalJobAttempt({ attemptsMade: 0, opts: {} }), true);
});

test("job errors are normalized and bounded for persistence", () => {
  assert.equal(jobErrorMessage(new Error("Telegram unavailable")), "Telegram unavailable");
  assert.equal(jobErrorMessage("queue disconnected"), "queue disconnected");
  assert.equal(jobErrorMessage("x".repeat(5000)).length, 4000);
});
