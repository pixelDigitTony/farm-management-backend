# Resend setup for verification and order conversations

25 October 2026. Configure these values on the **backend**. No Resend secret belongs in frontend `VITE_*` variables. The app reads deployment environment variables or the backend's local `.env`; the template is [`.env.example`](../.env.example).

## 1. Verify a sending domain

1. In the [Resend dashboard](https://resend.com/domains), add a domain you control. A dedicated sending subdomain such as `mail.example.com` is suitable.
2. Add the DNS records shown by Resend to your DNS provider. Copy their names, types, values, priorities, and region-specific targets exactly. Use the records from your dashboard rather than invented MX/SPF values.
3. Wait until Resend reports that sending is verified. Set the From address to an address at that verified domain, for example `orders@mail.example.com`.

Resend requires a verified owned domain for normal sending and supports sending subdomains. [Official domain guide](https://resend.com/docs/dashboard/domains/introduction)

## 2. Set up a dedicated receiving subdomain

1. Add a separate domain/subdomain such as `replies.example.com` in Resend.
2. Enable **Receiving** on that domain's details page.
3. Copy the receiving MX record displayed by Resend into DNS for **that subdomain**. Keep the existing MX records used by your ordinary business mailbox.
4. Confirm the DNS record in Resend and wait for receiving verification.

The application creates opaque addresses such as `reply-<random value>@replies.example.com` automatically. You do not create a separate mailbox for every order. Configure `EMAIL_RECEIVING_DOMAIN=replies.example.com`, without `https://`, an `@`, or a path. Resend recommends a receiving subdomain when existing mailbox MX records are present. [Official receiving-domain guide](https://resend.com/docs/dashboard/receiving/custom-domains)

For example, `RESEND_EMAIL_FROM=order@missvbusiness.online` is a sender mailbox, while `EMAIL_RECEIVING_DOMAIN=missvbusiness.online` is its receiving domain. Use that root domain only if its receiving MX is verified in Resend. If receiving is instead configured on `replies.missvbusiness.online`, use that subdomain. An entry under Resend **Inboxes** does not by itself establish the domain's receiving DNS status: check **Domains → your domain → Enable Receiving**. This app uses generated reply aliases and the `email.received` webhook, so creating a single `order@...` inbox is not required for routing order replies.

## 3. Create the backend API key

Create a **Full access** API key for this backend: it needs to send mail and retrieve received-email content and sent-message metadata. A sending-only key is insufficient for these retrieval endpoints. Keep the key in your backend deployment's secrets or local `.env` and set `RESEND_API_KEY`. [Official permission definitions](https://resend.com/docs/api-reference/api-keys/create-api-key)

Use separate keys for staging and production where possible. No key value is included in this repository. [Official API-key guide](https://resend.com/docs/dashboard/api-keys/introduction)

## 4. Deploy the webhook endpoint and configure Resend

The endpoint is:

```text
https://YOUR-BACKEND-HOST/api/webhooks/email/resend
```

Use the backend host, not the frontend editor address. In Resend **Webhooks**, add this public HTTPS URL and subscribe to:

```text
email.received
email.sent
email.delivered
email.bounced
email.failed
email.delivery_delayed
email.complained
email.suppressed
```

Copy that webhook's signing secret (normally starting with `whsec_`) into `RESEND_WEBHOOK_SECRET`. It is distinct from the API key. Restart the backend after updating the environment.

For local development, a public HTTPS tunnel can forward this endpoint to the local backend port; Resend cannot call `localhost` directly. Production must use the permanent public HTTPS backend URL. The implementation verifies signatures using the original request bytes and saves valid events before acknowledging them. [Official webhook guide](https://resend.com/docs/webhooks/introduction), [signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests)

## 5. Set backend environment values

Replace the example hosts/addresses with your verified values:

```dotenv
EMAIL_PROVIDER=resend
RESEND_API_KEY=REPLACE_WITH_BACKEND_API_KEY
RESEND_EMAIL_FROM=orders@mail.example.com
RESEND_EMAIL_FROM_NAME=Your Business

FRONTEND_URL=https://YOUR-FRONTEND-HOST
RESEND_WEBHOOK_SECRET=REPLACE_WITH_WEBHOOK_SIGNING_SECRET
EMAIL_RECEIVING_DOMAIN=replies.example.com
EMAIL_PAYLOAD_SECRET=REPLACE_WITH_A_NEW_RANDOM_SECRET_AT_LEAST_32_CHARACTERS

ORDER_EMAIL_INBOX_ENABLED=true
ORDER_MESSAGE_RETENTION_DAYS=365
LANDING_ANALYTICS_ENABLED=true

EMAIL_VERIFICATION_TTL_MINUTES=1440
EMAIL_RESEND_COOLDOWN_SECONDS=60
EMAIL_MAX_RESENDS_PER_HOUR=5
```

Generate the payload secret once with:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the output directly in your backend secret/environment settings. Retain the same value across restarts and instances: encrypted queued email and reply aliases depend on it. Changing it requires a planned key migration. Keep the existing database URI and strong JWT secret configured as usual; do not replace them with placeholders.

`FRONTEND_URL` is the site that serves `/verify-email`, not the API address. In production it must use public HTTPS. The backend refuses production startup if email credentials or the payload secret are absent, or if order messaging is enabled without its receiving-domain/webhook settings.

During partial setup, keep `ORDER_EMAIL_INBOX_ENABLED=false`. Verification sending can be configured first. Enable the inbox after receiving and webhooks are ready. The local console adapter reports **Development only — no email sent** and is rejected in production.

## 6. Run the backend continuously

Build and restart the backend with the environment above. Its normal server process runs the durable email worker every five seconds; a preview of the frontend alone does not send mail. MongoDB must be configured as a replica set because verification issuance and existing business operations use transactions.

The worker claims jobs with a database lease, so multiple backend instances can share the queue. Your hosting service must keep a long-running backend process alive. A serverless request-only deployment needs a continuously running worker using the same code and database; do not rely on a sleeping process to send queued mail.

`GET /api/health` reports the effective provider and whether receiving configuration is present without exposing secrets. Structured server logs include `email_worker_health`, `email_send_failed`, and webhook retry events. “Configured” indicates settings are present; it does not prove DNS verification or mailbox delivery.

## 7. Choose who gets business email notifications

Sign in with the highest business role, open **Customer Orders → Inbox → Email notification recipient**, and select an active, email-verified user with order-edit permission. The owner is used when eligible and unambiguous. This choice is stored per business; a global recipient environment variable is intentionally avoided so separate businesses cannot receive each other's order messages.

Customer replies appear in the inbox and are emailed to that recipient. The recipient can reply from their verified address, or use the app composer. Removing their access stops future email replies from that account.

## 8. Verify with controlled addresses

1. Create an employee using an address you control. Check the account's email delivery state and the corresponding Resend email event. Open its verification link and sign in. Repeat with Resend rejection and resend/cooldown behavior.
2. Submit an order containing a controlled customer email. Confirm one acknowledgement arrives even if the checkout HTTP request is retried.
3. Reply from the customer mailbox. Confirm the message appears in **Customer Orders → Inbox** and the chosen business recipient gets a notification.
4. Reply from the business recipient mailbox. Confirm one response reaches the customer and appears in the same app conversation. Also test the app composer.
5. Check Resend's webhook attempts for `200` responses and delivery state changes. A deliberately incorrect signature should receive `400`.

The inbox conservatively quarantines unknown aliases, unauthorized senders, and missing/failed mail authentication. If Resend receives mail but the conversation does not update, inspect webhook processing state/reason in the protected database and provider headers. Do not disable signature or sender checks to make a test pass. Delivery webhooks indicate acceptance by a mail server; checking the controlled mailbox is still required.

Live provider setup, DNS verification, and controlled mailbox testing remain pending until you complete these steps. Local tests use disposable databases and mocked/console email delivery.

## Troubleshooting startup validation

`EMAIL_RECEIVING_DOMAIN: use a domain only` means a mailbox address or another invalid hostname was entered. Correct the value in the backend environment, then restart or rebuild the backend container so it receives the update. Other environment validation errors list field names without printing values or the environment object.

If an older error log contains a Resend API key, revoke that key in Resend, create a replacement Full access key, and update the backend secret. Do not paste the replacement into logs or support messages.
