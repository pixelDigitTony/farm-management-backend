import { HttpError } from "../lib/http-error.js";
import type { LandingPageVariantInput } from "../validation/landing-page.js";

export function assertPublishReady(document: LandingPageVariantInput) {
  for (const section of document.sections) {
    if (!section.enabled) continue;
    for (const block of section.components) {
      if (!block.enabled || block.type !== "TESTIMONIALS") continue;
      for (const [index, entry] of block.content.entries.entries()) {
        if (!entry.enabled) continue;
        for (const field of ["quote", "author"] as const) {
          if (!entry[field].trim())
            throw new HttpError(
              422,
              `Testimonials → Entry ${index + 1} → ${field === "author" ? "Author: Enter a customer name" : "Quote: Enter a testimonial"} before publishing.`,
              { sectionId: section.id, blockId: block.id, entryId: entry.id, field },
              "TESTIMONIAL_INCOMPLETE",
            );
        }
      }
    }
  }
}
