import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

describe("production mock-data guard", () => {
  it("defines a CI guard that blocks prohibited mock imports in source", () => {
    const pkgPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(pkgPath, "utf8"));

    expect(packageJson.scripts["guard:mock-data"]).toBeDefined();
    expect(packageJson.scripts["ci:guard:mock-data"]).toBeDefined();

    const scriptPath = new URL("../scripts/check-no-prod-mocks.mjs", import.meta.url);
    const scriptText = readFileSync(scriptPath, "utf8");
    expect(scriptText.toLowerCase()).toContain("mock");
  });
});
