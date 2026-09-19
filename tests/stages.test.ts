// tests/stages.test.ts — per-workspace editable pipeline schema.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, seedStages, workspaceStages, slugifyStage } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- db-level
describe("stage schema migration", () => {
  test("legacy DB (no stages table) gets it created and seeded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-stages-mig-"));
    const db = new Database(join(dir, "t.db"), { create: true });
    db.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT DEFAULT '#579bfc', created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`INSERT INTO workspaces (name) VALUES ('Main'), ('Beta')`);
    db.close();
    const mdb = openDb(join(dir, "t.db"));
    for (const id of [1, 2]) {
      const stages = workspaceStages(mdb, id);
      expect(stages.map((s) => s.slug)).toEqual(
        ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"]);
      expect(stages.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(stages[0].name).toBe("Prospecting");
    }
    // idempotent: second open doesn't duplicate
    mdb.close();
    const mdb2 = openDb(join(dir, "t.db"));
    expect(workspaceStages(mdb2, 1)).toHaveLength(6);
    mdb2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("slugifyStage", () => {
    expect(slugifyStage("Discovery Call")).toBe("discovery_call");
    expect(slugifyStage("  Won! ")).toBe("won");
    expect(slugifyStage("!!!")).toBe("");
    expect(slugifyStage("A".repeat(100))).toHaveLength(40);
  });

  test("seedStages is idempotent and never clobbers custom schema", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-stages-seed-"));
    const db = openDb(join(dir, "t.db"));
    const mainId = (db.query("SELECT id FROM workspaces ORDER BY id LIMIT 1").get() as any).id;
    db.prepare("INSERT INTO stages (workspace_id, slug, name, position) VALUES (?, 'custom', 'Custom', 9)")
      .run(mainId);
    seedStages(db, mainId);
    expect(workspaceStages(db, mainId)).toHaveLength(7);
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- API
describe("stage CRUD API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3459";
  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };

  let mainId: number, betaId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-stages-live-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3459", CRM_UPLOADS: join(dir, "uploads") },
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

  test("workspaces seeded with default stages", async () => {
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    const r = await api("POST", "/api/workspaces", { name: "Beta" });
    betaId = r.data.workspace.id;
    for (const ws of [mainId, betaId]) {
      const s = await api("GET", "/api/stages", undefined, ws);
      expect(s.status).toBe(200);
      expect(s.data.stages.map((x: any) => x.slug)).toEqual(
        ["prospecting", "qualification", "proposal", "negotiation", "closed_won", "closed_lost"]);
      for (const st of s.data.stages) expect(typeof st.deals).toBe("number");
      if (ws === betaId) expect(s.data.stages[0].deals).toBe(0); // beta is empty; main holds seeded demo deals
    }
  });

  test("POST creates a stage, default appends", async () => {
    const r = await api("POST", "/api/stages", { name: "Discovery Call" }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.stage.slug).toBe("discovery_call");
    expect(r.data.stage.name).toBe("Discovery Call");
    const s = await api("GET", "/api/stages", undefined, mainId);
    expect(s.data.stages.map((x: any) => x.slug).at(-1)).toBe("discovery_call");
  });

  test("POST positions before/after, validates", async () => {
    const r = await api("POST", "/api/stages", { name: "First Touch", before: "prospecting" }, mainId);
    expect(r.status).toBe(201);
    let s = await api("GET", "/api/stages", undefined, mainId);
    expect(s.data.stages[0].slug).toBe("first_touch");
    const r2 = await api("POST", "/api/stages", { name: "Handoff", after: "negotiation" }, mainId);
    expect(r2.status).toBe(201);
    s = await api("GET", "/api/stages", undefined, mainId);
    const slugs = s.data.stages.map((x: any) => x.slug);
    expect(slugs.indexOf("handoff")).toBe(slugs.indexOf("negotiation") + 1);
    expect((await api("POST", "/api/stages", {}, mainId)).status).toBe(400);
    expect((await api("POST", "/api/stages", { name: "Discovery Call" }, mainId)).status).toBe(409);
    expect((await api("POST", "/api/stages", { name: "Nope", before: "ghost" }, mainId)).status).toBe(400);
  });

  test("stages are isolated per workspace", async () => {
    const s = await api("GET", "/api/stages", undefined, betaId);
    expect(s.data.stages.map((x: any) => x.slug)).not.toContain("discovery_call");
    expect(s.data.stages).toHaveLength(6);
  });

  test("PATCH renames (slug stable) and moves", async () => {
    const r = await api("PATCH", "/api/stages/discovery_call", { name: "Discovery" }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.stage.name).toBe("Discovery");
    expect(r.data.stage.slug).toBe("discovery_call");
    const m = await api("PATCH", "/api/stages/discovery_call", { before: "proposal" }, mainId);
    expect(m.status).toBe(200);
    const s = await api("GET", "/api/stages", undefined, mainId);
    const slugs = s.data.stages.map((x: any) => x.slug);
    expect(slugs.indexOf("discovery_call")).toBe(slugs.indexOf("proposal") - 1);
    // positions stay dense
    expect(s.data.stages.map((x: any) => x.position)).toEqual(slugs.map((_: any, i: number) => i));
    expect((await api("PATCH", "/api/stages/ghost", { name: "X" }, mainId)).status).toBe(404);
    expect((await api("PATCH", "/api/stages/discovery_call", { before: "ghost" }, mainId)).status).toBe(400);
  });

  test("DELETE with deals and no move_to is refused with a count", async () => {
    const d = await api("POST", "/api/deals", { title: "Doomed", stage: "discovery_call" }, mainId);
    expect(d.status).toBe(201);
    const del = await api("DELETE", "/api/stages/discovery_call", undefined, mainId);
    expect(del.status).toBe(409);
    expect(del.data.deals).toBe(1);
    expect(del.data.error).toMatch(/move_to/);
    // deal untouched
    const deals = await api("GET", "/api/deals", undefined, mainId);
    expect(deals.data.deals.find((x: any) => x.title === "Doomed").stage).toBe("discovery_call");
  });

  test("DELETE with move_to relocates deals", async () => {
    const del = await api("DELETE", "/api/stages/discovery_call?move_to=proposal", undefined, mainId);
    expect(del.status).toBe(200);
    expect(del.data.moved).toBe(1);
    const deals = await api("GET", "/api/deals", undefined, mainId);
    expect(deals.data.deals.find((x: any) => x.title === "Doomed").stage).toBe("proposal");
    const s = await api("GET", "/api/stages", undefined, mainId);
    expect(s.data.stages.map((x: any) => x.slug)).not.toContain("discovery_call");
    expect((await api("DELETE", "/api/stages/proposal?move_to=ghost", undefined, mainId)).status).toBe(400);
  });

  test("cannot delete the last stage", async () => {
    // shrink beta to one stage, then try to delete it
    let s = await api("GET", "/api/stages", undefined, betaId);
    for (const st of s.data.stages.slice(1)) {
      const r = await api("DELETE", `/api/stages/${st.slug}`, undefined, betaId);
      expect(r.status).toBe(200);
    }
    s = await api("GET", "/api/stages", undefined, betaId);
    expect(s.data.stages).toHaveLength(1);
    const last = await api("DELETE", `/api/stages/${s.data.stages[0].slug}`, undefined, betaId);
    expect(last.status).toBe(400);
  });

  test("GET /api/deals returns the DB-backed schema shape", async () => {
    const r = await api("GET", "/api/deals", undefined, mainId);
    expect(Array.isArray(r.data.stages)).toBe(true);
    expect(r.data.stages).toContain("first_touch");
    expect(r.data.labels["first_touch"]).toBe("First Touch");
    expect(r.data.stages).not.toContain("discovery_call");
  });

  test("deal stage validation follows the workspace schema", async () => {
    const bad = await api("POST", "/api/deals", { title: "Weird", stage: "nope" }, mainId);
    expect(bad.status).toBe(201);
    expect(bad.data.deal.stage).toBe("first_touch"); // falls back to first stage
    const p = await api("PATCH", `/api/deals/${bad.data.deal.id}`, { stage: "nope" }, mainId);
    expect(p.status).toBe(400);
  });

  test("meta-colors follows the workspace schema", async () => {
    const r = await api("GET", "/api/meta-colors", undefined, mainId);
    expect(r.data.colors["first_touch"]).toBeTruthy();
  });
});
