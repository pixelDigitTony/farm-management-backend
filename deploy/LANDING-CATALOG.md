# Landing pages and catalog rollout

Implemented features: category-based collection binding, all-day product availability schedules, private saved-template overwrite, and multiple independent pages with globally unique subdomains.

## Runtime and database

Use the project's supported modern Node runtime. Local verification used installed Node 26.9.0; the older Node 20 installation cannot run the current Testcontainers/architecture dependencies. No new npm dependencies were added.

The application already uses MongoDB transactions. Page creation, publish idempotency, saved-template writes, and audited availability changes also require a replica set. Do not switch these writes to a standalone-database fallback.

## Deployment order

1. Back up the target database and deploy the compatible backend build with new writes disabled by deployment access controls until migration completes.
2. In `farm-management-backend`, run the dry-run command with the intended `MONGODB_URI` configured through the existing environment mechanism:

   ```powershell
   npm.cmd run migrate:landing-catalog
   ```

   The output contains counts and preflight conflicts, not connection credentials. Resolve any reported invalid timezone or malformed/colliding slug before applying.

3. Run the migration once its dry-run report is clear:

   ```powershell
   npm.cmd run migrate:landing-catalog -- --apply
   ```

   The migration is repeatable. It resolves stable, source-specific category IDs, backfills missing schedules to Always using the business timezone, records revision baselines and the explicit legacy page, replaces the obsolete unique businessId index with a listing index, and creates the new template/operation indexes. It preserves existing page IDs, slugs, snapshots, products' manual active/orderable flags, and orders. It does not automatically broaden legacy item selections.

4. Deploy the frontend build and allow the new editor/catalog writes. Existing installations need the index migration before they can create a second page; editing a Mongoose index declaration alone does not remove the old database constraint.
5. Verify the existing `PUBLIC_SITE_BASE_DOMAIN` / `VITE_PUBLIC_SITE_BASE_DOMAIN` configuration, wildcard DNS, wildcard TLS, frontend host routing, API CORS, image delivery, and cookie behavior for two distinct page subdomains. Environments without a base domain continue to use `/site/:slug`.

`RESERVED_PUBLIC_SITE_SLUGS` can add comma-separated infrastructure labels to the built-in reserved names `api`, `app`, and `www`. Keep the list consistent across backend instances.

## Merchant behavior

- Landing Page opens a page list. Create landing page makes a new draft destination. Publish as another page clones and publishes the current saved design under another unique address.
- Category selection is explicit: All categories includes future categories; Selected categories includes every eligible current/future product in those category IDs. Clearing a selected list displays none. Legacy product allowlists require an explicit conversion before broadening to categories.
- Availability uses the saved business timezone. Monthly weeks mean dates 1–7, 8–14, 15–21, 22–28, and 29–month end. Always hides recurrence/calendar controls and never overrides manual deactivation or stock/ordering restrictions.
- Save template can update an existing private template under its current ID/name, or create a new named template. Built-in presets stay immutable. Template updates do not change already-published pages.
- Unpublishing and deleting a page retain its subdomain claim. Renaming a subdomain requires confirmation and has no automatic redirect in this release.

## Verification and rollback

Tests use fresh disposable MongoDB replica sets. They do not run this migration against the configured development or production database.

```powershell
npm.cmd test
npm.cmd run test:integration -- tests/integration/landing-catalog-expansion.test.ts tests/integration/landing-catalog-migration.test.ts
```

The frontend script `scripts/verify-landing-catalog-expansion.mjs` requires a disposable fixture API behind the local preview. It verifies the fixture marker and blocks external API traffic. Its default preview is `http://127.0.0.1:4186`; the fixture API was started on port 4119 using `TEST_PORT`. The script captures desktop/mobile screenshots and an accessibility result under `test-results/landing-catalog-expansion`.

After multiple pages exist, do not restore the businessId unique index or deploy a backend that chooses an arbitrary page with `findOne({ businessId })`. Keep the page-aware public/API layer when rolling back frontend changes. Previously published snapshots and legacy item bindings remain readable.

Production database migration and deployed wildcard-domain acceptance require execution in the target environment; local build/browser tests do not establish those results.
