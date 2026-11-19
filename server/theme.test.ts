import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import postcss from "postcss";
import { defaultPreferences } from "../shared/app-types";

const css = postcss.parse(readFileSync("client/src/index.css", "utf8"));
function value(selector: string, property: string): string {
  let found = "";
  css.walkRules(rule => {
    if (
      rule.parent?.type !== "root" ||
      rule.selector.replace(/\s+/g, " ") !== selector
    )
      return;
    rule.walkDecls(property, declaration => {
      found = declaration.value.replace(/\s*!important$/, "");
    });
  });
  return found;
}
function luminance(hex: string) {
  const full = hex.replace("#", "");
  const rgb = [0, 2, 4]
    .map(i => parseInt(full.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}
describe("gamer neon visual system", () => {
  it("uses midnight surfaces and vivid neon defaults", () => {
    expect(value(":root", "--background")).toBe("#090b14");
    expect(value(":root", "--card")).toBe("#121625");
    expect(value(":root", "--cyan")).toBe("#00e5ff");
    expect(value(":root", "--violet")).toBe("#a855f7");
    expect(value(":root", "--pink")).toBe("#ff3da6");
    expect(value(":root", "--acid")).toBe("#b6ff3b");
    expect(defaultPreferences.accent).toBe("#00E5FF");
  });
  it("keeps normal and muted body text readable on dark panels", () => {
    expect(
      contrast(value(":root", "--foreground"), value(":root", "--background"))
    ).toBeGreaterThan(7);
    expect(
      contrast(value(":root", "--muted"), value(":root", "--card"))
    ).toBeGreaterThan(4.5);
  });
  it("uses dark readable text on cyan and lime action surfaces", () => {
    expect(
      contrast(value(".btn.primary", "color"), value(":root", "--cyan"))
    ).toBeGreaterThan(7);
    expect(
      contrast(value(".clip-btn", "color"), value(":root", "--acid"))
    ).toBeGreaterThan(7);
  });
  it("keeps private workspace surfaces dark including input controls and dialogs", () => {
    expect(value(".modal", "background")).toBe("#121625");
    expect(value(".sidekick-panel", "background")).toBe("#111424");
    expect(
      value(".caption-row input, .caption-row textarea", "background")
    ).toBe("#0c101d");
  });
  it("matches installation and browser chrome to the gaming theme", () => {
    const manifest = JSON.parse(
      readFileSync("client/public/manifest.webmanifest", "utf8")
    );
    expect(manifest.background_color).toBe("#090b14");
    expect(manifest.theme_color).toBe("#090b14");
    const app = readFileSync("client/src/App.tsx", "utf8");
    expect(app).toContain('defaultTheme="dark"');
    expect(app).toContain('theme="dark"');
  });
});
