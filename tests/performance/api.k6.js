import { check } from "k6";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";

const baseURL = __ENV.BASE_URL || "http://127.0.0.1:4107/api";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+\/api$/.test(baseURL))
  throw new Error("This workload is restricted to the disposable local fixture server");
const mode = __ENV.LOAD_MODE || "average";
const rate = Number(__ENV.RATE || 5);
if (!Number.isInteger(rate) || rate < 1) throw new Error("RATE must be a positive integer");
const profiles = {
  smoke: { executor: "constant-arrival-rate", rate: 1, duration: "15s" },
  average: { executor: "constant-arrival-rate", rate, duration: __ENV.DURATION || "3m" },
  soak: { executor: "constant-arrival-rate", rate, duration: __ENV.DURATION || "1h" },
  stress: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    stages: [
      { target: rate, duration: "1m" },
      { target: rate * 2, duration: "3m" },
      { target: 1, duration: "1m" },
    ],
  },
  spike: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    stages: [
      { target: 1, duration: "30s" },
      { target: rate * 5, duration: "10s" },
      { target: rate * 5, duration: "30s" },
      { target: 1, duration: "1m" },
    ],
  },
  breakpoint: {
    executor: "ramping-arrival-rate",
    startRate: 1,
    stages: [
      { target: rate, duration: "1m" },
      { target: rate * 2, duration: "1m" },
      { target: rate * 4, duration: "1m" },
      { target: rate * 8, duration: "1m" },
    ],
  },
};
if (!profiles[mode]) throw new Error("Unknown LOAD_MODE");
const businessFailures = new Rate("business_failures");
const successfulOperations = new Counter("successful_operations");
const sessionRenewals = new Counter("session_renewals");
export const options = {
  noCookiesReset: true,
  scenarios: { api: { ...profiles[mode], timeUnit: "1s", preAllocatedVUs: 10, maxVUs: 100 } },
  thresholds: {
    business_failures: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
    // Initial diagnostic budget; tune only from recorded baseline and agreed SLOs.
    http_req_duration: [`p(95)<${__ENV.P95_MS || 500}`],
    dropped_iterations: ["count==0"],
    checks: ["rate>0.99"],
    ...(__ENV.REQUIRE_SESSION_RENEWAL === "1" ? { session_renewals: ["count>0"] } : {}),
  },
};
export function setup() {
  const fixture = http.get(`${baseURL}/__test/fixture`);
  if (fixture.status !== 200 || fixture.json("kind") !== "farm-disposable-fixture-v1")
    throw new Error("Load testing requires the newly seeded Testcontainer fixture server");
}
let token;
let authenticatedAt = 0;
const refreshAfterMs = Number(__ENV.REFRESH_AFTER_SECONDS || 600) * 1000;
if (!Number.isFinite(refreshAfterMs) || refreshAfterMs < 1000)
  throw new Error("REFRESH_AFTER_SECONDS must be at least 1");

function accessToken() {
  if (token && Date.now() - authenticatedAt < refreshAfterMs) return token;
  if (token) {
    const refreshed = http.post(`${baseURL}/auth/refresh`, null, {
      tags: { operation: "session-refresh" },
    });
    if (refreshed.status !== 200 || !refreshed.json("token"))
      throw new Error("Fixture session renewal failed");
    token = refreshed.json("token");
    sessionRenewals.add(1);
    authenticatedAt = Date.now();
    return token;
  }
  const result = http.post(
    `${baseURL}/auth/login`,
    JSON.stringify({
      method: "EMAIL_PASSWORD",
      email: "owner@example.test",
      password: "Test-owner-password-2026",
    }),
    { headers: { "Content-Type": "application/json" }, tags: { operation: "session-login" } },
  );
  if (result.status !== 200 || !result.json("token")) throw new Error("Fixture login failed");
  token = result.json("token");
  authenticatedAt = Date.now();
  return token;
}
export default function () {
  let authorization;
  try {
    authorization = accessToken();
  } catch (error) {
    businessFailures.add(true);
    throw error;
  }
  const response = http.get(`${baseURL}/resources/inventory-items?limit=50`, {
    headers: { Authorization: `Bearer ${authorization}` },
    tags: { operation: "inventory-list" },
  });
  const valid = check(response, {
    "successful inventory read": (r) =>
      r.status === 200 && Array.isArray(r.json("items")) && r.json("total") >= 1,
  });
  businessFailures.add(!valid);
  if (valid) successfulOperations.add(1);
}
