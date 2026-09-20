// tests/company-delete.test.ts — DELETE /api/companies/:id
// Workspace scoping, 409 with linked-record counts, confirm-true orphan flow,
// clean delete without confirm, cross-workspace 404, UI wiring for the
// company edit modal's Delete button.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

describe("company delete API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3475";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let mainId: number, betaId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-codel-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3475", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
  });
  afterAll(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

  test("404 for unknown company id", async () => {
    const { status } = await api("DELETE", "/api/companies/99999", undefined, mainId);
    expect(status).toBe(404);
  });

  test("404 for company id in another workspace", async () => {
    const co = (await api("POST", "/api/companies", { name: "Beta Corp" }, betaId)).data.company;
    const { status } = await api("DELETE", `/api/companies/${co.id}`, undefined, mainId);
    expect(status).toBe(404);
    // still there in its own workspace
    const { data } = await api("GET", "/api/companies", undefined, betaId);
    expect(data.companies.some((c: any) => c.id === co.id)).toBe(true);
  });

  test("clean delete without confirm when zero links", async () => {
    const co = (await api("POST", "/api/companies", { name: "Lone Star" }, mainId)).data.company;
    const { status, data } = await api("DELETE", `/api/companies/${co.id}`, undefined, mainId);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.orphaned).toEqual({ contacts: 0, deals: 0, campaigns: 0 });
    const { data: after } = await api("GET", "/api/companies", undefined, mainId);
    expect(after.companies.some((c: any) => c.id === co.id)).toBe(false);
  });

  test("409 with counts when linked and no confirm; nothing deleted", async () => {
    const co = (await api("POST", "/api/companies", { name: "Linked Inc" }, mainId)).data.company;
    await api("POST", "/api/contacts", { name: "Link Person", company_id: co.id }, mainId);
    await api("POST", "/api/contacts", { name: "Link Person 2", company_id: co.id }, mainId);
    await api("POST", "/api/deals", { title: "Linked Deal", company_id: co.id }, mainId);
    await api("POST", "/api/campaigns", { name: "Linked Campaign", company_id: co.id }, mainId);
    const { status, data } = await api("DELETE", `/api/companies/${co.id}`, undefined, mainId);
    expect(status).toBe(409);
    expect(data.contacts).toBe(2);
    expect(data.deals).toBe(1);
    expect(data.campaigns).toBe(1);
    expect(data.hint).toContain("confirm:true");
    // company still present
    const { data: after } = await api("GET", "/api/companies", undefined, mainId);
    expect(after.companies.some((c: any) => c.id === co.id)).toBe(true);
  });

  test("confirm:true orphans linked records and deletes the company", async () => {
    const co = (await api("POST", "/api/companies", { name: "Orphan Corp" }, mainId)).data.company;
    const ct = (await api("POST", "/api/contacts", { name: "Orphan Contact", company_id: co.id }, mainId)).data.contact;
    const dl = (await api("POST", "/api/deals", { title: "Orphan Deal", company_id: co.id }, mainId)).data.deal;
    const cp = (await api("POST", "/api/campaigns", { name: "Orphan Campaign", company_id: co.id }, mainId)).data.campaign;
    // confirm via JSON body
    const { status, data } = await api("DELETE", `/api/companies/${co.id}`, { confirm: true }, mainId);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.orphaned).toEqual({ contacts: 1, deals: 1, campaigns: 1 });
    // company gone
    const { data: comps } = await api("GET", "/api/companies", undefined, mainId);
    expect(comps.companies.some((c: any) => c.id === co.id)).toBe(false);
    // linked records intact with null company_id
    const { data: cts } = await api("GET", "/api/contacts", undefined, mainId);
    const c = cts.contacts.find((x: any) => x.id === ct.id);
    expect(c).toBeTruthy();
    expect(c.company_id).toBeNull();
    const { data: dls } = await api("GET", "/api/deals", undefined, mainId);
    const d = dls.deals.find((x: any) => x.id === dl.id);
    expect(d).toBeTruthy();
    expect(d.company_id).toBeNull();
    const { data: cps } = await api("GET", "/api/campaigns", undefined, mainId);
    const k = cps.campaigns.find((x: any) => x.id === cp.id);
    expect(k).toBeTruthy();
    expect(k.company_id).toBeNull();
  });

  test("confirm via query param also works", async () => {
    const co = (await api("POST", "/api/companies", { name: "Query Corp" }, mainId)).data.company;
    await api("POST", "/api/contacts", { name: "Query Contact", company_id: co.id }, mainId);
    const { status, data } = await api("DELETE", `/api/companies/${co.id}?confirm=true`, undefined, mainId);
    expect(status).toBe(200);
    expect(data.orphaned.contacts).toBe(1);
  });
});

describe("company delete UI", () => {
  test("editCompanyModal renders a red Delete button wired to deleteCompany", () => {
    expect(appSrc).toContain('id="m-del-company"');
    expect(appSrc).toContain("btn danger small");
    expect(appSrc).toContain('$("#m-del-company").onclick = () => deleteCompany(c)');
    expect(appSrc).toContain("async function deleteCompany(c)");
  });

  test("deleteCompany surfaces 409 counts with typed-DELETE confirm, then retries with confirm", () => {
    const fn = appSrc.slice(appSrc.indexOf("async function deleteCompany(c)"));
    expect(fn).toContain("res.status === 409");
    expect(fn).toContain("Type <b>DELETE</b> to confirm");
    expect(fn).toContain("orphan");
    expect(fn).toContain("?confirm=true");
    // no orphan counts text must reach the user
    expect(fn).toContain("j.contacts");
    expect(fn).toContain("j.deals");
    expect(fn).toContain("j.campaigns");
  });
});
