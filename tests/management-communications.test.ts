import { describe, expect, it } from "vitest";
import { allowsRequest, requiredPermissions } from "../src/lib/permissions.js";
import { protectEmailPayload, readEmailPayload } from "../src/services/email-outbox.service.js";
import { inboundRisk, inboundText, mailbox } from "../src/services/email-webhook.service.js";
import { parseStatisticsRange } from "../src/services/landing-analytics.service.js";

describe("communication boundaries", () => {
  it("protects queue secrets and rejects altered ciphertext", () => {
    const protectedValue = protectEmailPayload({ token: "private-link", text: "Customer content" });
    expect(protectedValue).not.toContain("private-link");
    expect(readEmailPayload(protectedValue)).toEqual({
      token: "private-link",
      text: "Customer content",
    });
    const bytes = Buffer.from(protectedValue, "base64url");
    bytes[30] = bytes[30]! ^ 1;
    expect(() => readEmailPayload(bytes.toString("base64url"))).toThrow();
  });
  it("permits read markers to viewers and requires edit to send or retry", () => {
    expect(requiredPermissions("/api/orders/id/messages", "POST")).toEqual(["orders:edit"]);
    expect(requiredPermissions("/api/orders/id/messages/message/retry", "POST")).toEqual([
      "orders:edit",
    ]);
    expect(allowsRequest(["orders:view"], "/api/orders/id/messages/read", "PATCH")).toBe(true);
    expect(allowsRequest(["orders:view"], "/api/orders/id/messages", "POST")).toBe(false);
  });
  it("bounds report ranges and validates timezone", () => {
    const to = new Date();
    const from = new Date(Date.now() - 7 * 86400000);
    expect(parseStatisticsRange({ from: from.toISOString(), to: to.toISOString() }).timezone).toBe(
      "Asia/Manila",
    );
    expect(() =>
      parseStatisticsRange({ from: to.toISOString(), to: from.toISOString() }),
    ).toThrow();
    expect(() =>
      parseStatisticsRange({
        from: from.toISOString(),
        to: to.toISOString(),
        timezone: "No/SuchTimezone",
      }),
    ).toThrow();
  });
  it("treats missing authentication and automatic replies conservatively", () => {
    expect(inboundRisk({})).toBe("AUTHENTICATION_UNCONFIRMED");
    expect(inboundRisk({ "Authentication-Results": "mx.test; dmarc=pass" })).toBeNull();
    expect(inboundRisk({ "Auto-Submitted": "auto-replied" })).toBe("AUTOMATED_MESSAGE");
    expect(inboundRisk({ "Authentication-Results": "dmarc=fail; spf=pass" })).toBe(
      "AUTHENTICATION_UNCONFIRMED",
    );
    expect(mailbox("Customer <CUSTOMER@example.test>")).toBe("customer@example.test");
    expect(
      inboundRisk(
        { "Authentication-Results": "mx; spf=pass smtp.mailfrom=attacker.test" },
        "owner@example.test",
      ),
    ).toBe("SENDER_AUTHENTICATION_NOT_ALIGNED");
    expect(
      inboundRisk(
        { "Authentication-Results": "mx; dmarc=pass header.from=example.test" },
        "owner@example.test",
      ),
    ).toBeNull();
  });
  it("displays only inert body text and separates quotations", () => {
    expect(
      inboundText({ html: "<script>alert(1)</script><p>Hello</p><img src='tracker'>" }).bodyText,
    ).toBe("Hello");
    expect(inboundText({ text: "My reply\nOn Monday someone wrote:\n> quoted" })).toEqual({
      bodyText: "My reply",
      quotedText: "\nOn Monday someone wrote:\n> quoted",
    });
  });
});
