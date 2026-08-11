import { describe, expect, it } from "vitest";
import { PIN_CATEGORIES, markCategory, pinMeta } from "./pinIcons";

describe("markCategory", () => {
  it("maps DingoNav mark kinds onto badge categories", () => {
    expect(markCategory("camp")).toBe("camp");
    expect(markCategory("fuel")).toBe("fuel");
    expect(markCategory("creek")).toBe("creek");
    expect(markCategory("lookout")).toBe("lookout");
    expect(markCategory("gate")).toBe("gate");
    expect(markCategory("obstacle")).toBe("obstacle");
    expect(markCategory("food")).toBe("food");
    expect(markCategory("pub")).toBe("food");
    expect(markCategory("danger")).toBe("hazard");
  });

  it("falls back to the display name when the doc predates `kind`", () => {
    expect(markCategory(null, "Camp")).toBe("camp");
    expect(markCategory(undefined, "Pub / food")).toBe("food");
    expect(markCategory(null, "Danger !!!")).toBe("hazard");
    // The oldest docs published the bare slug as the name.
    expect(markCategory(null, "lookout")).toBe("lookout");
  });

  it("falls back to the generic pin for anything unknown", () => {
    expect(markCategory("wormhole")).toBe("poi");
    expect(markCategory(null, null)).toBe("poi");
    expect(markCategory("", "")).toBe("poi");
  });
});

describe("PIN_CATEGORIES", () => {
  it("covers every POI category the daemon publishes", () => {
    for (const c of [
      "fuel", "camp", "water", "food", "lodging",
      "medical", "hazard", "info", "summit", "scenic", "poi",
    ]) {
      expect(PIN_CATEGORIES[c], c).toBeDefined();
    }
  });

  it("gives an unknown category the grey generic pin", () => {
    expect(pinMeta("nope")).toBe(PIN_CATEGORIES.poi);
    expect(pinMeta(null).glyph).toBe("map-pin");
  });
});
