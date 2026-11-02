import { ipKeyGenerator } from "express-rate-limit";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app.js";
import {
  publicContentLimiter,
  publicImageLimiter,
  publicOrderLimiter,
} from "../src/middleware/rate-limit.js";
import { LandingPage } from "../src/models/index.js";

beforeEach(async () => {
  for (const limiter of [publicContentLimiter, publicImageLimiter, publicOrderLimiter]) {
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "::1"])
      await limiter.resetKey(ipKeyGenerator(ip));
  }
  vi.spyOn(LandingPage, "findOne").mockReturnValue({ lean: async () => null } as never);
});
afterEach(() => vi.restoreAllMocks());
const page = () => request(app).get("/api/public/landing-pages/rate-limit-fixture");
const image = () => request(app).get("/api/public/images/not-an-image-id");
// All traffic uses the real app routing/limiters. Missing fixtures stop before any
// database access, while consuming the same allowances as successful requests.
async function repeat(count: number, send: () => ReturnType<typeof page>, status: number) {
  for (let offset = 0; offset < count; offset += 20) {
    const responses = await Promise.all(Array.from({ length: Math.min(20, count - offset) }, send));
    expect(responses.every((response) => response.status === status)).toBe(true);
  }
}
describe("public landing request budgets", () => {
  it("keeps analytics traffic out of the page allowance and retains its own cap", async () => {
    const event = () =>
      request(app).post("/api/public/landing-pages/rate-limit-fixture/events").send({});
    await repeat(120, event, 422);
    await event().expect(429);
    const response = await page().expect(404);
    expect(response.headers.ratelimit).toContain('"landing-pages"; r=299');
  });
  it("keeps an image-heavy catalog from exhausting page reads", async () => {
    await repeat(350, image, 404);
    const response = await page().expect(404);
    expect(response.headers.ratelimit).toContain('"landing-pages"; r=299');
  });
  it("still limits page traffic and leaves the image budget available", async () => {
    await repeat(300, page, 404);
    const blocked = await page().expect(429);
    expect(blocked.body.code).toBe("RATE_LIMITED");
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    const response = await image().expect(404);
    expect(response.headers.ratelimit).toContain('"public-images"; r=599');
  });
  it("limits image bursts independently while the page remains accessible", async () => {
    await repeat(600, image, 404);
    await image().expect(429);
    await page().expect(404);
  });
  it("keeps the existing order allowance separate from page and image requests", async () => {
    const order = () =>
      request(app).post("/api/public/landing-pages/rate-limit-fixture/orders").send({});
    await repeat(20, order, 422);
    await order().expect(429);
    const response = await page().expect(404);
    expect(response.headers.ratelimit).toContain('"landing-pages"; r=299');
    await image().expect(404);
  });
});
