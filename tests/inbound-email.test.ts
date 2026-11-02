import { describe, expect, it, vi } from "vitest";
import { env } from "../src/config/env.js";
import { validateRecoveryOptions } from "../src/services/email-recovery.service.js";
import { runEmailStages } from "../src/services/email-worker.service.js";
import { parseReceivedEmail, recipientCandidates } from "../src/services/inbound-email.js";

describe("provider contract", () => {
  it("normalizes recipient sources, deduplicates aliases and supports historical domains", () => {
    const alias = `reply-${"a".repeat(48)}@old.example.test`;
    const candidates = recipientCandidates(
      parseReceivedEmail({
        from: "buyer@example.test",
        to: [`Buyer <${alias.toUpperCase()}>`],
        cc: [alias],
        bcc: ["other@example.test"],
        received_for: [],
        authentication: { dmarc: "pass" },
      }),
    );
    expect([...candidates]).toEqual([[alias, ["to", "cc"]]]);
  });
  it("rejects malformed provider data without exposing the raw payload", () => {
    expect(() => parseReceivedEmail({ from: "private-marker", to: "not-an-array" })).toThrow(
      "INVALID_RECEIVED_EMAIL",
    );
  });
  it("runs inbound and later stages after a repair failure", async () => {
    const inbound = vi.fn();
    const later = vi.fn();
    const outcomes = await runEmailStages([
      {
        name: "repair",
        run: async () => {
          throw new Error("private");
        },
      },
      { name: "inbound", run: inbound },
      { name: "later", run: later },
    ]);
    expect(inbound).toHaveBeenCalledOnce();
    expect(later).toHaveBeenCalledOnce();
    expect(outcomes).toEqual({ repair: false, inbound: true, later: true });
  });
  it("requires explicit environment, bounded scope and audited requeue", () => {
    const options = {
      environment: env.NODE_ENV,
      from: "2026-11-01",
      to: "2026-11-02",
      batchSize: 50,
      maxItems: 100,
    };
    expect(() => validateRecoveryOptions(options)).not.toThrow();
    expect(() => validateRecoveryOptions({ ...options, environment: "unknown" })).toThrow(
      "ENVIRONMENT_MISMATCH",
    );
    expect(() => validateRecoveryOptions({ ...options, requeue: true })).toThrow(
      "REQUEUE_REASON_REQUIRED",
    );
    expect(() => validateRecoveryOptions({ ...options, batchSize: 101 })).toThrow(
      "INVALID_BATCH_SIZE",
    );
  });
});
