import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { attemptSend, rollLifecycleOutcome, rollInboundOffsetMs } from "../src/mailer/mockProvider.js";

describe("mock email provider", () => {
  it("is deterministic for the same (contact, step) pair", () => {
    const a = attemptSend(42, "first");
    const b = attemptSend(42, "first");
    assert.deepEqual(a, b);

    const outcomeA = rollLifecycleOutcome(42, "first");
    const outcomeB = rollLifecycleOutcome(42, "first");
    assert.deepEqual(outcomeA, outcomeB);
  });

  it("produces a varied mix of bounce/deliver outcomes across many contacts (not all-or-nothing)", () => {
    let bounced = 0;
    let delivered = 0;
    for (let id = 0; id < 2000; id++) {
      const { delivered: d } = attemptSend(id, "first");
      d ? delivered++ : bounced++;
    }
    assert.ok(bounced > 0);
    assert.ok(delivered > 0);
    // Roughly near the configured 6% bounce rate, with slack for randomness.
    assert.ok(bounced / 2000 > 0.02);
    assert.ok(bounced / 2000 < 0.12);
  });

  it("keeps inbound offsets strictly within the wait window", () => {
    const windowMs = 5 * 24 * 60 * 60 * 1000;
    for (let id = 0; id < 100; id++) {
      const offset = rollInboundOffsetMs(id, "follow_up_1", windowMs);
      assert.ok(offset > 0);
      assert.ok(offset < windowMs);
    }
  });
});
