/* Catppuccin auto-theme checks: palette completeness, light-query discipline,
   no hardcoded UI colors, and the JS scheme helper. */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(new URL(".", import.meta.url).pathname, "..");
const css = readFileSync(join(root, "public", "styles.css"), "utf8");
const js = readFileSync(join(root, "public", "app.js"), "utf8");

const NAMES = ["rosewater","flamingo","pink","mauve","red","maroon","peach","yellow","green","teal","sky","sapphire","blue","lavender","text","subtext1","subtext0","overlay2","overlay1","overlay0","surface2","surface1","surface0","base","mantle","crust"];
const MOCHA: Record<string, string> = { rosewater:"#f5e0dc",flamingo:"#f2cdcd",pink:"#f5c2e7",mauve:"#cba6f7",red:"#f38ba8",maroon:"#eba0ac",peach:"#fab387",yellow:"#f9e2af",green:"#a6e3a1",teal:"#94e2d5",sky:"#89dceb",sapphire:"#74c7ec",blue:"#89b4fa",lavender:"#b4befe",text:"#cdd6f4",subtext1:"#bac2de",subtext0:"#a6adc8",overlay2:"#9399b2",overlay1:"#7f849c",overlay0:"#6c7086",surface2:"#585b70",surface1:"#45475a",surface0:"#313244",base:"#1e1e2e",mantle:"#181825",crust:"#11111b" };
const LATTE: Record<string, string> = { rosewater:"#dc8a78",flamingo:"#dd7878",pink:"#ea76cb",mauve:"#8839ef",red:"#d20f39",maroon:"#e64553",peach:"#fe640b",yellow:"#df8e1d",green:"#40a02b",teal:"#179299",sky:"#04a5e5",sapphire:"#209fb5",blue:"#1e66f5",lavender:"#7287fd",text:"#4c4f69",subtext1:"#5c5f77",subtext0:"#6c6f85",overlay2:"#7c7f93",overlay1:"#8c8fa1",overlay0:"#9ca0b0",surface2:"#acb0be",surface1:"#bcc0cc",surface0:"#ccd0da",base:"#eff1f5",mantle:"#e6e9ef",crust:"#dce0e8" };

function blockAfter(marker: string) {
  const i = css.indexOf(marker);
  if (i < 0) throw new Error("missing " + marker);
  return css.slice(i, i + 4000);
}

describe("catppuccin palette completeness", () => {
  test("exactly the 26 standard colors exist (no more, no fewer)", () => {
    const defs = [...css.matchAll(/--ctp-([a-z0-9]+)\s*:/g)].map((m) => m[1]);
    const unique = [...new Set(defs)];
    expect(unique.sort()).toEqual([...NAMES].sort());
  });
  test("Mocha values are the official ones", () => {
    const rootBlock = blockAfter(":root {");
    for (const [n, v] of Object.entries(MOCHA)) expect(rootBlock).toContain(`--ctp-${n}: ${v}`);
  });
  test("Latte values are the official ones, inside the light media query", () => {
    const lightBlock = blockAfter("@media (prefers-color-scheme: light)");
    for (const [n, v] of Object.entries(LATTE)) expect(lightBlock).toContain(`--ctp-${n}: ${v}`);
  });
});

describe("light-query discipline", () => {
  test("the light media query overrides only custom properties", () => {
    const i = css.indexOf("@media (prefers-color-scheme: light)");
    expect(i).toBeGreaterThan(-1);
    // extract the full @media block by brace depth
    let depth = 0, start = css.indexOf("{", i), end = start;
    for (let k = start; k < css.length; k++) {
      if (css[k] === "{") depth++;
      if (css[k] === "}") { depth--; if (!depth) { end = k; break; } }
    }
    const seg = css.slice(start, end + 1);
    // every selector inside the media query must be :root
    const selectors = [...seg.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim()).filter((s) => s !== ":root");
    expect(selectors).toEqual([]);
    // every declaration must be a --* custom property
    const decls = [...seg.matchAll(/([a-zA-Z-]+)\s*:/g)].map((m) => m[1]).filter((d) => d !== "prefers-color-scheme");
    for (const d of decls) expect(d.startsWith("--")).toBe(true);
  });
  test("semantic tokens remap to the palette, urgency stays peach and danger stays red", () => {
    expect(css).toContain("--brand: var(--ctp-blue)");
    expect(css).toContain("--urgent: var(--ctp-peach)");
    expect(css).toContain("--danger: var(--ctp-red)");
    expect(css).toContain("--phase-early: var(--ctp-sapphire)");
    expect(css).toContain("--phase-middle: var(--ctp-mauve)");
    expect(css).toContain("--phase-end: var(--ctp-green)");
  });
});

describe("no hardcoded UI colors", () => {
  test("CSS hexes appear only in palette defs, neutral alpha effects, or the gantt stripe", () => {
    const allowed = new Set([...Object.values(MOCHA), ...Object.values(LATTE)]);
    for (const m of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
      const hex = "#" + m[1].toLowerCase();
      if (allowed.has(hex)) continue;
      // neutral rgba()/alpha shadow + white stripe values are declared effects, not UI hues
      const ctx = css.slice(Math.max(0, m.index - 60), m.index + 20);
      const ok = /rgba?\(/.test(css.slice(Math.max(0, m.index - 8), m.index)) || ctx.includes("255, 255, 255")
        || (hex === "#ffffff" && ctx.includes("--on-")); // white text on vivid Latte accents
      expect(ok, `hardcoded color ${hex} near: ${ctx.trim()}`).toBe(true);
    }
  });
  test("JS keeps a scheme-aware helper + live media listener", () => {
    expect(js).toContain("matchMedia(\"(prefers-color-scheme: light)\")");
    expect(js).toMatch(/addEventListener\(\s*["']change["']/);
    expect(js).toContain("const ctpScheme");
    expect(js).toContain("const ctp =");
  });
  test("JS static hexes are limited to persisted workspace accents", () => {
    const ws = js.match(/const WS_COLORS = \[([\s\S]*?)\];/);
    expect(ws).not.toBeNull();
    const rest = js.replace(ws![0], "");
    const hexes = [...rest.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => m[0]);
    expect(hexes).toEqual([]);
  });
});
