import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { EMAIL_PROVIDER: "resend", RESEND_API_KEY: "fixture-api-key" },
}));

import { emailService } from "../src/services/email.service.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("receiving adapter", () => {
  it("preserves provider authentication, bounds requests and requests CID images", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          from: "buyer@example.test",
          to: [],
          authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
          text: "Reply",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await emailService.getReceived("mail/id")).toMatchObject({
      authentication: { dmarc: "pass" },
    });
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toContain("/emails/receiving/mail%2Fid?html_format=cid");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer fixture-api-key");
  });
  it("paginates and verifies the exact registered endpoint", async () => {
    const endpoint = "https://backend.example.test/api/webhooks/email/resend";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            has_more: true,
            data: [{ id: "first", status: "disabled", endpoint, events: ["email.received"] }],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            has_more: false,
            data: [{ id: "second", status: "enabled", endpoint, events: ["email.received"] }],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    expect(await emailService.receivingWebhookConfigured(endpoint)).toBe(true);
    expect(fetcher.mock.calls[1]?.[0]).toContain("after=first");
  });
  it("rejects malformed received payloads with a safe code", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ from: "private-marker", to: "malformed" })),
        ),
    );
    await expect(emailService.getReceived("mail")).rejects.toThrow("INVALID_RECEIVED_EMAIL");
  });
});
