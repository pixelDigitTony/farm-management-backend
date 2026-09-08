# Backend verification

Use Node 24, `npm ci`, and a running Docker engine. Database tests always create a new MongoDB replica-set Testcontainer; there is no existing-database fallback. Never supply a development or production database to these suites.

| Command | Evidence |
| --- | --- |
| `npm run check` / `npm run typecheck:tests` | Source and test static checks |
| `npm test` / `npm run test:coverage` | Unit, calendar-date, resource-input and property-based receipt checks |
| `npm run test:architecture` | Dependency boundaries with a nonempty graph requirement |
| `npm run test:integration` | Real transaction rollback, concurrent posting, tenant isolation, authentication, checkout idempotency and stock transitions |
| `LOAD_MODE=smoke npm run test:load` | Isolated k6 inventory-read workload, including correctness and error thresholds |
| `LOAD_MODE=smoke REFRESH_AFTER_SECONDS=3 REQUIRE_SESSION_RENEWAL=1 npm run test:load` | Require successful cookie rotation and session renewal during a short run |

`test:load` requires k6 on PATH, refuses an occupied port 4107, starts its own disposable fixture server, and checks a test-only marker before requests. Each virtual user owns its session and cookie jar. Session renewal defaults to every ten minutes. Production rate limits remain active; high-concurrency tests can expose those limits and should report them rather than silently bypass them. Results are written to `artifacts/load-summary.json`.

Available load profiles are smoke, average, soak, stress, spike and breakpoint. Only authenticated inventory reads are currently modeled. A smoke pass is not capacity evidence. The initial 500 ms p95 threshold is diagnostic, not an agreed production SLO. Mixed writes, end-of-run reconciliation, realistic dataset sizes and extended soak validation remain outstanding.

Application transaction wrappers require a MongoDB replica set. Nested use cases join the outer transaction; no standalone fallback is allowed. Verify deployment topology before release. No production database changes or migration execution are authorized by running these tests.

Remaining work includes source-linked expense protection, cross-business reference validation, operation idempotency, stock-lot consistency, legacy stuck-order recovery, typed repositories/models, contract/security fuzzing, fault recovery, migrations and meaningful mutation/coverage targets. Current suites do not establish all of these properties.
