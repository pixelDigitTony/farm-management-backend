import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  inactiveAccess,
  localInstant,
  parseAccess,
  resolveLandingAccess,
} from "../src/lib/landing-access.js";
import { createLandingPreset } from "../src/services/landing-presets.js";
import { assertPublishReady } from "../src/services/landing-publish-readiness.js";
import { landingPageVariantUpdateSchema } from "../src/validation/landing-page.js";

const now = new Date("2030-01-01T00:00:00Z");
const page = { isPublished: true, publishedSnapshot: {} };
describe("landing access", () => {
  it("preserves legacy live links and rejects unpublished/archived snapshots", () => {
    expect(resolveLandingAccess(page, now).isAccessible).toBe(true);
    expect(resolveLandingAccess({ ...page, isPublished: false }, now).isAccessible).toBe(false);
    expect(resolveLandingAccess({ ...page, isArchived: true }, now).isAccessible).toBe(false);
    expect(resolveLandingAccess({ ...page, publishedSnapshot: null }, now).isAccessible).toBe(
      false,
    );
    expect(
      resolveLandingAccess({ ...page, publicAccess: inactiveAccess() }, now).accessStatus,
    ).toBe("Inactive");
  });
  it("opens at inclusive start and closes at exclusive end without a worker", () => {
    const publicAccess = parseAccess(
      {
        mode: "LIMITED",
        timezone: "Asia/Manila",
        startLocal: "2030-01-01T09:00",
        endLocal: "2030-01-01T10:00",
      },
      now,
    );
    const timed = { ...page, publicAccess };
    expect(resolveLandingAccess(timed, now)).toMatchObject({
      accessStatus: "Scheduled",
      nextTransitionAt: "2030-01-01T01:00:00.000Z",
    });
    expect(resolveLandingAccess(timed, new Date("2030-01-01T01:00:00Z"))).toMatchObject({
      isAccessible: true,
      nextTransitionAt: "2030-01-01T02:00:00.000Z",
    });
    expect(resolveLandingAccess(timed, new Date("2030-01-01T02:00:00Z"))).toMatchObject({
      isAccessible: false,
      accessStatus: "Expired",
      nextTransitionAt: null,
    });
  });
  it("supports start now and rejects elapsed or reversed windows", () => {
    expect(
      parseAccess(
        { mode: "LIMITED", timezone: "UTC", startNow: true, endLocal: "2030-01-01T01:00" },
        now,
      ).startsAt,
    ).toEqual(now);
    for (const endLocal of ["2029-12-31T23:59", "2030-01-01T00:00"])
      expect(() =>
        parseAccess({ mode: "LIMITED", timezone: "UTC", startNow: true, endLocal }, now),
      ).toThrow("End time");
    expect(() =>
      parseAccess({ mode: "SCHEDULED", timezone: "UTC", startLocal: "2029-12-31T23:59" }, now),
    ).toThrow("future");
    expect(() =>
      parseAccess({ mode: "SCHEDULED", timezone: "invalid", startLocal: "2030-01-01T01:00" }, now),
    ).toThrow("timezone");
  });
  it("rejects invalid dates and DST gaps/repeated hours", () => {
    for (const value of ["2030-02-30T12:00", "2030-01-01", "2030-03-10T02:30", "2030-11-03T01:30"])
      expect(() => localInstant(value, "America/New_York")).toThrow();
  });
  it("saves incomplete testimonials but gates effectively visible entries when publishing", () => {
    const design = createLandingPreset(
      "everyday-boutique",
      undefined,
      undefined,
      { businessName: "Test" },
      [],
    );
    const block = design.sections
      .flatMap((section) => section.components)
      .find((block) => block.type === "TESTIMONIALS");
    if (!block || block.type !== "TESTIMONIALS") throw new Error("Missing testimonials");
    block.content.entries = [{ id: "review", quote: "", author: "", enabled: true }];
    const doc = v.parse(landingPageVariantUpdateSchema, design);
    expect(() => assertPublishReady(doc)).toThrow("Entry 1");
    block.enabled = false;
    expect(() => assertPublishReady(v.parse(landingPageVariantUpdateSchema, design))).not.toThrow();
    block.enabled = true;
    block.content.entries[0]!.enabled = false;
    expect(() => assertPublishReady(v.parse(landingPageVariantUpdateSchema, design))).not.toThrow();
    block.content.entries[0] = {
      id: "review",
      quote: "Great harvest",
      author: "Customer",
      enabled: true,
    };
    expect(() => assertPublishReady(v.parse(landingPageVariantUpdateSchema, design))).not.toThrow();
  });
});
