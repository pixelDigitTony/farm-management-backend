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
export const options = {
  scenarios: { api: { ...profiles[mode], timeUnit: "1s", preAllocatedVUs: 10, maxVUs: 100 } },
  thresholds: {
    business_failures: ["rate<0.01"],
    http_req_failed: ["rate<0.01"],
    // Initial diagnostic budget; tune only from recorded baseline and agreed SLOs.
    http_req_duration: [`p(95)<${__ENV.P95_MS || 500}`],
    dropped_iterations: ["count==0"],
    checks: ["rate>0.99"],
  },
};
export function setup() {
  const result = http.post(
    `${baseURL}/auth/login`,
    JSON.stringify({
      method: "EMAIL_PASSWORD",
      email: "owner@example.test",
      password: "Test-owner-password-2026",
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  if (result.status !== 200 || !result.json("token")) throw new Error("Fixture login failed");
  return { token: result.json("token") };
}
export default function (data) {
  const response = http.get(`${baseURL}/resources/inventory-items?limit=50`, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { operation: "inventory-list" },
  });
  const valid = check(response, {
    "successful inventory read": (r) =>
      r.status === 200 && Array.isArray(r.json("items")) && r.json("total") >= 1,
  });
  businessFailures.add(!valid);
  if (valid) successfulOperations.add(1);
}
