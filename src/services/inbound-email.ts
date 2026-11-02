import * as v from "valibot";

const addresses = v.optional(v.nullable(v.array(v.pipe(v.string(), v.maxLength(320)))), []);
const receivedEmailSchema = v.object({
  id: v.optional(v.string()),
  from: v.pipe(v.string(), v.minLength(1), v.maxLength(320)),
  to: addresses,
  cc: addresses,
  bcc: addresses,
  received_for: addresses,
  created_at: v.optional(v.string()),
  message_id: v.optional(v.string()),
  text: v.optional(v.nullable(v.string())),
  html: v.optional(v.nullable(v.string())),
  headers: v.optional(v.nullable(v.record(v.string(), v.string()))),
  authentication: v.optional(
    v.nullable(
      v.object({
        spf: v.optional(v.string()),
        dkim: v.optional(v.string()),
        dmarc: v.optional(v.string()),
      }),
    ),
  ),
  attachments: v.optional(v.array(v.unknown()), []),
});
export type ReceivedEmail = v.InferOutput<typeof receivedEmailSchema>;
const receivedListSchema = v.object({
  has_more: v.boolean(),
  data: v.array(
    v.object({ id: v.pipe(v.string(), v.minLength(1), v.maxLength(200)), created_at: v.string() }),
  ),
});
const webhookListSchema = v.object({
  has_more: v.boolean(),
  data: v.array(
    v.object({
      id: v.string(),
      status: v.string(),
      endpoint: v.string(),
      events: v.nullable(v.array(v.string())),
    }),
  ),
});
export function parseReceivedList(value: unknown) {
  const result = v.safeParse(receivedListSchema, value);
  if (!result.success) throw new Error("INVALID_RECEIVING_LIST");
  return result.output;
}
export function parseWebhookList(value: unknown) {
  const result = v.safeParse(webhookListSchema, value);
  if (!result.success) throw new Error("INVALID_WEBHOOK_LIST");
  return result.output;
}
export function parseReceivedEmail(value: unknown): ReceivedEmail {
  const result = v.safeParse(receivedEmailSchema, value);
  if (!result.success) throw new Error("INVALID_RECEIVED_EMAIL");
  return result.output;
}
export function mailbox(value: string) {
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value;
  return address.trim().toLowerCase();
}
export function recipientCandidates(mail: ReceivedEmail) {
  const candidates = new Map<string, string[]>();
  for (const field of ["to", "cc", "bcc", "received_for"] as const) {
    for (const address of mail[field] ?? []) {
      const normalized = mailbox(address);
      // Stored aliases establish supported domains, including historical ones.
      if (!/^reply-[a-f0-9]{48}@[a-z0-9.-]+$/.test(normalized)) continue;
      candidates.set(normalized, [...(candidates.get(normalized) ?? []), field]);
    }
  }
  return candidates;
}
export const INBOUND_POLICY_VERSION = "provider-dmarc-v1";
export function inboundRisk(
  headers: Record<string, string>,
  authentication?: ReceivedEmail["authentication"],
) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  if (
    /auto-(?:replied|generated)/i.test(normalized["auto-submitted"] ?? "") ||
    /bulk|list|junk/i.test(normalized.precedence ?? "") ||
    /mailer-daemon|postmaster/i.test(normalized.from ?? "")
  )
    return "AUTOMATED_MESSAGE";
  if (/yes|true/i.test(normalized["x-spam-flag"] ?? "")) return "SPAM";
  if (authentication?.dmarc !== "pass") return "AUTHENTICATION_UNCONFIRMED";
  return null;
}
