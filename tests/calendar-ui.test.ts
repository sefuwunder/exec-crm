// tests/calendar-ui.test.ts — month-grid calendar rendering (pure functions from app.js).
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
const indexSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");

// Extract a top-level `function name(...)` (optionally async) block from app.js.
// Brace counting skips strings/comments AND the parameter list (so default
// values like `opts = {}` don't confuse it); valid for the small helpers tested here.
function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  // skip the parameter list: from the opening "(" to its match
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

// Local mirrors of the app.js helpers the calendar renderers depend on.
const esc = (s: any) =>
  String(s ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const toISODate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const money = (n: any) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");

const CAL_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const evalScope: any = { esc, toISODate, money, CAL_DOW };
const load = (name: string) => {
  const fn = new Function(...Object.keys(evalScope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(evalScope));
  evalScope[name] = fn; // later loads can call earlier ones (monthGridHtml -> calCells)
  return fn;
};

const calCells = load("calCells");
const calVisibleRange = load("calVisibleRange");
const calMonthLabel = load("calMonthLabel");
const monthGridHtml = load("monthGridHtml");
const calDayRowHtml = load("calDayRowHtml");

const deal = (id: number, title: string, date: string, extra: any = {}) =>
  ({ type: "deal", id, title, date, value: 50000, stage: "negotiation", stage_name: "Negotiation", company_name: "Acme", ...extra });
const task = (id: number, title: string, date: string, extra: any = {}) =>
  ({ type: "task", id, title, date, done: 0, deal_title: "", ...extra });

describe("calCells: Monday-first 6-week grid", () => {
  test("September 2026 starts on Mon Aug 31 and ends Sun Oct 11", () => {
    const cells = calCells(2026, 8); // September
    expect(cells).toHaveLength(42);
    expect(cells[0].date).toBe("2026-08-31");
    expect(cells[0].inMonth).toBe(false);
    expect(cells[1].date).toBe("2026-09-01");
    expect(cells[1].inMonth).toBe(true);
    expect(cells[30].date).toBe("2026-09-30");
    expect(cells[30].inMonth).toBe(true);
    expect(cells[41].date).toBe("2026-10-11");
    expect(cells[41].inMonth).toBe(false);
    // every cell is exactly one day after the previous (local calendar arithmetic)
    for (let i = 1; i < cells.length; i++) {
      const [y1, m1, d1] = cells[i - 1].date.split("-").map(Number);
      const [y2, m2, d2] = cells[i].date.split("-").map(Number);
      const a = new Date(y1, m1 - 1, d1), b = new Date(y2, m2 - 1, d2);
      expect(Math.round((b.getTime() - a.getTime()) / 86400000)).toBe(1);
    }
  });
  test("a month starting on Monday has no leading days", () => {
    const cells = calCells(2026, 5); // June 2026: Jun 1 is a Monday
    expect(cells[0].date).toBe("2026-06-01");
    expect(cells[0].inMonth).toBe(true);
  });
  test("calVisibleRange spans the grid", () => {
    expect(calVisibleRange(2026, 8)).toEqual({ from: "2026-08-31", to: "2026-10-11" });
  });
  test("calMonthLabel", () => {
    expect(calMonthLabel(2026, 8)).toBe("September 2026");
  });
});

describe("monthGridHtml", () => {
  const byDate = {
    "2026-09-15": [deal(1, "Big deal", "2026-09-15"), task(2, "Call", "2026-09-15")],
    "2026-09-20": [task(3, "Old task", "2026-09-20")],
  };
  test("renders 42 day cells and 7 weekday headers", () => {
    const h = monthGridHtml(2026, 8, {}, { today: "2026-09-01" });
    expect((h.match(/data-cal-day="/g) || []).length).toBe(42);
    expect((h.match(/class="cal-dow"/g) || []).length).toBe(7);
    expect(h).toContain("Mon");
  });
  test("chips carry type+id and deal/task classes", () => {
    const h = monthGridHtml(2026, 8, byDate, { today: "2026-09-10" });
    expect(h).toContain('data-cal-item="deal:1"');
    expect(h).toContain('data-cal-item="task:2"');
    expect(h).toContain("cal-chip deal");
    expect(h).toContain("cal-chip task");
    expect(h).toContain("Big deal");
  });
  test("overdue open items get the urgent class, done/closed items are dimmed", () => {
    const h = monthGridHtml(2026, 8, {
      "2026-09-05": [task(9, "Late task", "2026-09-05"), deal(8, "Lost one", "2026-09-05", { stage: "closed_lost" })],
    }, { today: "2026-09-10" });
    expect(h).toContain("cal-chip task is-overdue");
    expect(h).toContain("cal-chip deal is-dim");
    expect(h).not.toContain("cal-chip deal is-overdue");
  });
  test("more than 3 items collapses to +n", () => {
    const many = [1, 2, 3, 4, 5].map((i) => task(i, `T${i}`, "2026-09-15"));
    const h = monthGridHtml(2026, 8, { "2026-09-15": many }, { today: "2026-09-10" });
    expect(h).toContain("+2");
    expect(h).not.toContain("T5");
  });
  test("today and selected day are marked", () => {
    const h = monthGridHtml(2026, 8, {}, { today: "2026-09-10", selected: "2026-09-15" });
    expect(h).toContain('data-cal-day="2026-09-10"');
    expect(h.match(/cal-day[^"]*is-today/)).toBeTruthy();
    expect(h.match(/cal-day[^"]*is-selected/)).toBeTruthy();
  });
  test("mini mode renders non-interactive spans", () => {
    const h = monthGridHtml(2026, 8, byDate, { mini: true, today: "2026-09-10" });
    expect(h).toContain("cal-mini");
    expect(h).not.toContain("data-cal-item");
    expect(h).not.toContain("<button");
  });
  test("titles are escaped", () => {
    const h = monthGridHtml(2026, 8, { "2026-09-15": [task(1, '<script>alert("x")</script>', "2026-09-15")] }, { today: "2026-09-10" });
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });
});

describe("calDayRowHtml", () => {
  test("deal row shows value, stage name, company", () => {
    const h = calDayRowHtml(deal(1, "Big deal", "2026-09-15"), "2026-09-10");
    expect(h).toContain("Big deal");
    expect(h).toContain("$50,000");
    expect(h).toContain("Negotiation");
    expect(h).toContain("Acme");
    expect(h).toContain('data-cal-item="deal:1"');
  });
  test("overdue task row gets the urgent class", () => {
    const h = calDayRowHtml(task(2, "Late", "2026-09-05"), "2026-09-10");
    expect(h).toContain("cal-row is-overdue");
    const h2 = calDayRowHtml(task(2, "Done late", "2026-09-05", { done: 1 }), "2026-09-10");
    expect(h2).not.toContain("is-overdue");
  });
});

describe("calendar nav wiring", () => {
  test("sidebar has a Calendar entry", () => {
    const nav = indexSrc.match(/<nav class="nav" id="nav">[\s\S]*?<\/nav>/)![0];
    expect(nav).toContain('data-r="calendar"');
    expect(nav).toContain("#/calendar");
  });
  test("TITLES, router, and Cmd+K know about calendar", () => {
    expect(appSrc).toMatch(/calendar:\s*"Calendar"/);
    expect(appSrc).toContain("calendar: vCalendar");
    const navBlock = appSrc.match(/const NAV = \[[\s\S]*?\];/)![0];
    expect(navBlock).toContain('["Calendar", "#/calendar"]');
  });
  test("urgent styling uses terracotta, not alarm red", () => {
    const css = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "styles.css"), "utf8");
    expect(css).toContain("--urgent: #b5543f");
    expect(css).not.toMatch(/\.cal-[^{]*\{[^}]*#e5484d/);
  });
});
