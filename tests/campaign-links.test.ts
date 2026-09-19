// tests/campaign-links.test.ts — campaign <-> deals/contacts/companies linkage.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- db-level
describe("campaign_id migration", () => {
  test("legacy DB (no campaign_id columns) gains them on deals/contacts/companies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-camp-mig-"));
    const db = new Database(join(dir, "t.db"), { create: true });
    db.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT DEFAULT '#579bfc', created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`INSERT INTO workspaces (name) VALUES ('Main')`);
    for (const t of ["deals", "contacts", "companies"]) {
      db.exec(`CREATE TABLE ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT,
        workspace_id INTEGER REFERENCES workspaces(id))`);
    }
    db.close();
    const mdb = openDb(join(dir, "t.db"));
    for (const t of ["deals", "contacts", "companies"]) {
      const cols = mdb.query(`PRAGMA table_info(${t})`).all() as any[];
      expect(cols.some((c) => c.name === "campaign_id")).toBe(true);
    }
    // idempotent: reopening doesn't fail or duplicate
    mdb.close();
    const mdb2 = openDb(join(dir, "t.db"));
    for (const t of ["deals", "contacts", "companies"]) {
      const cols = mdb2.query(`PRAGMA table_info(${t})`).all() as any[];
      expect(cols.filter((c) => c.name === "campaign_id")).toHaveLength(1);
    }
    mdb2.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- API
describe("campaign linkage API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3461";
  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };

  let mainId: number, betaId: number;
  let companyId: number, campaignId: number;
  let dealId: number, contactId: number, linkCompanyId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-camp-live-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3461", CRM_UPLOADS: join(dir, "uploads") },
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
    const beta = await api("POST", "/api/workspaces", { name: "Beta" });
    betaId = beta.data.workspace.id;
    const cos = await api("GET", "/api/companies", undefined, mainId);
    companyId = cos.data.companies[0].id;
  });
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("POST /api/campaigns requires a company and creates", async () => {
    expect((await api("POST", "/api/campaigns", { name: "No co" }, mainId)).status).toBe(400);
    const r = await api("POST", "/api/campaigns", { name: "Q4 Push", company_id: companyId }, mainId);
    expect(r.status).toBe(201);
    campaignId = r.data.campaign.id;
  });

  test("deal: link at create, filter by campaign, unknown -> 400", async () => {
    const r = await api("POST", "/api/deals",
      { title: "Campaign deal", value: 50000, campaign_id: campaignId }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.deal.campaign_id).toBe(campaignId);
    dealId = r.data.deal.id;
    const bad = await api("POST", "/api/deals",
      { title: "Ghost deal", campaign_id: 999999 }, mainId);
    expect(bad.status).toBe(400);
    const filtered = await api("GET", `/api/deals?campaign_id=${campaignId}`, undefined, mainId);
    expect(filtered.status).toBe(200);
    expect(filtered.data.deals.map((d: any) => d.id)).toContain(dealId);
    // seeded demo deals are unlinked, so the unfiltered list is larger
    const all = await api("GET", "/api/deals", undefined, mainId);
    expect(all.data.deals.length).toBeGreaterThan(filtered.data.deals.length);
  });

  test("deal: PATCH assign / unassign / unknown", async () => {
    const d = await api("POST", "/api/deals", { title: "Unlinked deal" }, mainId);
    const id = d.data.deal.id;
    expect(d.data.deal.campaign_id).toBeNull();
    const a = await api("PATCH", `/api/deals/${id}`, { campaign_id: campaignId }, mainId);
    expect(a.status).toBe(200);
    expect(a.data.deal.campaign_id).toBe(campaignId);
    const u = await api("PATCH", `/api/deals/${id}`, { campaign_id: "" }, mainId);
    expect(u.status).toBe(200);
    expect(u.data.deal.campaign_id).toBeNull();
    const bad = await api("PATCH", `/api/deals/${id}`, { campaign_id: 424242 }, mainId);
    expect(bad.status).toBe(400);
    // deal untouched by the failed patch
    const again = await api("GET", `/api/deals?campaign_id=${campaignId}`, undefined, mainId);
    expect(again.data.deals.map((x: any) => x.id)).not.toContain(id);
  });

  test("contact: link at create, PATCH, filter, unknown -> 400", async () => {
    const r = await api("POST", "/api/contacts",
      { name: "Campaign Contact", email: "cc@example.com", campaign_id: campaignId }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.contact.campaign_id).toBe(campaignId);
    contactId = r.data.contact.id;
    expect((await api("POST", "/api/contacts", { name: "Ghost", campaign_id: 999999 }, mainId)).status).toBe(400);
    const filtered = await api("GET", `/api/contacts?campaign_id=${campaignId}`, undefined, mainId);
    expect(filtered.data.contacts.map((c: any) => c.id)).toContain(contactId);
    const u = await api("PATCH", `/api/contacts/${contactId}`, { campaign_id: "" }, mainId);
    expect(u.data.contact.campaign_id).toBeNull();
    const back = await api("PATCH", `/api/contacts/${contactId}`, { campaign_id: campaignId }, mainId);
    expect(back.data.contact.campaign_id).toBe(campaignId);
    expect((await api("PATCH", `/api/contacts/${contactId}`, { campaign_id: 999999 }, mainId)).status).toBe(400);
  });

  test("company: link at create, PATCH, filter, unknown -> 400", async () => {
    const r = await api("POST", "/api/companies",
      { name: "Campaign Co", campaign_id: campaignId }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.company.campaign_id).toBe(campaignId);
    linkCompanyId = r.data.company.id;
    expect((await api("POST", "/api/companies", { name: "Ghost Co", campaign_id: 999999 }, mainId)).status).toBe(400);
    const filtered = await api("GET", `/api/companies?campaign_id=${campaignId}`, undefined, mainId);
    expect(filtered.data.companies.map((c: any) => c.id)).toContain(linkCompanyId);
    const u = await api("PATCH", `/api/companies/${linkCompanyId}`, { campaign_id: null }, mainId);
    expect(u.data.company.campaign_id).toBeNull();
    const back = await api("PATCH", `/api/companies/${linkCompanyId}`, { campaign_id: campaignId }, mainId);
    expect(back.data.company.campaign_id).toBe(campaignId);
    expect((await api("PATCH", `/api/companies/${linkCompanyId}`, { campaign_id: 999999 }, mainId)).status).toBe(400);
  });

  test("workspace isolation: a campaign never sees another workspace's entities", async () => {
    // a Beta deal cannot be linked to Main's campaign
    const bd = await api("POST", "/api/deals", { title: "Beta deal" }, betaId);
    expect((await api("PATCH", `/api/deals/${bd.data.deal.id}`, { campaign_id: campaignId }, betaId)).status).toBe(400);
    // Main's campaign filter in Beta returns nothing
    const f = await api("GET", `/api/deals?campaign_id=${campaignId}`, undefined, betaId);
    expect(f.data.deals).toHaveLength(0);
    const fc = await api("GET", `/api/contacts?campaign_id=${campaignId}`, undefined, betaId);
    expect(fc.data.contacts).toHaveLength(0);
    const fco = await api("GET", `/api/companies?campaign_id=${campaignId}`, undefined, betaId);
    expect(fco.data.companies).toHaveLength(0);
    // and a Beta campaign is invisible from Main
    const bco = await api("POST", "/api/companies", { name: "Beta Co" }, betaId);
    const bc = await api("POST", "/api/campaigns", { name: "Beta camp", company_id: bco.data.company.id }, betaId);
    expect((await api("PATCH", `/api/deals/${dealId}`, { campaign_id: bc.data.campaign.id }, mainId)).status).toBe(400);
  });

  test("unknown campaign id -> 404 on campaign endpoints", async () => {
    expect((await api("PATCH", "/api/campaigns/999999", { name: "x" }, mainId)).status).toBe(404);
    expect((await api("DELETE", "/api/campaigns/999999", undefined, mainId)).status).toBe(404);
  });

  test("DELETE campaign unlinks entities but never removes them", async () => {
    const del = await api("DELETE", `/api/campaigns/${campaignId}`, undefined, mainId);
    expect(del.status).toBe(200);
    for (const [path, id] of [
      ["/api/deals", dealId],
      ["/api/contacts", contactId],
      ["/api/companies", linkCompanyId],
    ] as const) {
      const all = await api("GET", path, undefined, mainId);
      const row = all.data[path.slice(5)].find((x: any) => x.id === id);
      expect(row).toBeTruthy();
      expect(row.campaign_id).toBeNull();
    }
  });
});
