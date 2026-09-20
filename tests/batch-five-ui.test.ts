// tests/batch-five-ui.test.ts — DOM-stubbed renders for the batch-five frontend:
// pipeline filters + saved views + selection checkboxes, bulk bar wiring,
// duplicate pair cards, blocked task badge.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index, depth = 0;
  let str: string | null = null;
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

const escT = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const moneyT = (n: any) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const moneyShortT = (n: any) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n);
};
const stateT = {
  stages: ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"],
  labels: { prospecting: "Prospecting", qualification: "Qualification", proposal: "Proposal", negotiation: "Negotiation", closed_won: "Closed won", closed_lost: "Closed lost" } as Record<string, string>,
};
const stageFunnelColorT = (s: string) => `var(--phase-${s})`;

// mutable DOM-ish element stub: property assignment works, events captured
const mkEl = () => {
  const handlers: Record<string, Function> = {};
  return {
    _handlers: handlers,
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    addEventListener: (ev: string, fn: Function) => { handlers[ev] = fn; },
    set innerHTML(v: string) { (this as any)._html = v; },
    get innerHTML() { return (this as any)._html || ""; },
  } as any;
};

const deals = [
  { id: 1, title: "Alpha deal", stage: "prospecting", value: 100000, probability: 20, owner: "Maya", source: "Referral", company_name: "Acme", contact_name: null },
  { id: 2, title: "Beta deal", stage: "negotiation", value: 250000, probability: 60, owner: "", source: "", company_name: "Globex", contact_name: null },
];

const runHelpers = (opts: { sel?: number[]; filters?: any; views?: any[] } = {}) => {
  const elCache: Record<string, any> = {};
  const $stub = (s: string) => (elCache[s] = elCache[s] || mkEl());
  const preamble = `
    let pipeFilters = ${JSON.stringify({ search: "", owner: "", stage: "", source: "", min_value: "", ...(opts.filters || {}) })};
    let bulkSel = new Set(${JSON.stringify(opts.sel || [])});
    let savedViewsCache = ${JSON.stringify(opts.views || [])};
    let dealSourcesCache = ["Referral", "Partner"];
    let dealOwnersCache = ["Maya", "Zoe"];
    let state = ${JSON.stringify(stateT)};
  `;
  const fns = preamble +
    extractFn(appSrc, "applyPipeFilters") + "\n" +
    extractFn(appSrc, "savedViewsHtml") + "\n" +
    extractFn(appSrc, "dealFiltersHtml") + "\n" +
    extractFn(appSrc, "wirePipeControls") + "\n" +
    extractFn(appSrc, "renderBulkBar") + "\n" +
    extractFn(appSrc, "wireBulkBar");
  return { fns, $stub, elCache };
};

const evalHelper = (fns: string, $stub: any, expr: string, extra: Record<string, any> = {}) => {
  const keys = Object.keys(extra);
  return new Function("esc", "$", "route", "openModal", "POST", "DEL", "toast", "confirm", ...keys,
    fns + `\nreturn (${expr});`
  )(escT, $stub, async () => {}, () => {}, async () => ({}), async () => ({}), () => {}, () => true,
    ...keys.map((k) => extra[k]));
};

describe("board filter helpers (applyPipeFilters, savedViewsHtml, dealFiltersHtml)", () => {
  test("applyPipeFilters mirrors the server filter semantics", () => {
    const { fns, $stub } = runHelpers();
    const deals = [
      { id: 1, title: "Alpha", stage: "prospecting", owner: "Maya", source: "Referral", value: 50000, company_name: "Acme" },
      { id: 2, title: "Beta", stage: "negotiation", owner: "Zoe", source: "Partner", value: 5000, company_name: "Globex" },
    ];
    const run = (filters: any) => evalHelper(
      fns.replace(/let pipeFilters = .*?;/, `let pipeFilters = ${JSON.stringify(filters)};`),
      $stub, "applyPipeFilters(deals)", { deals });
    expect(run({ search: "", owner: "", stage: "", source: "", min_value: "" })).toHaveLength(2);
    expect(run({ owner: "Maya" }).map((d: any) => d.id)).toEqual([1]);
    expect(run({ stage: "negotiation" }).map((d: any) => d.id)).toEqual([2]);
    expect(run({ source: "Partner" }).map((d: any) => d.id)).toEqual([2]);
    expect(run({ min_value: "10000" }).map((d: any) => d.id)).toEqual([1]);
    expect(run({ search: "alp" }).map((d: any) => d.id)).toEqual([1]);
    expect(run({ search: "glob" }).map((d: any) => d.id)).toEqual([2]);
    expect(run({ owner: "Maya", stage: "negotiation" })).toHaveLength(0);
  });

  test("savedViewsHtml renders the dropdown with views", () => {
    const { fns, $stub } = runHelpers({ views: [{ id: 3, name: "Big ref", filters: {} }] });
    const html = evalHelper(fns, $stub, "savedViewsHtml()");
    expect(html).toContain('id="view-sel"');
    expect(html).toContain('value="3">Big ref</option>');
    expect(html).toContain('id="view-save"');
    expect(html).toContain('id="view-del"');
  });

  test("dealFiltersHtml renders all filter controls with current values", () => {
    const { fns, $stub } = runHelpers({ filters: { search: "alpha", source: "Referral" } });
    const html = evalHelper(fns, $stub, "dealFiltersHtml()");
    expect(html).toContain('id="f-search"');
    expect(html).toContain('value="alpha"');
    expect(html).toContain('id="f-owner"');
    expect(html).toContain('id="f-stage"');
    expect(html).toContain('id="f-source"');
    expect(html).toContain('value="Referral" selected');
    expect(html).toContain('id="f-min"');
    expect(html).toContain(">Maya</option>");
    expect(html).toContain(">Partner</option>");
  });

  test("wirePipeControls binds filter and view handlers", () => {
    const { fns, $stub, elCache } = runHelpers();
    evalHelper(fns, $stub, "wirePipeControls()");
    for (const s of ["#f-search", "#f-owner", "#f-stage", "#f-source", "#f-min", "#f-clear", "#view-sel", "#view-save", "#view-del"]) {
      expect(elCache[s]).toBeDefined();
    }
    expect(typeof elCache["#f-search"].oninput).toBe("function");
    expect(typeof elCache["#f-owner"].onchange).toBe("function");
    expect(typeof elCache["#view-save"].onclick).toBe("function");
    expect(typeof elCache["#view-del"].onclick).toBe("function");
  });
});

describe("wireBulkBar + renderBulkBar", () => {
  const run = (sel: number[]) => {
    const host = mkEl();
    const board = mkEl();
    const $stub = (s: string) => (s === "#board" ? board : s === "#bulkbar-host" ? host : mkEl());
    const handlers: Record<string, any> = {};
    let html = "";
    const preamble = `
      let bulkSel = new Set(${JSON.stringify(sel)});
      let dealSourcesCache = ["Referral"];
      let state = ${JSON.stringify(stateT)};
    `;
    new Function("esc", "$", "openModal", "POST", "route",
      preamble + extractFn(appSrc, "wireBulkBar") + "\n" + extractFn(appSrc, "renderBulkBar") +
      "\nwireBulkBar([]); renderBulkBar();"
    )(escT, $stub, () => {}, async () => ({}), async () => {});
    return { host, board };
  };

  test("empty selection renders no bar; selection renders actions", () => {
    expect(run([]).host.innerHTML).toBe("");
    const { host } = run([1, 2]);
    expect(host.innerHTML).toContain("2 selected");
    expect(host.innerHTML).toContain('id="b-move"');
    expect(host.innerHTML).toContain('id="b-owner-go"');
    expect(host.innerHTML).toContain('id="b-source-go"');
    expect(host.innerHTML).toContain('id="b-del"');
  });

  test("checking a card updates the bar without a re-render", () => {
    const { host, board } = run([]);
    const card = mkEl();
    const change = board._handlers.change;
    expect(typeof change).toBe("function");
    const fake = { target: { classList: { contains: (c: string) => c === "sel" }, dataset: { id: "1" }, checked: true, closest: () => card } };
    change(fake);
    expect(host.innerHTML).toContain("1 selected");
    expect(card._html === undefined).toBe(true); // classList.toggle stubbed; no crash
  });
});

describe("dupPairHtml", () => {
  const pair = {
    a: { id: 1, name: "Jon Smith", title: "CEO", company_name: "Acme", email: "jon@example.com", phone: "1" },
    b: { id: 2, name: "Jon Smyth", title: "", company_name: "", email: "JON@example.com", phone: "" },
    reason: "same email",
  };
  const render = (type: string, p: any) => new Function("esc", "p",
    `let dupType = ${JSON.stringify(type)};` + extractFn(appSrc, "dupPairHtml") + "\nreturn dupPairHtml(p, 0);"
  )(escT, p);

  test("renders reason, both records side by side, winner radio, merge button", () => {
    const html = render("contact", pair);
    expect(html).toContain("same email");
    expect(html).toContain("Jon Smith");
    expect(html).toContain("Jon Smyth");
    expect(html).toContain('name="win-0"');
    expect(html).toContain('data-merge="0"');
    expect(html).toContain("Merge…");
  });

  test("company pairs show industry/website fields", () => {
    const co = { a: { id: 1, name: "Acme", industry: "Tech", website: "acme.com" }, b: { id: 2, name: "Acme Inc", industry: "", website: "" }, reason: "similar name" };
    const html = render("company", co);
    expect(html).toContain("similar name");
    expect(html).toContain("acme.com");
    expect(html).toContain("Tech");
  });
});

describe("taskRow blocked badge", () => {
  const row = (t: any) => new Function("esc", "cfReadonlyHtml", "t",
    extractFn(appSrc, "taskRow") + "\nreturn taskRow(t);"
  )(escT, () => "", t);

  test("blocked open task shows the badge; unblocked and done tasks do not", () => {
    const blocked = row({ id: 1, title: "B", done: false, is_blocked: true, blocked_by: [{ id: 2, title: "A", done: false }] });
    expect(blocked).toContain("blocked-badge");
    expect(blocked).toContain("Blocked");
    const free = row({ id: 1, title: "B", done: false, is_blocked: false, blocked_by: [] });
    expect(free).not.toContain("blocked-badge");
    const done = row({ id: 1, title: "B", done: true, is_blocked: true, blocked_by: [] });
    expect(done).not.toContain("blocked-badge");
  });
});
