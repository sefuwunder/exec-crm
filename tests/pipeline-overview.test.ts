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
  ({ prospecting: "var(--phase-early)", negotiation: "var(--ctp-yellow)" } as Record<string, string>)[s] || "var(--ctp-overlay0)";
const stateT = { stages: ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"], labels: { prospecting: "Prospecting", negotiation: "Negotiation" } as Record<string, string> };
// Mirror of the app's funnel-phase logic over the same workspace order.
const stageFunnelColorT = (s: string) => {
  const i = stateT.stages.indexOf(s);
  if (i < 0 || !stateT.stages.length) return stageColorT(s);
  const third = stateT.stages.length / 3;
  const p = i < third ? "early" : i < 2 * third ? "middle" : "end";
  return ({ early: "var(--phase-early)", middle: "var(--phase-middle)", end: "var(--phase-end)" } as Record<string, string>)[p];
};

const strip = (deals: any[]) =>
  new Function(
    "esc", "money", "moneyShort", "stageColor", "stageFunnelColor", "state", "deals",
    extractFn(appSrc, "campaignPipelineStrip") + "\nreturn campaignPipelineStrip(deals);"
  )(escT, moneyT, moneyShortT, stageColorT, stageFunnelColorT, stateT, deals) as string;

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
    expect(html).toContain('background:var(--phase-early)'); // prospecting
    expect(html).toContain('background:var(--phase-middle)'); // negotiation
    expect(html).toContain('title="Prospecting: $150,000"');
    expect(html).toContain('title="Negotiation: $150,000"');
    expect(html).toContain("3 · <b>$300k</b>");
  });

  test("a stage outside the workspace stage order still renders", () => {
    const html = strip([{ stage: "custom_stage", value: 2000 }]);
    expect(html).toContain("custom_stage");
    expect(html).toContain('background:var(--ctp-overlay0)');
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
});
