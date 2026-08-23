# Miss V Business API

The backend for Miss V Business, an owner-operated piggery and karenderiya management application. It provides the REST API, authentication, MongoDB persistence, audit history, and the business rules for cash, costing, slaughter, inventory, cooking, and sales.

The API is the source of truth for all financial and inventory calculations. The frontend communicates with it through REST and never imports Mongoose models or connects directly to MongoDB.

## Responsibilities

- Register and authenticate the first and only business owner.
- Verify the owner's email and manage access and refresh sessions.
- Track cash accounts, transactions, expenses, and payments in Philippine pesos.
- Record pig acquisitions, measurements, batches, feed use, and accumulated costs.
- Calculate slaughter yield, meat-part cost, and inventory lots.
- Move meat from the piggery to the karenderiya without creating an internal cash transaction.
- Cost recipes, create menu items, consume ingredients, and record cooking batches.
- Record piggery and karenderiya sales.
- Generate dashboard summaries and date-filtered reports.
- Keep an owner-scoped audit trail of API activity and data changes.

## Technology

- Node.js, Express 5, and TypeScript
- MongoDB and Mongoose
- Valibot request validation
- Decimal.js for calculation-safe decimal arithmetic
- JWT access tokens and rotating refresh-token cookies
- bcrypt credential hashing
- Helmet, CORS, compression, Morgan, and request rate limiting
- Vitest and Supertest
- Biome

## Requirements

- Node.js 22.12 or newer; Node.js 20.19 is also supported by the current toolchain
- npm
- MongoDB running locally or a MongoDB Atlas connection

The default database is `MissVBusiness`.

## Local setup

1. Create the local environment file:

   ```bash
   cp .env.example .env
   ```

2. Start MongoDB or set `MONGODB_URI` to an available MongoDB instance.

3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

The API runs at `http://localhost:4000` by default.

Check the server with:

```bash
curl http://localhost:4000/api/health
```

Expected response:

```json
{"status":"ok","database":"MissVBusiness"}
```

## Environment variables

| Variable | Purpose | Default/example |
| --- | --- | --- |
| `NODE_ENV` | Runtime mode: `development`, `test`, or `production` | `development` |
| `PORT` | HTTP server port | `4000` |
| `MONGODB_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017/MissVBusiness` |
| `JWT_SECRET` | Access-token signing secret; use a long random value in production | development fallback |
| `FRONTEND_URL` | Allowed CORS origin and email-verification link base | `http://localhost:5173` |
| `EMAIL_PROVIDER` | Email delivery through `console` or `resend` | `console` |
| `RESEND_API_KEY` | Resend API key with Sending access | empty |
| `RESEND_EMAIL_FROM` | Sender address on a verified Resend domain | empty |
| `RESEND_EMAIL_FROM_NAME` | Sender display name | `Miss V Business` |
| `EMAIL_VERIFICATION_TTL_MINUTES` | Email-verification link lifetime | `1440` |
| `CREDENTIAL_RESET_TTL_MINUTES` | Password and MPIN reset-link lifetime | `60` |
| `EMAIL_RESEND_COOLDOWN_SECONDS` | Minimum delay between resend requests | `60` |
| `EMAIL_MAX_RESENDS_PER_HOUR` | Maximum verification resends per hour | `5` |
| `ACCESS_TOKEN_TTL_MINUTES` | Access-token lifetime | `15` |
| `REFRESH_TOKEN_TTL_DAYS` | Refresh-session lifetime | `30` |
| `AUTH_COOKIE_SAME_SITE` | Refresh-cookie SameSite setting | `lax` |
| `AUTH_COOKIE_DOMAIN` | Optional shared cookie domain | unset |

Do not commit a populated `.env` file or real credentials.

## Email verification

Local development uses `EMAIL_PROVIDER=console`. The API prints the verification URL to its terminal and includes it in the non-production registration result.

Production email uses Resend. Set `EMAIL_PROVIDER=resend` and configure the API key and sender address on a verified Resend domain. If either required value is missing, the server falls back to console email and prints a warning instead of failing startup.

## Owner authentication

Only the first owner can register. Registration creates:

- the business record;
- the owner account;
- a cash-on-hand account with the supplied opening balance;
- default slaughter costs and meat parts; and
- an audit entry.

The owner must verify their email before signing in. Supported sign-in methods are:

- normalized email plus password; and
- normalized Philippine mobile number plus MPIN.

The API returns a short-lived JWT access token and stores the refresh token in an HTTP-only cookie. Failed credential attempts are rate-limited and can temporarily lock the selected sign-in method.

## API routes

All routes except health and authentication require an owner access token in the `Authorization: Bearer <token>` header.

### Health

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Confirm the API is running |

### Authentication

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/auth/setup-status` | Check whether owner registration is available |
| `POST` | `/api/auth/register` | Register the first owner |
| `POST` | `/api/auth/setup` | Alias for first-owner registration |
| `POST` | `/api/auth/verify-email` | Activate the owner account |
| `POST` | `/api/auth/resend-verification` | Request another verification email |
| `POST` | `/api/auth/login` | Sign in with password or MPIN |
| `POST` | `/api/auth/refresh` | Rotate the refresh session and issue a new access token |
| `POST` | `/api/auth/logout` | Revoke the refresh session |
| `GET` | `/api/auth/me` | Return the authenticated owner |

### Owner modules

| Prefix | Purpose |
| --- | --- |
| `/api/dashboard` | Aggregated cash, piggery, karenderiya, and stock metrics |
| `/api/operations` | Safe transaction workflows that update connected records |
| `/api/resources` | Paginated owner-scoped resources and permitted CRUD operations |
| `/api/calculations` | Slaughter and menu-price previews |
| `/api/reports` | Date-filtered business reports |
| `/api/settings` | Business, costing, owner, and slaughter settings |
| `/api/activity` | Paginated and searchable audit history |

### Transaction operations

The main `/api/operations` endpoints are:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/cash` | Record cash in or cash out |
| `POST` | `/expenses` | Record an expense and optional payment |
| `PATCH/DELETE` | `/expenses/:id` | Correct or remove an eligible expense safely |
| `POST` | `/inventory-receipts` | Receive stock and create its costed lot |
| `POST` | `/feed-usage` | Consume feed and allocate its cost |
| `POST` | `/pig-acquisitions` | Add a pig with linked cost and payment records |
| `DELETE` | `/pig-acquisitions/:id` | Reverse an eligible acquisition |
| `POST` | `/pig-measurements` | Add a weight measurement |
| `POST` | `/slaughters` | Slaughter a pig and create meat inventory |
| `PUT/DELETE` | `/slaughters/:id` | Correct or reverse an eligible slaughter record |
| `POST` | `/meat-transfers` | Transfer meat from piggery to karenderiya stock |
| `POST` | `/piggery-sales` | Sell a pig or piggery meat inventory |
| `POST` | `/cooking-batches` | Consume recipe ingredients for a cooking batch |
| `POST` | `/karenderiya-sales` | Record daily karenderiya sales |
| `PATCH/DELETE` | `/karenderiya-sales/:id` | Correct or remove an eligible sale safely |
| `POST` | `/menu-recipes` | Create a menu item and recipe together |
| `PUT` | `/menu-recipes/:menuId` | Update a menu item and its recipe together |

Route paths in this table are relative to `/api/operations`.

## Resource API

`GET /api/resources/:resource` supports pagination, sorting, and field filters:

```text
?page=1&limit=50&sort=-createdAt
```

Available resources include contacts, cash accounts, cash transactions, expenses, pig batches, pigs, pig measurements, feed usage, slaughter settings, slaughter records, piggery sales, inventory items, inventory lots, inventory movements, recipes, menu items, cooking batches, and karenderiya sales.

Posting-managed records cannot be created or edited directly through the generic resource API. The server returns `409` and requires the matching operation route so cash, inventory, and costing records stay synchronized.

## Business rules

- Currency is Philippine peso (`PHP`).
- Money, quantities, and weights use decimal-safe values; weights are recorded in kilograms.
- Every protected query is scoped to the authenticated business.
- Internal piggery-to-karenderiya transfers move inventory and cost but do not create cash income or expenses.
- Inventory operations create the necessary lots and movements on the server.
- Slaughter correction reverses and rebuilds connected inventory, expense, cash, and pig-status records.
- Slaughter correction or deletion is blocked once generated meat has been transferred, consumed, or sold.
- Menu and recipe creation uses one backend workflow to avoid leaving an orphan recipe.
- Referenced pigs, inventory items, recipes, and menu items cannot be deleted while dependent records still use them.
- Financial and inventory records should be corrected or reversed through their operation route rather than modified directly.

## Source layout

```text
src/
├── config/       # Environment parsing and MongoDB connection
├── lib/          # Decimal, JSON, authentication, and HTTP helpers
├── middleware/   # Authentication, audit, errors, and rate limiting
├── models/       # System, finance, piggery, inventory, and karenderiya models
├── routes/       # Express routers
├── services/     # Posting, costing, reporting, inventory, and sessions
├── types/        # Express type extensions
├── validation/   # Valibot input schemas
├── app.ts        # Express application
└── server.ts     # Database connection and HTTP startup
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the TypeScript API with file watching |
| `npm run check` | Run Biome and TypeScript validation |
| `npm run typecheck` | Check types without emitting files |
| `npm test` | Run all Vitest tests |
| `npm run build` | Compile the API to `dist/` |
| `npm start` | Run `dist/server.js` |
| `npm run format` | Apply Biome formatting and safe fixes |

## Tests

The test suite covers calculation behavior, activity auditing, JSON conversion, and authentication utilities.

```bash
npm run check
npm test
npm run build
```

## Production deployment

1. Set `NODE_ENV=production`.
2. Configure a production MongoDB URI and a strong unique `JWT_SECRET`.
3. Set `FRONTEND_URL` to the exact deployed frontend origin.
4. Configure Resend and a sender address on a verified domain.
5. Run `npm install`, `npm run check`, `npm test`, and `npm run build`.
6. Start the compiled server with `npm start`.
7. Use HTTPS and back up MongoDB regularly.

If the frontend and API are on different sites, set `AUTH_COOKIE_SAME_SITE=none`. Production and cross-site refresh cookies are marked secure by the API.
