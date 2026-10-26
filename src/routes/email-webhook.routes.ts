import express, { Router } from "express";
import { Resend } from "resend";
import { env } from "../config/env.js";
import { HttpError } from "../lib/http-error.js";
import { saveWebhook } from "../services/email-webhook.service.js";

export const emailWebhookRouter = Router();
emailWebhookRouter.post(
  "/resend",
  express.raw({ type: "application/json", limit: "256kb" }),
  async (req, res) => {
    if (!env.RESEND_WEBHOOK_SECRET) throw new HttpError(503, "Email webhook is not configured");
    const eventId = req.get("svix-id");
    const timestamp = req.get("svix-timestamp");
    const signature = req.get("svix-signature");
    if (!eventId || eventId.length > 200 || !timestamp || !signature || !Buffer.isBuffer(req.body))
      throw new HttpError(400, "Invalid webhook");
    let event: unknown;
    try {
      event = new Resend(env.RESEND_API_KEY ?? "webhook-verification-only").webhooks.verify({
        payload: req.body.toString("utf8"),
        headers: { id: eventId, timestamp, signature },
        webhookSecret: env.RESEND_WEBHOOK_SECRET,
      });
    } catch {
      throw new HttpError(400, "Invalid webhook signature");
    }
    await saveWebhook(eventId, event);
    res.json({ received: true });
  },
);
