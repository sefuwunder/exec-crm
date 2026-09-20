// tests/milton-widgets-ui.test.ts — widget card rendering (pure functions from app.js).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
const indexSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");

function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index + m[0].length - 1, pdepth = 0;
  let str: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "(") pdepth++;
    else if (ch === ")") { if (--pdepth === 0) break; }
  }
  let depth = 0;
  str = null;
  const tplStack: number[] = [];
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (str === "`" && ch === "$" && nx === "{") { tplStack.push(depth + 1); str = null; depth++; i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "/" && nx === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") { i += 2; while (!(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1] - 1) { tplStack.pop(); str = "`"; continue; }
      if (depth === 0 && !tplStack.length) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

// Local mirrors of the app.js helpers the widget renderers depend on.
const esc = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const moneyShort = (n: any) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n);
};
const evalScope: any = { esc, moneyShort };
const load = (name: string) => {
  const fn = new Function(...Object.keys(evalScope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(evalScope));
  evalScope[name] = fn;
  return fn;
};

const mwRelTime = load("mwRelTime");
const mwFormatBarValue = load("mwFormatBarValue");
const mwCardHtml = load("mwCardHtml");

describe("milton widget renderers", () => {
  test("mwRelTime buckets", () => {
    const now = Date.now();
    expect(mwRelTime(now - 10000)).toBe("just now");
    expect(mwRelTime(now - 5 * 60000)).toBe("5m ago");
    expect(mwRelTime(now - 3 * 3600000)).toBe("3h ago");
    expect(mwRelTime(now - 2 * 86400000)).toBe("2d ago");
    expect(mwRelTime(now - 30 * 86400000)).toMatch(/\d{4}/); // full date
  });

  test("mwFormatBarValue formats", () => {
    expect(mwFormatBarValue(50000, "currency")).toBe("$50k");
    expect(mwFormatBarValue(1250000, "currency")).toBe("$1.3M");
    expect(mwFormatBarValue(42, "number")).toBe("42");
    expect(mwFormatBarValue(0.856, "percent")).toBe("0.86%");
    expect(mwFormatBarValue("x", undefined)).toBe("—");
  });

  test("stat card renders value, label, delta", () => {
    const h = mwCardHtml({ id: 1, kind: "stat", title: "KPIs", created_at: Date.now(), payload: { value: "$190k", label: "Pipeline", delta: "+12%" } });
    expect(h).toContain("$190k");
    expect(h).toContain("Pipeline");
    expect(h).toContain("+12%");
    expect(h).toContain('data-mw-del="1"');
  });

  test("table card renders headers and rows", () => {
    const h = mwCardHtml({ id: 2, kind: "table", title: "Top deals", created_at: Date.now(),
      payload: { headers: ["Deal", "Value"], rows: [["Acme", "$50k"], ["Globex", "$20k"]] } });
    expect(h).toContain("<th>Deal</th>");
    expect(h).toContain("<td>Acme</td>");
    expect(h).toContain("<td>$20k</td>");
  });

  test("bars card renders labeled bars scaled to max", () => {
    const h = mwCardHtml({ id: 3, kind: "bars", title: "Campaigns", created_at: Date.now(),
      payload: { items: [{ label: "Q4", value: 50000 }, { label: "Q1", value: 25000 }], format: "currency" } });
    expect(h).toContain("Q4");
    expect(h).toContain("$50k");
    expect(h).toContain('style="width:100%"');
    expect(h).toContain('style="width:50%"');
  });

  test("list card renders items with subs", () => {
    const h = mwCardHtml({ id: 4, kind: "list", title: "Closing soon", created_at: Date.now(),
      payload: { items: [{ text: "Acme", sub: "closes tomorrow" }, { text: "Globex" }] } });
    expect(h).toContain("Acme");
    expect(h).toContain("closes tomorrow");
    expect(h).toContain("Globex");
  });

  test("escapes hostile content", () => {
    const h = mwCardHtml({ id: 5, kind: "stat", title: "<script>alert(1)</script>", created_at: Date.now(),
      payload: { value: "<b>x</b>", label: "L" } });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  test("unknown kind gets a fallback", () => {
    const h = mwCardHtml({ id: 6, kind: "pie", title: "?", created_at: Date.now(), payload: {} });
    expect(h).toContain("Unknown widget kind");
  });

  test("nav + title wiring exists", () => {
    expect(indexSrc).toContain('href="#/milton"');
    expect(indexSrc).toContain('data-r="milton"');
    expect(appSrc).toMatch(/milton:\s*"Milton"/);
    expect(appSrc).toContain("milton: vMilton");
  });
});
