// tests/calendar.test.ts — GET /api/calendar at global/campaign/deal scopes.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("calendar API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3467";
  const api = async (method: string, p: string, body?: any, ws?: number) => {
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };

  let mainWs: number, betaWs: number;
  let campId: number, dealA: number, dealB: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-cal-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3467", CRM_UPLOADS: join(dir, "uploads") },
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
    const { data: wsData } = await api("GET", "/api/workspaces");
    mainWs = wsData.workspaces[0].id;
    // fresh DBs get demo seed data — wipe dated entities so assertions are exact
    const seedDb = new Database(join(dir, "test.db"));
    seedDb.exec("DELETE FROM tasks; DELETE FROM deals; DELETE FROM activities;");
    seedDb.close();
    betaWs = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;

    const co = (await api("POST", "/api/companies", { name: "Acme" }, mainWs)).data.company;
    campId = (await api("POST", "/api/campaigns", {
      name: "Q4 push", company_id: co.id,
      start_date: "2026-01-05", // pins autopopulated workflow tasks to Jan–Mar, outside test windows
    }, mainWs)).data.campaign.id;
    dealA = (await api("POST", "/api/deals", {
      title: "Big deal", value: 50000, company_id: co.id, campaign_id: campId,
      stage: "negotiation", expected_close: "2026-10-15",
    }, mainWs)).data.deal.id;
    dealB = (await api("POST", "/api/deals", {
      title: "Dateless deal", value: 1000, expected_close: "",
    }, mainWs)).data.deal.id;
    await api("POST", "/api/tasks", { title: "Call Acme", due_date: "2026-10-15", deal_id: dealA }, mainWs);
    await api("POST", "/api/tasks", { title: "Campaign blast", due_date: "2026-10-20", campaign_id: campId }, mainWs);
    await api("POST", "/api/tasks", { title: "Undated chore", due_date: "" }, mainWs);
    // second workspace: must never leak into the first
    const co2 = (await api("POST", "/api/companies", { name: "Globex" }, betaWs)).data.company;
    await api("POST", "/api/deals", {
      title: "Beta deal", value: 7000, company_id: co2.id, expected_close: "2026-10-15",
    }, betaWs);
    await api("POST", "/api/tasks", { title: "Beta task", due_date: "2026-10-15" }, betaWs);
  });

  afterAll(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("global scope returns dated deals and tasks, excludes undated and other workspaces", async () => {
    const { status, data } = await api("GET", "/api/calendar?scope=global&from=2026-10-01&to=2026-10-31", undefined, mainWs);
    expect(status).toBe(200);
    const titles = data.items.map((i: any) => `${i.type}:${i.title}`);
    expect(titles).toContain("deal:Big deal");
    expect(titles).toContain("task:Call Acme");
    expect(titles).toContain("task:Campaign blast");
    expect(titles).not.toContain("deal:Dateless deal");
    expect(titles).not.toContain("task:Undated chore");
    expect(titles).not.toContain("deal:Beta deal");
    expect(titles).not.toContain("task:Beta task");
    const deal = data.items.find((i: any) => i.type === "deal");
    expect(deal.date).toBe("2026-10-15");
    expect(deal.stage_name).toBe("Negotiation");
    expect(deal.company_name).toBe("Acme");
    // sorted by date
    const dates = data.items.map((i: any) => i.date);
    expect([...dates].sort()).toEqual(dates);
  });

  test("global scope honors the from/to window", async () => {
    const { data } = await api("GET", "/api/calendar?scope=global&from=2026-10-16&to=2026-10-31", undefined, mainWs);
    expect(data.items.map((i: any) => i.title)).toEqual(["Campaign blast"]);
  });

  test("campaign scope: campaign deals plus direct and deal-linked tasks", async () => {
    const { status, data } = await api("GET", `/api/calendar?scope=campaign&id=${campId}&from=2026-10-01&to=2026-10-31`, undefined, mainWs);
    expect(status).toBe(200);
    const titles = data.items.map((i: any) => `${i.type}:${i.title}`);
    expect(titles).toContain("deal:Big deal");
    expect(titles).toContain("task:Call Acme"); // linked via the campaign's deal
    expect(titles).toContain("task:Campaign blast"); // linked directly
    expect(titles).not.toContain("task:Undated chore");
  });

  test("campaign scope validates the id", async () => {
    expect((await api("GET", "/api/calendar?scope=campaign", undefined, mainWs)).status).toBe(400);
    expect((await api("GET", "/api/calendar?scope=campaign&id=99999", undefined, mainWs)).status).toBe(400);
  });

  test("deal scope: the deal's close date plus its tasks only", async () => {
    const { status, data } = await api("GET", `/api/calendar?scope=deal&id=${dealA}&from=2026-10-01&to=2026-10-31`, undefined, mainWs);
    expect(status).toBe(200);
    const titles = data.items.map((i: any) => `${i.type}:${i.title}`);
    expect(titles).toContain("deal:Big deal");
    expect(titles).toContain("task:Call Acme");
    expect(titles).not.toContain("task:Campaign blast");
    const other = await api("GET", `/api/calendar?scope=deal&id=${dealB}&from=2026-10-01&to=2026-10-31`, undefined, mainWs);
    expect(other.data.items).toEqual([]);
  });

  test("deal scope validates the id; unknown scope is a 400", async () => {
    expect((await api("GET", "/api/calendar?scope=deal", undefined, mainWs)).status).toBe(400);
    expect((await api("GET", "/api/calendar?scope=deal&id=99999", undefined, mainWs)).status).toBe(400);
    expect((await api("GET", "/api/calendar?scope=fortnight", undefined, mainWs)).status).toBe(400);
  });

  test("second workspace sees only its own items", async () => {
    const { data } = await api("GET", "/api/calendar?scope=global&from=2026-10-01&to=2026-10-31", undefined, betaWs);
    const titles = data.items.map((i: any) => `${i.type}:${i.title}`).sort();
    expect(titles).toEqual(["deal:Beta deal", "task:Beta task"]);
  });
});
