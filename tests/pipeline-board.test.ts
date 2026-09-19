// tests/pipeline-board.test.ts — drag-and-drop pipeline kanban board living
// inside the campaigns overview (vCampaigns): shared boardHtml markup with
// campaign badges, a client-side campaign filter, and drag persistence via
// PATCH /api/deals/:id { stage }.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

// Extract a top-level `function name(...)` (optionally async) block from app.js.
// Brace counting skips strings/comments; valid for the small helpers tested here.
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

// Real-app mirrors of the tiny helpers boardHtml uses.
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
  ({ prospecting: "#4c8dff", negotiation: "#f5b83d", closed_won: "#18a058", closed_lost: "#e5484d" } as Record<string, string>)[s] || "#999";
const stateT = {
  stages: ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"],
  labels: {
    prospecting: "Prospecting", qualification: "Qualification", proposal: "Proposal",
    negotiation: "Negotiation", closed_won: "Closed won", closed_lost: "Closed lost",
  } as Record<string, string>,
};

const board = (deals: any[], campNameById?: Map<number, string>) =>
  new Function(
    "esc", "money", "moneyShort", "stageColor", "state", "deals", "campNameById",
    extractFn(appSrc, "boardHtml") + "\nreturn boardHtml(deals, campNameById);"
  )(escT, moneyT, moneyShortT, stageColorT, stateT, deals, campNameById) as string;

const campMap = new Map<number, string>([[7, "Q4 Launch"], [9, "Beta Test"]]);
const D = (id: number, stage: string, value: number, campaign_id: number | null, title = "Deal " + id) =>
  ({ id, title, stage, value, campaign_id, company_name: "Acme", contact_name: null, probability: 50 });

describe("boardHtml", () => {
  test("renders one column per stage in workspace order, closed stages last", () => {
    const html = board([D(1, "negotiation", 100, 7), D(2, "prospecting", 50, 9)], campMap);
    for (const s of stateT.stages) expect(html).toContain(`data-stage="${s}"`);
    const idx = (s: string) => html.indexOf(`data-stage="${s}"`);
    expect(idx("prospecting")).toBeLessThan(idx("negotiation"));
    expect(idx("negotiation")).toBeLessThan(idx("closed_won"));
    expect(idx("closed_won")).toBeLessThan(idx("closed_lost"));
  });

  test("deal cards carry campaign badges; unlinked deals read 'No campaign'", () => {
    const html = board([D(1, "prospecting", 100, 7), D(2, "prospecting", 50, null)], campMap);
    expect(html).toContain(">Q4 Launch</span>");
    expect(html).toContain(">No campaign</span>");
  });

  test("without a campaign map there is no badge markup", () => {
    const html = board([D(1, "prospecting", 100, 7)]);
    expect(html).not.toContain("No campaign");
    expect(html).not.toContain("Q4 Launch");
  });

  test("columns show deal counts and value totals", () => {
    const html = board([D(1, "prospecting", 100000, 7), D(2, "prospecting", 50000, 7)], campMap);
    expect(html).toContain("2 · $150k");
  });

  test("empty deal list renders empty columns without crashing", () => {
    const html = board([], campMap);
    for (const s of stateT.stages) expect(html).toContain(`data-stage="${s}"`);
    expect(html).not.toContain("deal-card");
  });

  test("an unknown stage label falls back to the stage slug", () => {
    const html = board([D(1, "custom_stage", 2000, 7)], campMap);
    expect(html).toContain(">custom_stage</div>");
    expect(html).toContain("1 · $2k");
  });
});

describe("vCampaigns wires the board", () => {
  const fn = () => extractFn(appSrc, "vCampaigns");

  test("overview renders the board below the campaign list with badges", () => {
    const src = fn();
    expect(src).toContain("boardHtml(boardDeals, campNameById)");
    expect(src).toContain('id="board-camp-filter"');
    // per-campaign summary strips stay as the glanceable layer
    expect(src).toContain("campaignPipelineStrip(dealsByCamp.get(c.id) || [])");
  });

  test("campaign filter offers All / per-campaign / No campaign and re-routes", () => {
    const src = fn();
    expect(src).toContain('value="all"');
    expect(src).toContain("All campaigns");
    expect(src).toContain('value="none"');
    expect(src).toContain("No campaign");
    expect(src).toMatch(/campBoardFilter\s*=\s*e\.target\.value;\s*route\(\)/);
  });

  test("drag wiring receives the full deal list and persists via PATCH stage", () => {
    const src = fn();
    expect(src).toContain("initDealDrag(allDeals)");
    const drag = extractFn(appSrc, "initDealDrag");
    expect(drag).toContain("PATCH(`/api/deals/${d.id}`, { stage: newStage })");
  });

  test("pipeline stays out of the nav and has no standalone view", () => {
    expect(appSrc).not.toContain("pipeline: vPipeline");
    const indexSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");
    expect(indexSrc).not.toContain('data-r="pipeline"');
  });
});

// ---------------------------------------------------------------- API
// The drag-and-drop handler persists a stage change with
// PATCH /api/deals/:id { stage }; verify it persists and stays workspace-scoped.
describe("board drag persistence (API)", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3462";
  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };

  let mainId: number, betaId: number, companyId: number, alphaId: number, dealId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-board-live-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3462", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(BASE + "/api/workspaces");
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const w = await api("GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
    companyId = (await api("POST", "/api/companies", { name: "BoardCo" }, mainId)).data.company.id;
    alphaId = (await api("POST", "/api/campaigns", { name: "Alpha", company_id: companyId }, mainId)).data.campaign.id;
  }, 30000);
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("deals created across stages stay linked to their campaign", async () => {
    const d1 = await api("POST", "/api/deals",
      { title: "Board deal 1", value: 100000, stage: "prospecting", campaign_id: alphaId }, mainId);
    expect(d1.status).toBe(201);
    dealId = d1.data.deal.id;
    const d2 = await api("POST", "/api/deals",
      { title: "Board deal 2", value: 250000, stage: "negotiation", campaign_id: alphaId }, mainId);
    expect(d2.status).toBe(201);
    const filtered = await api("GET", `/api/deals?campaign_id=${alphaId}`, undefined, mainId);
    expect(filtered.data.deals.map((d: any) => d.id)).toEqual(expect.arrayContaining([dealId, d2.data.deal.id]));
  });

  test("a drop (PATCH stage) persists and is visible on the next read", async () => {
    const r = await api("PATCH", `/api/deals/${dealId}`, { stage: "negotiation" }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.deal.stage).toBe("negotiation");
    const again = await api("GET", "/api/deals", undefined, mainId);
    expect(again.data.deals.find((d: any) => d.id === dealId).stage).toBe("negotiation");
  });

  test("workspace isolation: board deals never leak across workspaces", async () => {
    const b = await api("POST", "/api/deals", { title: "Beta deal", value: 60000, stage: "prospecting" }, betaId);
    expect(b.status).toBe(201);
    const betaDeals = await api("GET", "/api/deals", undefined, betaId);
    expect(betaDeals.data.deals.map((d: any) => d.id)).not.toContain(dealId);
    const mainDeals = await api("GET", "/api/deals", undefined, mainId);
    expect(mainDeals.data.deals.map((d: any) => d.id)).not.toContain(b.data.deal.id);
    // cross-workspace campaign link rejected
    const bad = await api("POST", "/api/deals", { title: "X", campaign_id: alphaId }, betaId);
    expect(bad.status).toBe(400);
  });
});

describe("filterBoardDeals", () => {
  const fn = new Function(
    extractFn(appSrc, "filterBoardDeals") + "\nreturn filterBoardDeals;"
  )() as (deals: any[], filter: any) => any[];
  const deals = [
    D(1, "prospecting", 100, 7), D(2, "negotiation", 200, 9), D(3, "prospecting", 50, null),
  ];
  test("\"all\" returns every deal", () => {
    expect(fn(deals, "all")).toHaveLength(3);
  });
  test("a campaign id narrows to that campaign's deals only", () => {
    const r = fn(deals, 7);
    expect(r.map((d) => d.id)).toEqual([1]);
    // string form from the <select> value works too
    expect(fn(deals, "7").map((d) => d.id)).toEqual([1]);
  });
  test("\"none\" returns only unlinked deals", () => {
    expect(fn(deals, "none").map((d) => d.id)).toEqual([3]);
  });
  test("an unknown campaign id yields an empty board, never a crash", () => {
    expect(fn(deals, 424242)).toEqual([]);
  });
});

describe("vCampaigns DOM-stubbed render", () => {
  const statusPillT = (s: string) => `<span class="pill">${escT(s)}</span>`;
  const stripT = (deals: any[]) =>
    new Function("esc", "money", "moneyShort", "stageColor", "state", "deals",
      extractFn(appSrc, "campaignPipelineStrip") + "\nreturn campaignPipelineStrip(deals);")
      (escT, moneyT, moneyShortT, stageColorT, stateT, deals) as string;

  const campaigns = [
    { id: 7, name: "Q4 Launch", company_name: "Acme", status: "active", start_date: "", end_date: "", budget: 5000 },
    { id: 9, name: "Beta Test", company_name: "Acme", status: "draft", start_date: "", end_date: "", budget: 1000 },
  ];
  const deals = [D(1, "prospecting", 100000, 7, "Alpha deal"), D(2, "negotiation", 250000, 9, "Beta deal"), D(3, "prospecting", 10000, null, "Loose deal")];
  const filterDealsT = new Function(
    extractFn(appSrc, "filterBoardDeals") + "\nreturn filterBoardDeals;"
  )() as (deals: any[], filter: any) => any[];

  const render = async (filter: any) => {
    let html = "";
    const view = { set innerHTML(v: string) { html = v; } };
    const $stub = () => ({}) as any;
    const docStub = { querySelectorAll: () => [] } as any;
    const dragCalls: any[][] = [];
    const stubs = {
      GET: async (p: string) =>
        p === "/api/campaigns" ? { campaigns } : p === "/api/companies" ? { companies: [] } : { deals },
      route: async () => {},
      newDealModal: () => {},
      initDealDrag: (...a: any[]) => { dragCalls.push(a); },
      getSchemaFields: async () => [], openModal: () => {}, field: () => "", input: () => "",
      select: () => "", CAMPAIGN_STATUSES: [], cfFieldsHtml: () => "",
      wireDraftRows: () => {}, draftContactRowHtml: () => "", draftCompanyRowHtml: () => "",
    };
    await new Function(
      "GET", "view", "esc", "money", "moneyShort", "statusPill", "campaignPipelineStrip",
      "boardHtml", "filterBoardDeals", "campBoardFilter", "route", "newDealModal",
      "initDealDrag", "getSchemaFields", "openModal", "field", "input", "select",
      "CAMPAIGN_STATUSES", "cfFieldsHtml", "wireDraftRows", "draftContactRowHtml",
      "draftCompanyRowHtml", "state", "$", "document", "POST",
      extractFn(appSrc, "vCampaigns") + "\nreturn vCampaigns();"
    )(
      stubs.GET, view, escT, moneyT, moneyShortT, statusPillT, stripT,
      (ds: any[], m: any) => board(ds, m), filterDealsT, filter, stubs.route, stubs.newDealModal,
      stubs.initDealDrag, stubs.getSchemaFields, stubs.openModal, stubs.field, stubs.input,
      stubs.select, stubs.CAMPAIGN_STATUSES, stubs.cfFieldsHtml, stubs.wireDraftRows,
      stubs.draftContactRowHtml, stubs.draftCompanyRowHtml,
      stateT, $stub, docStub, async () => ({})
    );
    return { html, dragCalls };
  };

  test("overview renders strips plus the drag board with badges and filter", async () => {
    const { html, dragCalls } = await render("all");
    expect(html).toContain('id="board"');
    expect(html).toContain('data-stage="prospecting"');
    expect(html).toContain('data-stage="negotiation"');
    expect(html).toContain("Alpha deal");
    expect(html).toContain(">Q4 Launch</span>");
    expect(html).toContain(">Beta Test</span>");
    expect(html).toContain(">No campaign</span>");
    expect(html).toContain('id="board-camp-filter"');
    expect(html).toContain(">All campaigns<");
    expect(html).toContain(">Q4 Launch</option>");
    expect(html).toContain("+ New deal");
    // drag wiring gets the full deal list even when the view is filtered
    expect(dragCalls).toHaveLength(1);
    expect(dragCalls[0][0]).toHaveLength(3);
  });

  test("filter narrows the board to one campaign", async () => {
    const { html } = await render(7);
    expect(html).toContain("Alpha deal");
    expect(html).not.toContain("Beta deal");
    expect(html).not.toContain("Loose deal");
  });

  test("\"none\" filter shows only unlinked deals", async () => {
    const { html } = await render("none");
    expect(html).toContain("Loose deal");
    expect(html).not.toContain("Alpha deal");
  });
});
