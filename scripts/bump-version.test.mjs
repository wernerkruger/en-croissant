import { describe, expect, it } from "vitest";
import { bumpVersion } from "./bump-version.mjs";

describe("bumpVersion", () => {
  it("increments patch within a minor line", () => {
    expect(bumpVersion("0.17.1")).toBe("0.17.2");
    expect(bumpVersion("0.17.8")).toBe("0.17.9");
  });

  it("rolls minor after patch 9", () => {
    expect(bumpVersion("0.17.9")).toBe("0.18.0");
    expect(bumpVersion("0.18.0")).toBe("0.18.1");
    expect(bumpVersion("0.18.9")).toBe("0.19.0");
  });
});
