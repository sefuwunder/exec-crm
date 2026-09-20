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
// Mutable workspace order for the phase tests; extracted helpers close over it.
const DEFAULT_STAGES = ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"];
const state: any = { stages: [...DEFAULT_STAGES], labels: {}, colors: {} };
const PHASE_VARS = { early: "var(--phase-early)", middle: "var(--phase-middle)", end: "var(--phase-end)" };
const evalScope: any = { esc, toISODate, money, CAL_DOW, state, PHASE_VARS };
const load = (name: string) => {
  const fn = new Function(...Object.keys(evalScope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(evalScope));
  evalScope[name] = fn; // later loads can call earlier ones (monthGridHtml -> calCells)
  return fn;
};

const calCells = load("calCells");
const calVisibleRange = load("calVisibleRange");
const calMonthLabel = load("calMonthLabel");
const calDayLabel = load("calDayLabel");
const stagePhase = load("stagePhase");
const stageColor = load("stageColor");
const phaseColor = load("phaseColor");
const stageFunnelColor = load("stageFunnelColor");
const calChipHtml = load("calChipHtml");
const calChipsHtml = load("calChipsHtml");
const monthGridHtml = load("monthGridHtml");
const calDayRowHtml = load("calDayRowHtml");
const weekCells = load("weekCells");
const calWeekLabel = load("calWeekLabel");
const weekGridHtml = load("weekGridHtml");
const calDayPanelHtml = load("calDayPanelHtml");

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

describe("stagePhase: funnel tertiles from the workspace order", () => {
  const reset = () => { state.stages = [...DEFAULT_STAGES]; state.colors = {}; };
  test("6 stages split 2/2/2 with closed stages in the end third", () => {
    reset();
    expect(stagePhase("prospecting")).toBe("early");
    expect(stagePhase("qualification")).toBe("early");
    expect(stagePhase("proposal")).toBe("middle");
    expect(stagePhase("negotiation")).toBe("middle");
    expect(stagePhase("closed_won")).toBe("end");
    expect(stagePhase("closed_lost")).toBe("end");
  });
  test("uneven counts split by position", () => {
    state.stages = ["a", "b", "c", "d", "e"];
    expect([stagePhase("a"), stagePhase("b")]).toEqual(["early", "early"]);
    expect([stagePhase("c"), stagePhase("d")]).toEqual(["middle", "middle"]);
    expect(stagePhase("e")).toBe("end");
    reset();
  });
  test("unknown stage and empty order yield null", () => {
    reset();
    expect(stagePhase("mystery")).toBeNull();
    state.stages = [];
    expect(stagePhase("prospecting")).toBeNull();
    reset();
  });
  test("phase follows renames and reorders, not names", () => {
    state.stages = ["Discovery", "Demo", "Contract", "Won", "Lost"];
    expect(stagePhase("Discovery")).toBe("early");
    expect(stagePhase("Won")).toBe("middle");
    expect(stagePhase("Lost")).toBe("end");
    state.stages = ["Won", "Lost", "Discovery", "Demo", "Contract"];
    expect(stagePhase("Won")).toBe("early");
    expect(stagePhase("Contract")).toBe("end");
    reset();
  });
});

describe("stageFunnelColor", () => {
  test("known stages get phase vars; unknown stages fall back to stageColor", () => {
    state.stages = [...DEFAULT_STAGES]; state.colors = {};
    expect(stageFunnelColor("prospecting")).toBe("var(--phase-early)");
    expect(stageFunnelColor("proposal")).toBe("var(--phase-middle)");
    expect(stageFunnelColor("closed_won")).toBe("var(--phase-end)");
    expect(stageFunnelColor("mystery")).toBe("#999");
    state.colors = { mystery: "#123456" };
    expect(stageFunnelColor("mystery")).toBe("#123456");
    state.stages = [...DEFAULT_STAGES]; state.colors = {};
  });
  test("phaseColor maps the three phases to CSS vars", () => {
    expect(phaseColor("early")).toBe("var(--phase-early)");
    expect(phaseColor("middle")).toBe("var(--phase-middle)");
    expect(phaseColor("end")).toBe("var(--phase-end)");
    expect(phaseColor("nope")).toBeNull();
  });
  test("kanban headers, strips and calendar chips use the funnel color", () => {
    expect(appSrc).toContain('class="chead"><div class="dot" style="background:${stageFunnelColor(s)}"');
    expect(appSrc).toContain('<span class="sdot" style="background:${stageFunnelColor(s)}"');
    expect(appSrc).toContain("background:${stageFunnelColor(s)}");
    expect(appSrc).toContain("border-left:3px solid ${stageFunnelColor(it.stage)}");
  });
  test("deal chips carry the phase border; task chips do not", () => {
    state.stages = [...DEFAULT_STAGES];
    const dh = calChipHtml(deal(1, "Big deal", "2026-09-15"), "2026-09-15", "2026-09-10", {});
    expect(dh).toContain("border-left:3px solid var(--phase-middle)"); // negotiation
    const th = calChipHtml(task(2, "Call", "2026-09-15"), "2026-09-15", "2026-09-10", {});
    expect(th).not.toContain("border-left");
  });
  test("day-row deal dots carry the phase color", () => {
    state.stages = [...DEFAULT_STAGES];
    const h = calDayRowHtml(deal(1, "Big deal", "2026-09-15"), "2026-09-10");
    expect(h).toContain('style="background:var(--phase-middle)"');
    const t = calDayRowHtml(task(2, "Call", "2026-09-15"), "2026-09-10");
    expect(t).not.toContain("var(--phase-");
  });
});

describe("weekCells / calWeekLabel", () => {
  test("Monday-first 7 days containing the anchor", () => {
    expect(weekCells("2026-09-16").map((c: any) => c.date)).toEqual([
      "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17",
      "2026-09-18", "2026-09-19", "2026-09-20",
    ]);
  });
  test("anchor on Monday starts the week; anchor on Sunday ends it", () => {
    expect(weekCells("2026-09-14")[0].date).toBe("2026-09-14");
    expect(weekCells("2026-09-20")[6].date).toBe("2026-09-20");
    expect(weekCells("2026-09-20")[0].date).toBe("2026-09-14");
  });
  test("crosses month and year boundaries", () => {
    const cells = weekCells("2026-09-01"); // Tuesday
    expect(cells[0].date).toBe("2026-08-31");
    expect(cells[6].date).toBe("2026-09-06");
    const nye = weekCells("2026-01-01"); // Thursday
    expect(nye[0].date).toBe("2025-12-29");
    expect(nye[6].date).toBe("2026-01-04");
  });
  test("label spans the week", () => {
    expect(calWeekLabel("2026-09-16")).toBe("Sep 14 – Sep 20, 2026");
    expect(calWeekLabel("2026-01-01")).toBe("Dec 29 – Jan 4, 2026");
  });
});

describe("weekGridHtml", () => {
  const byDate = {
    "2026-09-16": [deal(1, "Big deal", "2026-09-16"), task(2, "Call", "2026-09-16")],
  };
  test("renders 7 day columns headed Mon–Sun with date numbers", () => {
    const h = weekGridHtml("2026-09-16", {}, { today: "2026-09-01" });
    expect((h.match(/data-cal-day="/g) || []).length).toBe(7);
    expect(h).toContain("cal-grid cal-week");
    expect(h).toContain("Mon"); expect(h).toContain("Sun");
    expect(h).toContain('<span class="cal-dow-num">16</span>');
  });
  test("chips render with type+id, and deal chips carry the phase border", () => {
    state.stages = [...DEFAULT_STAGES];
    const h = weekGridHtml("2026-09-16", byDate, { today: "2026-09-10" });
    expect(h).toContain('data-cal-item="deal:1"');
    expect(h).toContain('data-cal-item="task:2"');
    expect(h).toContain("border-left:3px solid var(--phase-middle)");
    state.stages = [...DEFAULT_STAGES];
  });
  test("today and selected day are marked", () => {
    const h = weekGridHtml("2026-09-16", {}, { today: "2026-09-16", selected: "2026-09-18" });
    expect(h).toContain("cal-dow is-today");
    expect(h.match(/cal-day[^"]*is-today/)).toBeTruthy();
    expect(h.match(/cal-day[^"]*is-selected/)).toBeTruthy();
  });
  test("overdue open items get the urgent class in week view too", () => {
    const h = weekGridHtml("2026-09-16", { "2026-09-15": [task(9, "Late", "2026-09-15")] }, { today: "2026-09-16" });
    expect(h).toContain("cal-chip task is-overdue");
  });
});

describe("calDayPanelHtml", () => {
  test("empty state names the current view", () => {
    expect(calDayPanelHtml({}, "2026-09-16", "2026-09-15", [], "week")).toContain("No dated items this week");
    expect(calDayPanelHtml({}, "2026-09-16", "2026-09-15", [], "month")).toContain("No dated items this month");
  });
  test("lists the selected day's items", () => {
    const byDate = { "2026-09-16": [deal(1, "Big deal", "2026-09-16")] };
    const h = calDayPanelHtml(byDate, "2026-09-16", "2026-09-15", [deal(1, "Big deal", "2026-09-16")], "week");
    expect(h).toContain("Big deal");
    expect(h).toContain('data-cal-item="deal:1"');
  });
});

describe("calendar view defaults and campaign layout", () => {
  test("calendars default to week view; mini stays month-only", () => {
    expect(appSrc).toContain('opts.view || "week"');
    expect(appSrc).toContain('opts.mini ? "month"');
  });
  test("Week/Month toggle buttons are rendered", () => {
    expect(appSrc).toContain('data-cal-view="week"');
    expect(appSrc).toContain('data-cal-view="month"');
    expect(appSrc).toContain('aria-label="Calendar view"');
  });
  test("campaign detail: calendar sits in the tasks slot, tasks collapsed beneath", () => {
    const calIdx = appSrc.indexOf('id="camp-cal"');
    const tasksIdx = appSrc.indexOf('id="tasks-toggle"');
    expect(calIdx).toBeGreaterThan(-1);
    expect(tasksIdx).toBeGreaterThan(-1);
    expect(calIdx).toBeLessThan(tasksIdx);
    expect(appSrc).toContain('id="tasks-body" hidden');
    expect(appSrc).toContain('aria-expanded="false"');
    expect(appSrc).toContain('aria-controls="tasks-body"');
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
  test("grid click handlers are bound once per mount, not per draw", () => {
    const fn = extractFn(appSrc, "mountCalendar");
    const drawSrc = extractFn(fn, "draw");
    expect(drawSrc).not.toContain("bindCalendarGrid(");
    expect(fn).toContain("bindCalendarGrid(el,");
  });
});
