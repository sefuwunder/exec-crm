// tests/pipeline-overview.test.ts — pipeline moved out of the nav and the
// campaign detail into the general campaigns overview (per-campaign strip).
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

// Extract a top-level `function name(...)` (optionally async) block from app.js.
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

// Real-app mirrors of the tiny helpers the strip uses.
const escT = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const moneyT = (n: any) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const moneyShortT = (n: any) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n);
};
const stageColorT = (s: string) =>
  ({ prospecting: "#4c8dff", negotiation: "#f5b83d" } as Record<string, string>)[s] || "#999";
const stateT = { stages: ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"], labels: { prospecting: "Prospecting", negotiation: "Negotiation" } as Record<string, string> };

const strip = (deals: any[]) =>
  new Function(
    "esc", "money", "moneyShort", "stageColor", "state", "deals",
    extractFn(appSrc, "campaignPipelineStrip") + "\nreturn campaignPipelineStrip(deals);"
  )(escT, moneyT, moneyShortT, stageColorT, stateT, deals) as string;

describe("campaignPipelineStrip", () => {
  test("empty campaign shows a clean empty state, not zeros", () => {
    const html = strip([]);
    expect(html).toContain("No deals");
    expect(html).not.toContain("$0");
    expect(html).not.toContain(">0<");
  });

  test("deals group by stage with proportional segments, count and total", () => {
    const html = strip([
      { stage: "prospecting", value: 100000 },
      { stage: "prospecting", value: 50000 },
      { stage: "negotiation", value: 150000 },
    ]);
    // one segment per stage, widths proportional to stage value (150k/150k)
    expect(html).toContain('width:50.0%');
    expect(html).toContain('background:#4c8dff'); // prospecting
    expect(html).toContain('background:#f5b83d'); // negotiation
    expect(html).toContain('title="Prospecting: $150,000"');
    expect(html).toContain('title="Negotiation: $150,000"');
    expect(html).toContain("3 · <b>$300k</b>");
  });

  test("a stage outside the workspace stage order still renders", () => {
    const html = strip([{ stage: "custom_stage", value: 2000 }]);
    expect(html).toContain("custom_stage");
    expect(html).toContain('background:#999');
    expect(html).toContain("1 · <b>$2k</b>");
  });

  test("zero-value deals don't break the strip", () => {
    const html = strip([{ stage: "prospecting", value: 0 }]);
    expect(html).toContain("1 · <b>$0</b>");
  });
});

describe("campaign detail no longer shows the pipeline panel", () => {
  test("renderCampaignDetail source has no pipeline panel", () => {
    const fn = extractFn(appSrc, "renderCampaignDetail");
    expect(fn).not.toContain("campaignPipelineHtml");
    expect(fn).not.toContain(">Pipeline<");
  });

  test("the old panel function is gone entirely", () => {
    expect(appSrc).not.toContain("function campaignPipelineHtml");
  });
});

describe("campaigns overview wires the strip in", () => {
  test("vCampaigns fetches all deals and renders a Pipeline column per row", () => {
    const fn = extractFn(appSrc, "vCampaigns");
    expect(fn).toContain('GET("/api/deals")');
    expect(fn).toContain("<th>Pipeline</th>");
    expect(fn).toContain("campaignPipelineStrip(dealsByCamp.get(c.id) || [])");
  });
});

// ---------------------------------------------------------------- board wiring
describe("campaigns overview hosts the pipeline board", () => {
  test("vCampaigns renders Overview | Pipeline tabs, filter select, and wires the board", () => {
    const fn = extractFn(appSrc, "vCampaigns");
    expect(fn).toContain('data-ct="overview"');
    expect(fn).toContain('data-ct="board"');
    expect(fn).toContain('id="board-filter"');
    expect(fn).toContain("filterDealsByCampaign(deals, campBoardFilter)");
    expect(fn).toContain("pipelineBoardHtml(boardDeals, campById)");
    expect(fn).toContain("initDealDrag(deals || [])");
    // board tab keeps the "All campaigns" option plus one per campaign
    expect(fn).toContain("All campaigns");
  });

  test("the standalone vPipeline view is gone; pipeline stays out of nav and router", () => {
    expect(appSrc).not.toContain("async function vPipeline");
    expect(appSrc).not.toContain("pipeline: vPipeline");
    expect(appSrc).not.toContain('href="#/pipeline"');
  });

  test("TITLES still has no pipeline entry (hash falls through to dashboard)", () => {
    const titles = appSrc.match(/const TITLES = \{[\s\S]*?\};/)![0];
    expect(titles).not.toContain("pipeline");
  });
});

// ---------------------------------------------------------------- pipelineBoardHtml (pure render)
const boardHtml = (deals: any[], campById: Map<any, string>) =>
  new Function(
    "esc", "money", "moneyShort", "stageColor", "state", "deals", "campById",
    extractFn(appSrc, "pipelineBoardHtml") + "\nreturn pipelineBoardHtml(deals, campById);"
  )(escT, moneyT, moneyShortT, stageColorT, stateT, deals, campById) as string;

describe("pipelineBoardHtml", () => {
  const mk = (id: number, stage: string, title: string, campaign_id: any, value = 1000) =>
    ({ id, stage, title, campaign_id, value, probability: 50, company_name: "Acme", contact_name: null });

  test("columns follow workspace stage order with closed stages last", () => {
    const html = boardHtml([], new Map());
    const order = ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"];
    const idx = order.map((s) => html.indexOf(`data-stage="${s}"`));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("deal cards carry their campaign badge; unlinked deals carry none", () => {
    const html = boardHtml(
      [mk(1, "prospecting", "Alpha deal", 5), mk(2, "prospecting", "Free deal", null)],
      new Map([[5, "Q4 Launch"]])
    );
    expect(html).toContain('<span class="camp-badge">Q4 Launch</span>');
    expect(html.match(/camp-badge/g)!.length).toBe(1);
    expect(html).toContain("Alpha deal");
    expect(html).toContain("Free deal");
  });

  test("column headers show deal count and value total", () => {
    const html = boardHtml(
      [mk(1, "negotiation", "A", 5, 120000), mk(2, "negotiation", "B", 5, 30000)],
      new Map([[5, "Q4 Launch"]])
    );
    expect(html).toContain("2 · $150k");
  });
});

// ---------------------------------------------------------------- filterDealsByCampaign (pure)
const filterDeals = (deals: any[], filter: any) =>
  new Function(
    "deals", "filter",
    extractFn(appSrc, "filterDealsByCampaign") + "\nreturn filterDealsByCampaign(deals, filter);"
  )(deals, filter) as any[];

describe("filterDealsByCampaign", () => {
  const deals = [
    { id: 1, campaign_id: 5 }, { id: 2, campaign_id: 6 }, { id: 3, campaign_id: null },
  ];
  test("'all' returns everything", () => {
    expect(filterDeals(deals, "all").map((d) => d.id)).toEqual([1, 2, 3]);
  });
  test("a campaign id narrows to that campaign's deals only", () => {
    expect(filterDeals(deals, 5).map((d) => d.id)).toEqual([1]);
    expect(filterDeals(deals, "6").map((d) => d.id)).toEqual([2]);
  });
  test("unknown campaign yields an empty board", () => {
    expect(filterDeals(deals, 999)).toEqual([]);
  });
});

// ---------------------------------------------------------------- initDealDrag: fake-DOM drop simulation
// Minimal fake elements supporting exactly what initDealDrag touches.
function fakeEl(classes: string, dataset: Record<string, any> = {}) {
  const cls = new Set((classes || "").split(" ").filter(Boolean));
  const listeners: Record<string, Function[]> = {};
  const kids: any[] = [];
  const el: any = {
    dataset,
    children: kids,
    _cls: cls,
    parent: null as any,
    style: { removeProperty(c: string) { delete (this as any)[c]; } },
    classList: {
      add: (c: string) => cls.add(c),
      remove: (c: string) => cls.delete(c),
      toggle: (c: string, f?: boolean) => {
        const on = f === undefined ? !cls.has(c) : !!f;
        if (on) cls.add(c); else cls.delete(c);
      },
      contains: (c: string) => cls.has(c),
    },
    addEventListener: (t: string, fn: Function) => { (listeners[t] = listeners[t] || []).push(fn); },
    fire: (t: string, e: any) => (listeners[t] || []).forEach((fn) => fn(e)),
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 60, right: 210, bottom: 80 }),
    appendChild(c: any) {
      if (c.parent) { const i = c.parent.children.indexOf(c); if (i >= 0) c.parent.children.splice(i, 1); }
      c.parent = el; kids.push(c); return c;
    },
    insertBefore(c: any, ref: any) {
      if (c.parent) { const i = c.parent.children.indexOf(c); if (i >= 0) c.parent.children.splice(i, 1); }
      c.parent = el;
      const i = ref ? kids.indexOf(ref) : -1;
      if (i < 0) kids.push(c); else kids.splice(i, 0, c);
      return c;
    },
    after(c: any) {
      const p = el.parent, i = p.children.indexOf(el);
      if (c.parent) { const j = c.parent.children.indexOf(c); if (j >= 0) c.parent.children.splice(j, 1); }
      c.parent = p; p.children.splice(i + 1, 0, c);
    },
    remove() {
      if (el.parent) { const i = el.parent.children.indexOf(el); if (i >= 0) el.parent.children.splice(i, 1); el.parent = null; }
    },
    closest(sel: string) { let n: any = el; while (n) { if (fakeMatches(n, sel)) return n; n = n.parent; } return null; },
    querySelectorAll(sel: string) {
      const out: any[] = [];
      const walk = (n: any) => { for (const k of n.children) { if (fakeMatches(k, sel)) out.push(k); walk(k); } };
      walk(el); return out;
    },
    querySelector(sel: string) { return el.querySelectorAll(sel)[0] || null; },
  };
  Object.defineProperty(el, "className", {
    set(v: string) { cls.clear(); String(v).split(" ").forEach((c) => c && cls.add(c)); },
    get() { return [...cls].join(" "); },
  });
  Object.defineProperty(el, "isConnected", { get: () => !!el.parent });
  return el;
}

function fakeMatches(elm: any, sel: string): boolean {
  const m = sel.match(/^\.([\w-]+)(:not\(\.([\w-]+)\))?(\[data-id="([\w-]+)"\])?$/);
  if (!m) return false;
  if (!elm._cls.has(m[1])) return false;
  if (m[3] && elm._cls.has(m[3])) return false;
  if (m[5] && String(elm.dataset.id) !== m[5]) return false;
  return true;
}

const loadDragHarness = () => {
  const patchCalls: any[] = [];
  const editCalls: any[] = [];
  const routeCalls: number[] = [];
  const board = fakeEl("board");
  const colA = fakeEl("column", { stage: "prospecting" });
  const colB = fakeEl("column", { stage: "negotiation" });
  board.appendChild(colA); board.appendChild(colB);
  const card = fakeEl("deal-card", { id: "1" });
  colA.appendChild(card);
  const docStub: any = {
    createElement: () => fakeEl(""),
    elementFromPoint: () => null,
    body: fakeEl("body"),
  };
  const initDealDrag = new Function(
    "$", "document", "PATCH", "route", "editDealModal",
    extractFn(appSrc, "initDealDrag") + "\nreturn initDealDrag;"
  )(
    (s: string) => (s === "#board" ? board : null),
    docStub,
    async (p: string, b: any) => { patchCalls.push([p, b]); return {}; },
    async () => { routeCalls.push(1); },
    (d: any) => { editCalls.push(d); }
  );
  initDealDrag([{ id: 1, title: "Drag me" }]);
  return { board, colA, colB, card, docStub, patchCalls, editCalls, routeCalls };
};

const downEvt = { button: 0, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} };

describe("initDealDrag drop handler", () => {
  test("dragging a card into another column PATCHes the deal's stage", async () => {
    const t = loadDragHarness();
    t.card.fire("pointerdown", downEvt);
    t.card.fire("pointermove", { clientX: 200, clientY: 320 }); // >7px: drag activates
    t.docStub.elementFromPoint = () => t.colB;
    t.card.fire("pointermove", { clientX: 210, clientY: 330 });
    t.card.fire("pointerup", {});
    await new Promise((r) => setTimeout(r, 450));
    expect(t.patchCalls).toEqual([["/api/deals/1", { stage: "negotiation" }]]);
    expect(t.routeCalls.length).toBe(1); // board re-renders after the move
  });

  test("a plain click (no drag) opens the edit modal, PATCHes nothing", async () => {
    const t = loadDragHarness();
    t.card.fire("pointerdown", downEvt);
    t.card.fire("pointerup", {});
    await new Promise((r) => setTimeout(r, 60));
    expect(t.editCalls).toEqual([{ id: 1, title: "Drag me" }]);
    expect(t.patchCalls).toEqual([]);
  });

  test("dropping back in the same column does not PATCH", async () => {
    const t = loadDragHarness();
    t.card.fire("pointerdown", downEvt);
    t.card.fire("pointermove", { clientX: 200, clientY: 320 });
    t.docStub.elementFromPoint = () => t.colA; // same column
    t.card.fire("pointermove", { clientX: 210, clientY: 330 });
    t.card.fire("pointerup", {});
    await new Promise((r) => setTimeout(r, 450));
    expect(t.patchCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------- API: overview data source is workspace-scoped
describe("GET /api/deals workspace isolation (overview grouping source)", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3465";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: (await r.json()) as any };
  };
  let mainId: number, betaId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-pipe-ov-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3465", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const w = await api("GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
    const cos = await api("GET", "/api/companies", undefined, mainId);
    const companyId = cos.data.companies[0].id;
    const camp = await api("POST", "/api/campaigns", { name: "Q4 Push", company_id: companyId }, mainId);
    const campaignId = camp.data.campaign.id;
    await api("POST", "/api/deals", { title: "Main deal", value: 50000, stage: "prospecting", campaign_id: campaignId }, mainId);
    await api("POST", "/api/deals", { title: "Beta deal", value: 90000, stage: "negotiation" }, betaId);
  });
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("each workspace sees only its own deals", async () => {
    const m = await api("GET", "/api/deals", undefined, mainId);
    const b = await api("GET", "/api/deals", undefined, betaId);
    const mTitles = m.data.deals.map((d: any) => d.title);
    const bTitles = b.data.deals.map((d: any) => d.title);
    expect(mTitles).toContain("Main deal");
    expect(mTitles).not.toContain("Beta deal");
    expect(bTitles).toContain("Beta deal");
    expect(bTitles).not.toContain("Main deal");
  });

  test("campaign-linked deal is groupable under its campaign", async () => {
    const m = await api("GET", "/api/deals", undefined, mainId);
    const main = m.data.deals.find((d: any) => d.title === "Main deal");
    expect(main.campaign_id).toBeGreaterThan(0);
    const byCamp = await api("GET", `/api/deals?campaign_id=${main.campaign_id}`, undefined, mainId);
    expect(byCamp.data.deals.map((d: any) => d.title)).toContain("Main deal");
    expect(byCamp.data.deals.map((d: any) => d.title)).not.toContain("Beta deal");
  });

  test("PATCH persists a stage move (the drop handler's persistence path), workspace-scoped", async () => {
    const m = await api("GET", "/api/deals", undefined, mainId);
    const deal = m.data.deals.find((d: any) => d.title === "Main deal");
    const r = await api("PATCH", `/api/deals/${deal.id}`, { stage: "negotiation" }, mainId);
    expect(r.status).toBe(200);
    const m2 = await api("GET", "/api/deals", undefined, mainId);
    expect(m2.data.deals.find((d: any) => d.title === "Main deal").stage).toBe("negotiation");
    // the other workspace is untouched
    const b = await api("GET", "/api/deals", undefined, betaId);
    expect(b.data.deals.find((d: any) => d.title === "Beta deal").stage).toBe("negotiation");
    expect(b.data.deals.map((d: any) => d.title)).not.toContain("Main deal");
  });
});
