// tests/custom-fields-ui.test.ts — cfReadonlyHtml renderer (const arrow from app.js).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

function extractConstArrow(src: string, name: string): string {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\(`).exec(src);
  if (!m) throw new Error("const not found: " + name);
  let i = m.index, depth = 0, str: string | null = null;
  const tplStack: number[] = [];
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (str === "`" && ch === "$" && nx === "{") { tplStack.push(depth + 1); str = null; depth++; i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1] - 1) { tplStack.pop(); str = "`"; continue; }
      if (depth === 0 && !tplStack.length) return src.slice(m.index, i + 1).replace(/;$/, "") + ";";
    }
  }
  throw new Error("unbalanced braces in " + name);
}

const esc = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cfReadonlyHtml: any = new Function("esc", `${extractConstArrow(appSrc, "cfReadonlyHtml")} return cfReadonlyHtml;`)(esc);

describe("cfReadonlyHtml", () => {
  test("renders set fields as pills, skips empty", () => {
    const h = cfReadonlyHtml([
      { id: 1, name: "Region", field_type: "text", value: "EMEA" },
      { id: 2, name: "Notes", field_type: "text", value: "" },
    ]);
    expect(h).toContain("Region");
    expect(h).toContain("EMEA");
    expect(h).not.toContain("Notes");
  });
  test("checkbox renders ✓ / —", () => {
    expect(cfReadonlyHtml([{ id: 1, name: "VIP", field_type: "checkbox", value: "1" }])).toContain("✓");
    expect(cfReadonlyHtml([{ id: 1, name: "VIP", field_type: "checkbox", value: "0" }])).toContain("—");
  });
  test("empty / missing input renders nothing", () => {
    expect(cfReadonlyHtml([])).toBe("");
    expect(cfReadonlyHtml(undefined)).toBe("");
  });
  test("escapes HTML", () => {
    const h = cfReadonlyHtml([{ id: 1, name: "X", field_type: "text", value: "<script>" }]);
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});
