import { parse } from "valibot";
import { describe, expect, it } from "vitest";
import { menuRecipeOperationSchema } from "../src/validation/operations.js";

function payload(googleDriveUrl?: string | null, googleDriveUrls?: string[], mediaUrls?: string[]) {
  return {
    recipe: {
      recipeCode: "MENU-001",
      name: "Pork adobo",
      yieldServings: 10,
      ingredients: [{ inventoryItemId: "inventory-id", quantity: 1 }],
      estimatedIngredientCostCached: 100,
      estimatedPreparationCostCached: 0,
      estimatedBatchCostCached: 100,
      estimatedCostPerServingCached: 10,
    },
    menu: {
      menuCode: "MENU-001",
      name: "Pork adobo",
      googleDriveUrl,
      googleDriveUrls,
      mediaUrls,
      sellingPricePerServing: 20,
      targetFoodCostPercent: 50,
      calculatedCostPerServingCached: 10,
      calculatedProfitPerServingCached: 10,
      calculatedFoodCostPercentCached: 50,
      suggestedSellingPriceCached: 20,
      isAvailable: true,
    },
  };
}

describe("menu Google Drive media validation", () => {
  it("accepts file sharing links and an explicit empty value", () => {
    const link = "https://drive.google.com/file/d/1Abc_def-234/view?usp=sharing";
    expect(parse(menuRecipeOperationSchema, payload(link)).menu.googleDriveUrl).toBe(link);
    expect(parse(menuRecipeOperationSchema, payload(null)).menu.googleDriveUrl).toBeNull();
  });

  it("accepts multiple Google Drive file links", () => {
    const links = [
      "https://drive.google.com/file/d/photo_123/view?usp=sharing",
      "https://drive.google.com/file/d/video-456/preview",
    ];
    expect(parse(menuRecipeOperationSchema, payload(null, links)).menu.googleDriveUrls).toEqual(
      links,
    );
  });

  it("accepts YouTube, Instagram, and Facebook media links", () => {
    const links = [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ?feature=share",
      "https://www.instagram.com/reel/DExample_123/?igsh=abc",
      "https://instagram.com/p/CExample-456/",
      "https://www.facebook.com/MissVBusiness/videos/123456789012345/",
      "https://www.facebook.com/watch/?v=123456789012345",
      "https://www.facebook.com/reel/123456789012345/",
      "https://www.facebook.com/share/v/Abc_123-xyz/",
      "https://web.facebook.com/share/r/Abc_123-xyz/",
      "https://fb.watch/Abc_123-xyz/",
    ];
    expect(parse(menuRecipeOperationSchema, payload(null, [], links)).menu.mediaUrls).toEqual(
      links,
    );
  });

  it("rejects non-Drive and Drive folder links", () => {
    expect(() =>
      parse(menuRecipeOperationSchema, payload("https://example.com/menu-video.mp4")),
    ).toThrow();
    expect(() =>
      parse(menuRecipeOperationSchema, payload("https://drive.google.com/drive/folders/abc123")),
    ).toThrow();
    expect(() =>
      parse(menuRecipeOperationSchema, payload(null, ["https://example.com/photo.jpg"])),
    ).toThrow();
    expect(() =>
      parse(menuRecipeOperationSchema, payload(null, [], ["https://instagram.com/example"])),
    ).toThrow();
    expect(() =>
      parse(menuRecipeOperationSchema, payload(null, [], ["https://facebook.com/example"])),
    ).toThrow();
  });
});
