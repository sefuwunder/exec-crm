// tests/batch-five-fixes.test.ts — follow-ups to batch five:
// 1. server-side blocked-task guard on POST /api/tasks/:id/toggle
// 2. company merge reassigns campaigns.company_id
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("batch five fixes", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3472";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let w: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-batch5fix-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3472", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    w = (await api("GET", "/api/workspaces")).data.workspaces[0].id;
  });
  afterAll(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

  test("toggle: completing a blocked task without confirm -> 409 with blocked_by", async () => {
    const a = (await api("POST", "/api/tasks", { title: "predecessor" }, w)).data.task;
    const b = (await api("POST", "/api/tasks", { title: "blocked one" }, w)).data.task;
    await api("POST", `/api/tasks/${b.id}/dependencies`, { depends_on: [a.id] }, w);
    const r = await api("POST", `/api/tasks/${b.id}/toggle`, {}, w);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("blocked");
    expect(r.data.blocked_by).toHaveLength(1);
    expect(r.data.blocked_by[0].title).toBe("predecessor");
    // task must still be open
    const t = (await api("GET", "/api/tasks", undefined, w)).data.tasks.find((x: any) => x.id === b.id);
    expect(t.done).toBe(0);
  });

  test("toggle: confirm:true overrides the blocked guard", async () => {
    const tasks = (await api("GET", "/api/tasks", undefined, w)).data.tasks;
    const b = tasks.find((x: any) => x.title === "blocked one");
    const r = await api("POST", `/api/tasks/${b.id}/toggle`, { confirm: true }, w);
    expect(r.status).toBe(200);
    expect(r.data.task.done).toBe(1);
  });

  test("toggle: non-blocked completion unaffected; un-completing never 409s", async () => {
    const free = (await api("POST", "/api/tasks", { title: "free task" }, w)).data.task;
    const done = await api("POST", `/api/tasks/${free.id}/toggle`, {}, w);
    expect(done.status).toBe(200);
    expect(done.data.task.done).toBe(1);
    // toggle back to open — no confirm needed even though it has no blockers either way
    const undone = await api("POST", `/api/tasks/${free.id}/toggle`, {}, w);
    expect(undone.status).toBe(200);
    expect(undone.data.task.done).toBe(0);
    // un-completing a blocked task also never 409s
    const tasks = (await api("GET", "/api/tasks", undefined, w)).data.tasks;
    const blockedDone = tasks.find((x: any) => x.title === "blocked one");
    const back = await api("POST", `/api/tasks/${blockedDone.id}/toggle`, {}, w);
    expect(back.status).toBe(200);
    expect(back.data.task.done).toBe(0);
  });

  test("company merge reassigns campaigns to the winner", async () => {
    const win = (await api("POST", "/api/companies", { name: "Winner Co" }, w)).data.company;
    const lose = (await api("POST", "/api/companies", { name: "Loser Co" }, w)).data.company;
    const camp = (await api("POST", "/api/campaigns", { name: "Loser campaign", company_id: lose.id }, w)).data.campaign;
    expect(camp.company_id).toBe(lose.id);
    const m = await api("POST", "/api/duplicates/merge", { type: "company", winner_id: win.id, loser_id: lose.id, confirm: true }, w);
    expect(m.status).toBe(200);
    expect(m.data.reassigned.campaigns).toBe(1);
    const camps = (await api("GET", "/api/campaigns", undefined, w)).data.campaigns;
    const moved = camps.find((c: any) => c.id === camp.id);
    expect(moved.company_id).toBe(win.id);
    expect(camps.some((c: any) => c.company_id === lose.id)).toBe(false);
    // loser is gone
    const losers = (await api("GET", "/api/companies", undefined, w)).data.companies;
    expect(losers.some((c: any) => c.id === lose.id)).toBe(false);
  });
});
