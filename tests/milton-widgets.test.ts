// tests/milton-widgets.test.ts — /api/milton/widgets CRUD, validation, isolation, cap.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("milton widgets API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3469";
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

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-mw-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3469", CRM_UPLOADS: join(dir, "uploads") },
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
    betaWs = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
  });

  afterAll(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("GET starts empty", async () => {
    const { status, data } = await api("GET", "/api/milton/widgets", undefined, mainWs);
    expect(status).toBe(200);
    expect(data.widgets).toEqual([]);
  });

  test("POST stat → 201 with the created row", async () => {
    const { status, data } = await api("POST", "/api/milton/widgets", {
      kind: "stat", title: "Pipeline value", payload: { value: "$190k", label: "Pipeline", delta: "+12% MoM" }, source: "milton:kpis",
    }, mainWs);
    expect(status).toBe(201);
    expect(data.widget).toMatchObject({ kind: "stat", title: "Pipeline value", source: "milton:kpis" });
    expect(data.widget.payload).toEqual({ value: "$190k", label: "Pipeline", delta: "+12% MoM" });
    expect(typeof data.widget.created_at).toBe("number");
    expect(typeof data.widget.id).toBe("number");
  });

  test("POST table, bars, list → 201", async () => {
    const table = await api("POST", "/api/milton/widgets", {
      kind: "table", title: "Top deals",
      payload: { headers: ["Deal", "Stage", "Value"], rows: [["Acme", "Proposal", "$50k"]] },
    }, mainWs);
    expect(table.status).toBe(201);
    const bars = await api("POST", "/api/milton/widgets", {
      kind: "bars", title: "Campaigns", payload: { items: [{ label: "Q4", value: 50000 }], format: "currency" },
    }, mainWs);
    expect(bars.status).toBe(201);
    const list = await api("POST", "/api/milton/widgets", {
      kind: "list", title: "Closing soon", payload: { items: [{ text: "Acme", sub: "closes 2026-10-01" }] },
    }, mainWs);
    expect(list.status).toBe(201);
  });

  test("GET returns newest first", async () => {
    const { data } = await api("GET", "/api/milton/widgets", undefined, mainWs);
    const titles = data.widgets.map((w: any) => w.title);
    expect(titles[0]).toBe("Closing soon");
    expect(titles[titles.length - 1]).toBe("Pipeline value");
  });

  test("validation: bad kind → 400", async () => {
    const { status, data } = await api("POST", "/api/milton/widgets",
      { kind: "pie", title: "X", payload: {} }, mainWs);
    expect(status).toBe(400);
    expect(data.error).toMatch(/kind must be one of/);
  });

  test("validation: title empty / too long → 400", async () => {
    const e1 = await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "  ", payload: { value: "1", label: "L" } }, mainWs);
    expect(e1.status).toBe(400);
    const e2 = await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "x".repeat(81), payload: { value: "1", label: "L" } }, mainWs);
    expect(e2.status).toBe(400);
  });

  test("validation: per-kind payload rejections", async () => {
    const cases: [any, string][] = [
      [{ kind: "stat", title: "S", payload: { value: "1" } }, /label/],
      [{ kind: "stat", title: "S", payload: { value: "1", label: "L", delta: 5 } }, /delta/],
      [{ kind: "table", title: "T", payload: { headers: [], rows: [] } }, /headers/],
      [{ kind: "table", title: "T", payload: { headers: ["A", "B"], rows: [["only-one"]] } }, /matching/],
      [{ kind: "table", title: "T", payload: { headers: ["A"], rows: Array.from({ length: 13 }, () => ["x"]) } }, /max 12/],
      [{ kind: "bars", title: "B", payload: { items: [] } }, /items/],
      [{ kind: "bars", title: "B", payload: { items: [{ label: "a", value: "big" }] } }, /value/],
      [{ kind: "bars", title: "B", payload: { items: [{ label: "a", value: 1 }], format: "emojis" } }, /format/],
      [{ kind: "list", title: "L", payload: { items: [] } }, /items/],
      [{ kind: "list", title: "L", payload: { items: [{ text: "" }] } }, /text/],
      [{ kind: "list", title: "L", payload: { items: Array.from({ length: 16 }, () => ({ text: "x" })) } }, /1\.\.15/],
      [{ kind: "list", title: "L", payload: "nope" }, /object/],
    ];
    for (const [body, re] of cases) {
      const { status, data } = await api("POST", "/api/milton/widgets", body, mainWs);
      expect(status).toBe(400);
      expect(data.error).toMatch(re);
    }
  });

  test("unknown workspace → 400", async () => {
    const { status } = await api("GET", "/api/milton/widgets", undefined, 999999);
    expect(status).toBe(400);
    const p = await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "S", payload: { value: "1", label: "L" } }, 999999);
    expect(p.status).toBe(400);
  });

  test("workspace isolation", async () => {
    const { data: created } = await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "Beta only", payload: { value: "1", label: "L" } }, betaWs);
    const id = created.widget.id;
    // invisible from the other workspace
    const { data: mainList } = await api("GET", "/api/milton/widgets", undefined, mainWs);
    expect(mainList.widgets.every((w: any) => w.id !== id)).toBe(true);
    const { data: betaList } = await api("GET", "/api/milton/widgets", undefined, betaWs);
    expect(betaList.widgets.some((w: any) => w.id === id)).toBe(true);
    // cannot delete another workspace's widget
    const cross = await api("DELETE", `/api/milton/widgets/${id}`, undefined, mainWs);
    expect(cross.status).toBe(404);
  });

  test("DELETE removes own widget, 404 after", async () => {
    const { data: created } = await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "Temp", payload: { value: "1", label: "L" } }, mainWs);
    const id = created.widget.id;
    expect((await api("DELETE", `/api/milton/widgets/${id}`, undefined, mainWs)).status).toBe(200);
    expect((await api("DELETE", `/api/milton/widgets/${id}`, undefined, mainWs)).status).toBe(404);
  });

  test("50-widget cap: oldest evicted", async () => {
    const seedDb = new Database(join(dir, "test.db"));
    seedDb.exec(`DELETE FROM milton_widgets WHERE workspace_id = ${betaWs};`);
    seedDb.close();
    for (let i = 1; i <= 55; i++) {
      const { status } = await api("POST", "/api/milton/widgets",
        { kind: "stat", title: `w${i}`, payload: { value: String(i), label: "L" } }, betaWs);
      expect(status).toBe(201);
    }
    const { data } = await api("GET", "/api/milton/widgets", undefined, betaWs);
    expect(data.widgets).toHaveLength(50);
    const titles = data.widgets.map((w: any) => w.title);
    expect(titles).toContain("w55");
    expect(titles).not.toContain("w1");
    expect(titles).not.toContain("w5");
    expect(titles).toContain("w6");
  });
});
