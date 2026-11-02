# Connect customer replies and recover older messages

The code ingests replies through Resend webhooks. An email visible in Resend's receiving list is not automatically an app message. Complete setup first, then recover older replies separately.

## 1. Register the receiving webhook

1. Deploy the updated backend and frontend. Confirm the backend can connect to its MongoDB replica set. Normal backend startup creates the added diagnostic/recovery indexes and starts the email worker.
2. In **Resend → Webhooks → Add webhook**, enter:

   ```text
   https://YOUR-BACKEND-HOST/api/webhooks/email/resend
   ```

   Use the public HTTPS backend address. The endpoint must accept provider requests without a browser login. For local development, use a public HTTPS tunnel forwarding to the local API (the Windows Docker setup uses port **4001**); use a permanent backend URL for production. Resend cannot reach `localhost` directly.

3. Subscribe to these events:

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

4. Copy the endpoint's **signing secret** into the backend environment. It usually begins with `whsec_`. Set the callback URL to the same address registered above:

   ```dotenv
   RESEND_WEBHOOK_SECRET=YOUR_WEBHOOK_SIGNING_SECRET
   EMAIL_WEBHOOK_URL=https://YOUR-BACKEND-HOST/api/webhooks/email/resend
   ORDER_EMAIL_INBOX_ENABLED=true
   ```

   Keep the existing `EMAIL_PROVIDER=resend`, Full access `RESEND_API_KEY`, verified `RESEND_EMAIL_FROM`, `EMAIL_RECEIVING_DOMAIN`, and stable `EMAIL_PAYLOAD_SECRET`. The signing secret and API key are different. Set these on the backend; none belong in `VITE_*` variables. See [full domain/environment setup](email-setup.md).

5. Restart/redeploy the backend after saving environment values. Reopen **Customer Orders → Inbox** and click **Refresh messages**. Provider configuration is cached for up to 60 seconds.
6. Send a controlled order email, then reply from that order's customer email address. Verify Resend records a successful callback, the worker creates one inbound order message, and the inbox shows the reply. Check notification delivery separately; a selected staff notification recipient does not configure receiving.

The banner stays unverified until the configured endpoint, running worker, and a successfully processed live reply are observed. A callback returning 2xx means the event was saved, not necessarily that processing completed. `INCOMPLETE` indicates missing setup; `DEGRADED` indicates associated failed/review work, excessive delay, or a stale/failing worker. Unmatched messages remain visible only to platform operators, not arbitrary businesses.

## 2. Preview recovery

Run from the backend checkout in the intended environment using its backend secrets and a compatible Node runtime. Use explicit ISO times with an offset. This example selects 2 November in Manila:

```powershell
npm run email:recover -- --environment development --from "2026-11-02T00:00:00+08:00" --to "2026-11-02T23:59:59+08:00" --batch-size 50 --max-items 500
```

Use `--environment production` when `NODE_ENV=production`. The command refuses an environment mismatch. Optional `--business-id <24-hex-id>` and `--order-id <24-hex-id>` narrow the selection. It reports aggregate counts, with no message bodies or customer addresses. Dry-run mode performs no database writes, index creation, notification enqueueing, or application startup migrations.

The receiving list is paginated from newest to oldest across the selected range. `--max-items` bounds each invocation's scanned provider entries, including entries outside the date window; increase it up to 10000 if needed for a preview. `failedRetrieval` and `unavailable` require investigation and another preview; a complete scan does not guarantee every entry could be retrieved or accepted.

## 3. Apply a reviewed recovery

Repeat the chosen command with `--apply` to durably enqueue eligible historical work. The normal worker processes it; the maintenance command itself never sends email.

```powershell
npm run email:recover -- --environment development --from "2026-11-02T00:00:00+08:00" --to "2026-11-02T23:59:59+08:00" --batch-size 50 --max-items 500 --apply
```

Save the returned `runId`. If `complete` is false or a run was interrupted, repeat the same selection with `--apply --run-id <returned-run-id>` to resume its checkpoint. A lease prevents concurrent use of the same run; after an interrupted process, allow up to two minutes for its lease to expire. Repeating a completed run is a no-op; use a new run to revisit retrieval failures. Keep one operator per recovery selection.

Existing stored provider email IDs are skipped. Imported replies keep their original receipt times, appear as recovered/unread messages, and suppress staff notification emails even on retries. Old staff replies are held for review so they cannot resend historical responses to customers. Concurrent normal callbacks and imports share message deduplication; the first committed message's notification policy is retained.

Already quarantined or exhausted jobs remain unchanged unless the command also includes an explicit audit reason:

```text
--requeue --reason "Recheck after receiving policy correction"
```

Requeue re-evaluates current aliases, expected sender, and trusted authentication. It does not approve quarantined mail. Missing/failed provider DMARC, mismatched senders, revoked aliases, or ambiguous matches remain held. Provider callback replay alone does not reset an existing terminal event.

After applying, reconcile `enqueued` work with stored replies and failed/review counts. A provider body, order, or active alias that no longer exists may make recovery impossible. Webhook diagnostic records expire after 30 days; provider availability is checked at recovery time.

## Diagnostics

`GET /api/orders/email-health` requires order view access and returns business-scoped counts. An optional `orderId` is ownership-checked. Highest-role users receive safe setup checks and reasons; ordinary viewers receive status/counts only. No global unmatched-event counts or provider identifiers are exposed. The API preserves access to saved history during receiving problems.

Worker logs include `email_inbound_health`, `email_webhook_retry`, and isolated `email_stage_error` records. Use safe codes and private event IDs for correlation. Do not copy raw headers, bodies, tokens, aliases, database URIs, or credentials into tickets or logs.
