// tests/workspaces.test.ts — workspace isolation + migration backfill.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, ensureMainWorkspace } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- migration
// Simulates a legacy (pre-workspaces) DB: old schema without workspace_id,
// then runs openDb and asserts the backfill.
function makeLegacyDb(path: string) {
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      industry TEXT DEFAULT '', website TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER,
      name TEXT NOT NULL, title TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE deals (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      company_id INTEGER, contact_id INTEGER, value REAL DEFAULT 0, stage TEXT DEFAULT 'prospecting',
      probability INTEGER DEFAULT 10, expected_close TEXT DEFAULT '', owner TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, deal_id INTEGER,
      due_date TEXT DEFAULT '', done INTEGER DEFAULT 0, owner TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE activities (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
      text TEXT NOT NULL, ref_type TEXT DEFAULT '', ref_id INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      status TEXT DEFAULT 'draft', start_date TEXT DEFAULT '', end_date TEXT DEFAULT '',
      budget REAL DEFAULT 0, notes TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE captures (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL,
      original_name TEXT DEFAULT '', mime TEXT DEFAULT '', size INTEGER DEFAULT 0, note TEXT DEFAULT '',
      contact_id INTEGER, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE custom_fields (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL,
      name TEXT NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', options TEXT DEFAULT '[]',
      required INTEGER DEFAULT 0, position INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(entity, name));
    CREATE TABLE custom_values (id INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL,
      record_id INTEGER NOT NULL, field_id INTEGER NOT NULL, value TEXT DEFAULT '',
      UNIQUE(entity, record_id, field_id));
    CREATE TABLE webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]', active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE webhook_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, webhook_id INTEGER,
      event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, response_code INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE incoming_hooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      key TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO companies (name) VALUES ('Legacy Co')").run();
  db.prepare("INSERT INTO deals (title, value, stage) VALUES ('Legacy Deal', 1000, 'proposal')").run();
  db.prepare("INSERT INTO custom_fields (entity, name, label) VALUES ('contact', 'tier', 'Tier')").run();
  db.close();
}

describe("workspace migration", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "crm-ws-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("legacy rows are backfilled into a seeded Main workspace", () => {
    const path = join(dir, "legacy.db");
    makeLegacyDb(path);
    const db = openDb(path);
    const spaces = db.query("SELECT * FROM workspaces ORDER BY id").all() as any[];
    expect(spaces.length).toBe(1);
    expect(spaces[0].name).toBe("Main");
    const mainId = spaces[0].id;
    for (const t of ["companies", "deals", "custom_fields"]) {
      const rows = db.query(`SELECT workspace_id FROM ${t}`).all() as any[];
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.workspace_id).toBe(mainId);
    }
    // custom_fields rebuilt: names unique per workspace, not globally
    db.prepare("INSERT INTO workspaces (name, color) VALUES ('Beta', '#ff0000')").run();
    const beta = (db.query("SELECT id FROM workspaces WHERE name = 'Beta'").get() as any).id;
    const r = db
      .prepare("INSERT INTO custom_fields (entity, name, label, workspace_id) VALUES ('contact', 'tier', 'Tier', ?)")
      .run(beta);
    expect(Number(r.lastInsertRowid)).toBeGreaterThan(0);
    db.close();
  });

  test("ensureMainWorkspace is idempotent", () => {
    const path = join(dir, "idem.db");
    const db = openDb(path);
    const a = ensureMainWorkspace(db);
    const b = ensureMainWorkspace(db);
    expect(a).toBe(b);
    expect((db.query("SELECT COUNT(*) n FROM workspaces").get() as any).n).toBe(1);
    db.close();
  });
});

// ---------------------------------------------------------------- live server
describe("workspace API isolation", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3457";
  const j = (r: Response) => r.json();

  const api = async (method: string, p: string, body?: any, ws?: number | string, header = false) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined && !header) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    if (ws !== undefined && header) headers["X-Workspace"] = String(ws);
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-ws-live-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3457", CRM_UPLOADS: join(dir, "uploads") },
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

  test("a Main workspace is seeded", async () => {
    const { status, data } = await api("GET", "/api/workspaces");
    expect(status).toBe(200);
    expect(data.workspaces.length).toBe(1);
    expect(data.workspaces[0].name).toBe("Main");
    mainId = data.workspaces[0].id;
  });

  test("create + rename a workspace", async () => {
    let r = await api("POST", "/api/workspaces", { name: "Beta", color: "#ff8a5c" });
    expect(r.status).toBe(201);
    betaId = r.data.workspace.id;
    expect(r.data.workspace.color).toBe("#ff8a5c");
    r = await api("PATCH", `/api/workspaces/${betaId}`, { name: "Beta Team" });
    expect(r.status).toBe(200);
    expect(r.data.workspace.name).toBe("Beta Team");
  });

  test("deals are isolated per workspace", async () => {
    await api("POST", "/api/deals", { title: "Main Deal", value: 1000 }, mainId);
    await api("POST", "/api/deals", { title: "Beta Deal", value: 2000 }, betaId);
    const a = await api("GET", "/api/deals", undefined, mainId);
    const b = await api("GET", "/api/deals", undefined, betaId);
    const aTitles = a.data.deals.map((d: any) => d.title);
    expect(aTitles).toContain("Main Deal"); // plus seeded demo deals
    expect(aTitles).not.toContain("Beta Deal");
    expect(b.data.deals.map((d: any) => d.title)).toEqual(["Beta Deal"]);
    expect(b.data.deals[0].workspace_id).toBe(betaId);
  });

  test("KPIs are scoped per workspace", async () => {
    const a = await api("GET", "/api/kpis", undefined, mainId);
    const b = await api("GET", "/api/kpis", undefined, betaId);
    expect(a.data.open_deals).toBeGreaterThanOrEqual(1); // seeded demo deals + ours
    expect(a.data.pipeline_value).toBeGreaterThanOrEqual(1000);
    expect(b.data.open_deals).toBe(1); // beta has no seed data
    expect(b.data.pipeline_value).toBe(2000);
  });

  test("X-Workspace header selects the workspace", async () => {
    const r = await api("GET", "/api/deals", undefined, betaId, true);
    expect(r.data.deals.map((d: any) => d.title)).toEqual(["Beta Deal"]);
  });

  test("query param beats header", async () => {
    const headers = { "Content-Type": "application/json", "X-Workspace": String(mainId) };
    const r = await fetch(`${BASE}/api/deals?workspace=${betaId}`, { headers });
    const data = await r.json();
    expect(data.deals.map((d: any) => d.title)).toEqual(["Beta Deal"]);
  });

  test("default (no selector) is the first workspace", async () => {
    const r = await api("GET", "/api/deals");
    expect(r.data.deals.map((d: any) => d.title)).toContain("Main Deal");
  });

  test("unknown workspace id is a 400", async () => {
    const r = await api("GET", "/api/deals", undefined, 99999);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/unknown workspace/);
  });

  test("records can't leak across workspaces via id", async () => {
    const betaDeal = (await api("GET", "/api/deals", undefined, betaId)).data.deals[0];
    const r = await api("PATCH", `/api/deals/${betaDeal.id}`, { title: "Hijacked" }, mainId);
    expect(r.status).toBe(404);
    const del = await api("DELETE", `/api/deals/${betaDeal.id}`, undefined, mainId);
    expect(del.status).toBe(404);
    const still = await api("GET", "/api/deals", undefined, betaId);
    expect(still.data.deals[0].title).toBe("Beta Deal");
  });

  test("contacts + companies + tasks are scoped too", async () => {
    await api("POST", "/api/companies", { name: "Beta Corp" }, betaId);
    await api("POST", "/api/contacts", { name: "Beta Person" }, betaId);
    await api("POST", "/api/tasks", { title: "Beta Task" }, betaId);
    const cos = await api("GET", "/api/companies", undefined, mainId);
    expect(cos.data.companies.map((c: any) => c.name)).not.toContain("Beta Corp");
    const cts = await api("GET", "/api/contacts", undefined, mainId);
    expect(cts.data.contacts.map((c: any) => c.name)).not.toContain("Beta Person");
    const ts = await api("GET", "/api/tasks", undefined, mainId);
    expect(ts.data.tasks.map((t: any) => t.title)).not.toContain("Beta Task");
  });

  test("custom fields are per-workspace", async () => {
    const a = await api("POST", "/api/schema/contact", { label: "Tier" }, mainId);
    expect(a.status).toBe(201);
    const b = await api("POST", "/api/schema/contact", { label: "Tier" }, betaId);
    expect(b.status).toBe(201); // same name allowed in another workspace
    const list = await api("GET", "/api/schema/contact", undefined, betaId);
    expect(list.data.fields.map((f: any) => f.label)).toEqual(["Tier"]);
  });

  test("delete guard: non-empty workspace needs typed confirmation", async () => {
    const r = await api("DELETE", `/api/workspaces/${betaId}`, {});
    expect(r.status).toBe(409);
    expect(r.data.counts.deals).toBeGreaterThan(0);
    const still = await api("GET", "/api/workspaces");
    expect(still.data.workspaces.length).toBe(2);
  });

  test("delete with typed confirmation cascades", async () => {
    const r = await api("DELETE", `/api/workspaces/${betaId}`, { confirm: "Beta Team" });
    expect(r.status).toBe(200);
    expect(r.data.deleted_records).toBeGreaterThan(0);
    const list = await api("GET", "/api/workspaces");
    expect(list.data.workspaces.length).toBe(1);
    const deals = await api("GET", "/api/deals", undefined, mainId);
    expect(deals.data.deals.map((d: any) => d.title)).toContain("Main Deal");
  });

  test("cannot delete the last workspace", async () => {
    const r = await api("DELETE", `/api/workspaces/${mainId}`, { confirm: "Main" });
    expect(r.status).toBe(400);
  });
});
