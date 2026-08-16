import { Resend } from "resend";
import { env } from "../config/env.js";

export type EmailDeliveryResult = {
  provider: "RESEND" | "CONSOLE";
  status: "SENT" | "QUEUED" | "DELIVERED" | "BOUNCED";
  messageId: string | null;
};

type VerificationEmail = {
  recipientName: string;
  recipientEmail: string;
  verificationUrl: string;
  expiresAt: Date;
};

const escapeHtml = (value: string) =>
  value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });

class ResendEmailService {
  private readonly client = new Resend(env.RESEND_API_KEY);

  async sendVerificationEmail(input: VerificationEmail): Promise<EmailDeliveryResult> {
    const { data, error } = await this.client.emails.send({
      to: input.recipientEmail,
      from: `${env.RESEND_EMAIL_FROM_NAME} <${env.RESEND_EMAIL_FROM}>`,
      subject: "Verify your Miss V Business email",
      html: verificationHtml(input),
      text: verificationText(input),
    });
    if (error) {
      const deliveryError = new Error(error.message);
      deliveryError.name = error.name ?? "RESEND_ERROR";
      throw deliveryError;
    }
    return { provider: "RESEND", status: "SENT", messageId: data?.id ?? null };
  }
}

class ConsoleEmailService {
  async sendVerificationEmail(input: VerificationEmail): Promise<EmailDeliveryResult> {
    console.info(`[development email] Verify ${input.recipientEmail}: ${input.verificationUrl}`);
    return { provider: "CONSOLE", status: "SENT", messageId: null };
  }
}

function verificationHtml(input: VerificationEmail) {
  const name = escapeHtml(input.recipientName);
  const url = escapeHtml(input.verificationUrl);
  return `<!doctype html><html><body style="margin:0;background:#f7f6f1;font-family:Arial,sans-serif;color:#292524"><div style="max-width:560px;margin:40px auto;background:#fff;border:1px solid #e7e5e4;border-radius:20px;padding:36px"><div style="color:#166534;font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase">Miss V Business</div><h1 style="font-size:28px;margin:16px 0 8px">Verify your email</h1><p style="color:#57534e;line-height:1.6">Hello ${name}, confirm this email address to activate your owner account.</p><a href="${url}" style="display:inline-block;margin:20px 0;padding:14px 22px;background:#183b2b;color:#fff;text-decoration:none;border-radius:12px;font-weight:700">Verify email address</a><p style="font-size:13px;color:#78716c;line-height:1.5">This link expires ${escapeHtml(input.expiresAt.toLocaleString("en-PH", { timeZone: "Asia/Manila" }))}. If you did not register, you can ignore this message.</p></div></body></html>`;
}

function verificationText(input: VerificationEmail) {
  return `Hello ${input.recipientName},\n\nVerify your Miss V Business email: ${input.verificationUrl}\n\nThis link expires ${input.expiresAt.toISOString()}. If you did not register, ignore this message.`;
}

export const emailService =
  env.EMAIL_PROVIDER === "resend" ? new ResendEmailService() : new ConsoleEmailService();
