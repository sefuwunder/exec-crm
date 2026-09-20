// tests/batch-five.test.ts — ranked exec-crm batch 5:
// 1. deal stage-transition history, 2. task dependencies, 3. deal source,
// 4. contact/company duplicate detection & merge, 5. saved views + bulk actions.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("batch five API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3471";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let mainId: number, betaId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-batch5-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3471", CRM_UPLOADS: join(dir, "uploads") },
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

  // ---------------- 1. stage-transition history ----------------
  test("history: creation logs an opened row, moves append with names", async () => {
    const d = (await api("POST", "/api/deals", { title: "Journey deal", source: "Web" }, mainId)).data.deal;
    let h = (await api("GET", `/api/deals/${d.id}/history`, undefined, mainId)).data.history;
    expect(h).toHaveLength(1);
    expect(h[0].to_stage).toBe("prospecting");
    expect(h[0].to_name).toBe("Prospecting");
    await api("PATCH", `/api/deals/${d.id}`, { stage: "negotiation" }, mainId);
    h = (await api("GET", `/api/deals/${d.id}/history`, undefined, mainId)).data.history;
    expect(h).toHaveLength(2);
    expect(h[1].from_stage).toBe("prospecting");
    expect(h[1].from_name).toBe("Prospecting");
    expect(h[1].to_name).toBe("Negotiation");
    // chronological
    expect(h[1].id).toBeGreaterThan(h[0].id);
  });

  test("history: workspace-isolated, deal deletion clears it", async () => {
    const d = (await api("POST", "/api/deals", { title: "Ws deal" }, mainId)).data.deal;
    const other = await api("GET", `/api/deals/${d.id}/history`, undefined, betaId);
    expect(other.status).toBe(404);
    await api("DELETE", `/api/deals/${d.id}`, undefined, mainId);
    const gone = await api("GET", `/api/deals/${d.id}/history`, undefined, mainId);
    expect(gone.status).toBe(404);
  });

  // ---------------- 2. task dependencies ----------------
  test("dependencies: replace semantics, blocked_by, is_blocked", async () => {
    const t1 = (await api("POST", "/api/tasks", { title: "Dep A" }, mainId)).data.task;
    const t2 = (await api("POST", "/api/tasks", { title: "Dep B" }, mainId)).data.task;
    const t3 = (await api("POST", "/api/tasks", { title: "Dep C" }, mainId)).data.task;
    const r = await api("POST", `/api/tasks/${t3.id}/dependencies`, { depends_on: [t1.id, t2.id] }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.blocked_by.map((b: any) => b.title).sort()).toEqual(["Dep A", "Dep B"]);
    expect(r.data.is_blocked).toBe(true);
    // replace (not append)
    const r2 = await api("POST", `/api/tasks/${t3.id}/dependencies`, { depends_on: [t1.id] }, mainId);
    expect(r2.data.blocked_by).toHaveLength(1);
    // task list carries the metadata
    const list = (await api("GET", "/api/tasks", undefined, mainId)).data.tasks;
    const row = list.find((t: any) => t.id === t3.id);
    expect(row.is_blocked).toBe(true);
    expect(row.blocked_by[0].title).toBe("Dep A");
    // completing the predecessor unblocks
    await api("POST", `/api/tasks/${t1.id}/toggle`, undefined, mainId);
    const list2 = (await api("GET", "/api/tasks", undefined, mainId)).data.tasks;
    expect(list2.find((t: any) => t.id === t3.id).is_blocked).toBe(false);
  });

  test("dependencies: cycle, self-dependency, unknown and cross-workspace rejected", async () => {
    const a = (await api("POST", "/api/tasks", { title: "Cy A" }, mainId)).data.task;
    const b = (await api("POST", "/api/tasks", { title: "Cy B" }, mainId)).data.task;
    const c = (await api("POST", "/api/tasks", { title: "Cy C" }, mainId)).data.task;
    await api("POST", `/api/tasks/${b.id}/dependencies`, { depends_on: [a.id] }, mainId);
    await api("POST", `/api/tasks/${c.id}/dependencies`, { depends_on: [b.id] }, mainId);
    const cyc = await api("POST", `/api/tasks/${a.id}/dependencies`, { depends_on: [c.id] }, mainId);
    expect(cyc.status).toBe(400);
    expect(cyc.data.error).toMatch(/cycle/);
    const self = await api("POST", `/api/tasks/${a.id}/dependencies`, { depends_on: [a.id] }, mainId);
    expect(self.status).toBe(400);
    const unknown = await api("POST", `/api/tasks/${a.id}/dependencies`, { depends_on: [99999] }, mainId);
    expect(unknown.status).toBe(400);
    const foreign = (await api("POST", "/api/tasks", { title: "Foreign" }, betaId)).data.task;
    const xws = await api("POST", `/api/tasks/${a.id}/dependencies`, { depends_on: [foreign.id] }, mainId);
    expect(xws.status).toBe(400);
  });

  test("dependencies: deleting a task clears its edges", async () => {
    const p = (await api("POST", "/api/tasks", { title: "Edge P" }, mainId)).data.task;
    const q = (await api("POST", "/api/tasks", { title: "Edge Q" }, mainId)).data.task;
    await api("POST", `/api/tasks/${q.id}/dependencies`, { depends_on: [p.id] }, mainId);
    await api("DELETE", `/api/tasks/${p.id}`, undefined, mainId);
    const list = (await api("GET", "/api/tasks", undefined, mainId)).data.tasks;
    const row = list.find((t: any) => t.id === q.id);
    expect(row.is_blocked).toBe(false);
    expect(row.blocked_by).toHaveLength(0);
  });

  // ---------------- 3. deal source ----------------
  test("source: create, PATCH, distinct list, filter", async () => {
    const d = (await api("POST", "/api/deals", { title: "Src deal", source: "Referral" }, mainId)).data.deal;
    expect(d.source).toBe("Referral");
    await api("PATCH", `/api/deals/${d.id}`, { source: "Cold outbound" }, mainId);
    const srcs = (await api("GET", "/api/deal-sources", undefined, mainId)).data.sources;
    expect(srcs).toContain("Cold outbound");
    const filt = (await api("GET", "/api/deals?source=Cold%20outbound", undefined, mainId)).data.deals;
    expect(filt.length).toBeGreaterThan(0);
    expect(filt.every((x: any) => x.source === "Cold outbound")).toBe(true);
    const filt2 = (await api("GET", "/api/deals?source=Referral", undefined, mainId)).data.deals;
    expect(filt2.every((x: any) => x.source === "Referral")).toBe(true);
  });

  // ---------------- 4. duplicates ----------------
  test("duplicates: contacts by email (case-insensitive) and similar name", async () => {
    await api("POST", "/api/contacts", { name: "Jon Smith", email: "jon@example.com" }, mainId);
    await api("POST", "/api/contacts", { name: "Jon Smyth", email: "JON@EXAMPLE.COM" }, mainId);
    await api("POST", "/api/contacts", { name: "Alice Wonderland" }, mainId);
    await api("POST", "/api/contacts", { name: "Alic Wonderland" }, mainId); // levenshtein 1
    const { data } = await api("GET", "/api/duplicates?type=contact", undefined, mainId);
    const reasons = data.pairs.map((p: any) => [p.a.name, p.b.name, p.reason].join("|"));
    expect(reasons.some((r: string) => r.includes("Jon Smith") && r.includes("same email"))).toBe(true);
    expect(reasons.some((r: string) => r.includes("Alice Wonderland") && r.includes("similar name"))).toBe(true);
  });

  test("duplicates: companies by website host and similar name", async () => {
    await api("POST", "/api/companies", { name: "Acme Corp", website: "https://www.acme.com/about" }, mainId);
    await api("POST", "/api/companies", { name: "ACME Corporation", website: "acme.com" }, mainId);
    const { data } = await api("GET", "/api/duplicates?type=company", undefined, mainId);
    expect(data.pairs.length).toBeGreaterThan(0);
    expect(["same website", "similar name"]).toContain(data.pairs[0].reason);
  });

  test("duplicates: merge reassigns references, deletes loser, needs confirm", async () => {
    const w = (await api("POST", "/api/contacts", { name: "Keep Me", email: "keep@example.com" }, mainId)).data.contact;
    const l = (await api("POST", "/api/contacts", { name: "Drop Me", email: "drop@example.com" }, mainId)).data.contact;
    const deal = (await api("POST", "/api/deals", { title: "Merge deal", contact_id: l.id }, mainId)).data.deal;
    const noConfirm = await api("POST", "/api/duplicates/merge",
      { type: "contact", winner_id: w.id, loser_id: l.id }, mainId);
    expect(noConfirm.status).toBe(400);
    const sameId = await api("POST", "/api/duplicates/merge",
      { type: "contact", winner_id: w.id, loser_id: w.id, confirm: true }, mainId);
    expect(sameId.status).toBe(400);
    const ok = await api("POST", "/api/duplicates/merge",
      { type: "contact", winner_id: w.id, loser_id: l.id, confirm: true }, mainId);
    expect(ok.status).toBe(200);
    expect(ok.data.reassigned.deals).toBe(1);
    const after = (await api("GET", `/api/deals?search=${encodeURIComponent("Merge deal")}`, undefined, mainId)).data.deals;
    expect(after[0].contact_id).toBe(w.id);
    expect(after[0].contact_name).toBe("Keep Me");
    const dupes = (await api("GET", "/api/duplicates?type=contact", undefined, mainId)).data.pairs;
    expect(dupes.some((p: any) => p.a.id === l.id || p.b.id === l.id)).toBe(false);
  });

  test("duplicates: cross-workspace merge rejected", async () => {
    const w = (await api("POST", "/api/contacts", { name: "WsOne" }, mainId)).data.contact;
    const l = (await api("POST", "/api/contacts", { name: "WsTwo" }, betaId)).data.contact;
    const r = await api("POST", "/api/duplicates/merge",
      { type: "contact", winner_id: w.id, loser_id: l.id, confirm: true }, mainId);
    expect(r.status).toBe(400);
  });

  // ---------------- 5. saved views ----------------
  test("saved views: CRUD, filter cleaning, workspace isolation", async () => {
    const created = await api("POST", "/api/saved-views",
      { name: "Big ref", filters: { source: "Referral", min_value: "10000", evil: "x" } }, mainId);
    expect(created.status).toBe(201);
    expect(created.data.view.filters).toEqual({ source: "Referral", min_value: "10000" });
    const id = created.data.view.id;
    const list = (await api("GET", "/api/saved-views", undefined, mainId)).data.views;
    expect(list.some((v: any) => v.id === id)).toBe(true);
    const other = (await api("GET", "/api/saved-views", undefined, betaId)).data.views;
    expect(other.some((v: any) => v.id === id)).toBe(false);
    const patched = await api("PATCH", `/api/saved-views/${id}`, { name: "Big ref 2" }, mainId);
    expect(patched.data.view.name).toBe("Big ref 2");
    const del = await api("DELETE", `/api/saved-views/${id}`, undefined, mainId);
    expect(del.status).toBe(200);
    const gone = await api("DELETE", `/api/saved-views/${id}`, undefined, mainId);
    expect(gone.status).toBe(404);
    const blank = await api("POST", "/api/saved-views", { name: "" }, mainId);
    expect(blank.status).toBe(400);
  });

  // ---------------- 5b. bulk actions ----------------
  test("bulk: move_stage logs one history row per changed deal", async () => {
    const a = (await api("POST", "/api/deals", { title: "Bulk A" }, mainId)).data.deal;
    const b = (await api("POST", "/api/deals", { title: "Bulk B", stage: "qualification" }, mainId)).data.deal;
    const r = await api("POST", "/api/deals/bulk",
      { ids: [a.id, b.id], action: "move_stage", value: "negotiation" }, mainId);
    expect(r.data.affected).toBe(2);
    const ha = (await api("GET", `/api/deals/${a.id}/history`, undefined, mainId)).data.history;
    expect(ha[ha.length - 1].to_stage).toBe("negotiation");
    expect(ha[ha.length - 1].from_stage).toBe("prospecting");
    // no-op move: already on that stage, nothing logged
    const before = ha.length;
    await api("POST", "/api/deals/bulk", { ids: [a.id], action: "move_stage", value: "negotiation" }, mainId);
    const ha2 = (await api("GET", `/api/deals/${a.id}/history`, undefined, mainId)).data.history;
    expect(ha2.length).toBe(before);
  });

  test("bulk: set_owner / set_source, invalid action, unknown id rejects all", async () => {
    const a = (await api("POST", "/api/deals", { title: "Bulk C" }, mainId)).data.deal;
    await api("POST", "/api/deals/bulk", { ids: [a.id], action: "set_owner", value: "Maya" }, mainId);
    await api("POST", "/api/deals/bulk", { ids: [a.id], action: "set_source", value: "Event" }, mainId);
    const d = (await api("GET", `/api/deals?search=${encodeURIComponent("Bulk C")}`, undefined, mainId)).data.deals[0];
    expect(d.owner).toBe("Maya");
    expect(d.source).toBe("Event");
    const bad = await api("POST", "/api/deals/bulk", { ids: [a.id], action: "explode" }, mainId);
    expect(bad.status).toBe(400);
    const unknown = await api("POST", "/api/deals/bulk", { ids: [a.id, 99999], action: "set_owner", value: "X" }, mainId);
    expect(unknown.status).toBe(400);
  });

  test("bulk: delete needs confirm and clears stage history", async () => {
    const a = (await api("POST", "/api/deals", { title: "Bulk D" }, mainId)).data.deal;
    const noConf = await api("POST", "/api/deals/bulk", { ids: [a.id], action: "delete" }, mainId);
    expect(noConf.status).toBe(400);
    const ok = await api("POST", "/api/deals/bulk", { ids: [a.id], action: "delete", confirm: true }, mainId);
    expect(ok.data.affected).toBe(1);
    const h = await api("GET", `/api/deals/${a.id}/history`, undefined, mainId);
    expect(h.status).toBe(404);
  });

  test("GET /api/deals accepts the full filter set incl. stage", async () => {
    await api("POST", "/api/deals", { title: "Filter me", stage: "proposal", owner: "Zoe", value: 50000, source: "Partner" }, mainId);
    const byStage = (await api("GET", "/api/deals?stage=proposal", undefined, mainId)).data.deals;
    expect(byStage.length).toBeGreaterThan(0);
    expect(byStage.every((d: any) => d.stage === "proposal")).toBe(true);
    const combo = (await api("GET", "/api/deals?stage=proposal&owner=Zoe&source=Partner&min_value=40000&search=Filter%20me", undefined, mainId)).data.deals;
    expect(combo.length).toBe(1);
    expect(combo[0].title).toBe("Filter me");
  });
});
