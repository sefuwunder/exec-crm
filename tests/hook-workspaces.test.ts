// tests/hook-workspaces.test.ts — incoming hooks are per-workspace.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("incoming hook migration", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "crm-hook-mig-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("legacy incoming hooks are backfilled into Main", () => {
    const path = join(dir, "legacy.db");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        color TEXT DEFAULT '#579bfc', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE incoming_hooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
    `);
    db.prepare("INSERT INTO workspaces (name, color) VALUES ('Main', '#579bfc')").run();
    db.prepare("INSERT INTO incoming_hooks (name, key) VALUES ('Old intake', 'abc123')").run();
    db.close();
    const m = openDb(path);
    const hooks = m.query("SELECT workspace_id FROM incoming_hooks").all() as any[];
    expect(hooks.length).toBe(1);
    const mainId = (m.query("SELECT id FROM workspaces ORDER BY id LIMIT 1").get() as any).id;
    expect(hooks[0].workspace_id).toBe(mainId);
    m.close();
  });
});

describe("incoming hook workspace API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3458";
  const j = (r: Response) => r.json();

  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-hook-live-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3458", CRM_UPLOADS: join(dir, "uploads") },
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
  });
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  let mainId: number;
  let betaId: number;
  let mainHook: any;
  let betaHook: any;

  test("workspaces exist", async () => {
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    const r = await api("POST", "/api/workspaces", { name: "Beta", color: "#ff8a5c" });
    betaId = r.data.workspace.id;
  });

  test("hook creation binds to the active workspace", async () => {
    const a = await api("POST", "/api/hooks", { name: "Main intake" }, mainId);
    expect(a.status).toBe(201);
    expect(a.data.hook.workspace_id).toBe(mainId);
    mainHook = a.data.hook;
    const b = await api("POST", "/api/hooks", { name: "Beta intake" }, betaId);
    expect(b.status).toBe(201);
    expect(b.data.hook.workspace_id).toBe(betaId);
    betaHook = b.data.hook;
  });

  test("GET /api/hooks is isolated per workspace, with workspace info", async () => {
    const a = await api("GET", "/api/hooks", undefined, mainId);
    expect(a.data.hooks.map((h: any) => h.name)).toEqual(["Main intake"]);
    expect(a.data.hooks[0].workspace_name).toBe("Main");
    expect(a.data.hooks[0].workspace_color).toBeTruthy();
    const b = await api("GET", "/api/hooks", undefined, betaId);
    expect(b.data.hooks.map((h: any) => h.name)).toEqual(["Beta intake"]);
  });

  test("?all=1 lists every workspace's hooks", async () => {
    const r = await api("GET", "/api/hooks?all=1", undefined, mainId);
    const names = r.data.hooks.map((h: any) => h.name).sort();
    expect(names).toEqual(["Beta intake", "Main intake"]);
  });

  test("incoming POST lands in the hook's workspace with no params", async () => {
    const r = await fetch(`${BASE}/api/hooks/in/${mainHook.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_deal", data: { title: "Hook deal A", value: 5000 } }),
    });
    expect(r.status).toBe(201);
    const mainDeals = await api("GET", "/api/deals", undefined, mainId);
    expect(mainDeals.data.deals.map((d: any) => d.title)).toContain("Hook deal A");
    const betaDeals = await api("GET", "/api/deals", undefined, betaId);
    expect(betaDeals.data.deals.map((d: any) => d.title)).not.toContain("Hook deal A");
  });

  test("beta hook deliveries stay in beta", async () => {
    const r = await fetch(`${BASE}/api/hooks/in/${betaHook.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_task", data: { title: "Hook task B" } }),
    });
    expect(r.status).toBe(201);
    const tasks = await api("GET", "/api/tasks", undefined, betaId);
    expect(tasks.data.tasks.map((t: any) => t.title)).toContain("Hook task B");
    const mainTasks = await api("GET", "/api/tasks", undefined, mainId);
    expect(mainTasks.data.tasks.map((t: any) => t.title)).not.toContain("Hook task B");
  });

  test("explicit ?workspace= overrides the hook's workspace", async () => {
    const r = await fetch(`${BASE}/api/hooks/in/${mainHook.key}?workspace=${betaId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_deal", data: { title: "Override deal" } }),
    });
    expect(r.status).toBe(201);
    const betaDeals = await api("GET", "/api/deals", undefined, betaId);
    expect(betaDeals.data.deals.map((d: any) => d.title)).toContain("Override deal");
  });

  test("unknown ?workspace= on incoming route is a 400", async () => {
    const r = await fetch(`${BASE}/api/hooks/in/${mainHook.key}?workspace=99999`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_deal", data: { title: "X" } }),
    });
    expect(r.status).toBe(400);
  });

  test("PATCH moves a hook between workspaces", async () => {
    const r = await api("PATCH", `/api/hooks/${betaHook.id}`, { workspace_id: betaId }); // no-op move
    expect(r.status).toBe(200);
    const moved = await api("PATCH", `/api/hooks/${betaHook.id}`, { workspace_id: mainId });
    expect(moved.status).toBe(200);
    expect(moved.data.hook.workspace_id).toBe(mainId);
    // deliveries now follow the hook
    const dr = await fetch(`${BASE}/api/hooks/in/${betaHook.key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_deal", data: { title: "Moved hook deal" } }),
    });
    expect(dr.status).toBe(201);
    const mainDeals = await api("GET", "/api/deals", undefined, mainId);
    expect(mainDeals.data.deals.map((d: any) => d.title)).toContain("Moved hook deal");
    // and the hook shows up in main's manager list, not beta's
    const betaHooks = await api("GET", "/api/hooks", undefined, betaId);
    expect(betaHooks.data.hooks.map((h: any) => h.name)).not.toContain("Beta intake");
  });

  test("PATCH rejects an unknown workspace_id", async () => {
    const r = await api("PATCH", `/api/hooks/${mainHook.id}`, { workspace_id: 99999 });
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/unknown workspace/);
  });

  test("PATCH can rename a hook", async () => {
    const r = await api("PATCH", `/api/hooks/${mainHook.id}`, { name: "Main intake v2" });
    expect(r.status).toBe(200);
    expect(r.data.hook.name).toBe("Main intake v2");
  });

  test("DELETE is scoped to the active workspace", async () => {
    // mainHook lives in main; deleting with beta active must 404
    const wrong = await api("DELETE", `/api/hooks/${mainHook.id}`, undefined, betaId);
    expect(wrong.status).toBe(404);
    const right = await api("DELETE", `/api/hooks/${mainHook.id}`, undefined, mainId);
    expect(right.status).toBe(200);
    const list = await api("GET", "/api/hooks", undefined, mainId);
    expect(list.data.hooks.map((h: any) => h.id)).not.toContain(mainHook.id);
  });
});
