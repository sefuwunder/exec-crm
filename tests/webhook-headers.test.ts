// tests/webhook-headers.test.ts — custom headers on outgoing webhooks.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- migration
describe("headers column migration", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "crm-wh-mig-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("legacy webhooks table gains headers with '{}' default", () => {
    const path = join(dir, "legacy.db");
    const db = new Database(path, { create: true });
    db.exec(`
      CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        color TEXT DEFAULT '#579bfc', created_at TEXT DEFAULT (datetime('now')));
      CREATE TABLE webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
        url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '[]', active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')));
    `);
    db.prepare("INSERT INTO workspaces (name, color) VALUES ('Main', '#579bfc')").run();
    db.prepare("INSERT INTO webhooks (name, url, events) VALUES ('old', 'https://x.example', '[]')").run();
    db.close();
    const m = openDb(path);
    const cols = m.query("PRAGMA table_info(webhooks)").all() as any[];
    expect(cols.some((c) => c.name === "headers")).toBe(true);
    const row = m.query("SELECT headers FROM webhooks").get() as any;
    expect(row.headers).toBe("{}");
    m.close();
  });

  test("migration is idempotent on new DBs", () => {
    const path = join(dir, "fresh.db");
    const m = openDb(path);
    const cols = m.query("PRAGMA table_info(webhooks)").all() as any[];
    expect(cols.filter((c) => c.name === "headers").length).toBe(1);
    m.close();
    const m2 = openDb(path);
    m2.close();
  });
});

// ---------------------------------------------------------------- API + delivery
describe("custom headers API and delivery", () => {
  let dir: string;
  let proc: any;
  let stub: any;
  const BASE = "http://localhost:3461";
  const STUB = "http://localhost:3462";
  const SECRET = "milton-hook-secret-xyz";
  const seen: { headers: Record<string, string>; url: string }[] = [];

  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r), raw: r };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-wh-live-"));
    stub = Bun.serve({
      port: 3462,
      fetch: async (req) => {
        const headers: Record<string, string> = {};
        req.headers.forEach((v, k) => { headers[k] = v; });
        seen.push({ headers, url: req.url });
        return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
      },
    });
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
  });
  afterAll(async () => {
    proc?.kill();
    stub?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let mainId: number;
  let betaId: number;
  let whId: number;

  test("workspaces ready", async () => {
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    const r = await api("POST", "/api/workspaces", { name: "Beta", color: "#ff8a5c" });
    betaId = r.data.workspace.id;
  });

  test("create webhook with headers: names only on read, values stored", async () => {
    const r = await api("POST", "/api/webhooks", {
      name: "milton",
      url: `${STUB}/hook`,
      events: ["deal.stage_changed"],
      headers: { "X-Milton-Secret": SECRET, "X-Tenant": "acme" },
    }, mainId);
    expect(r.status).toBe(201);
    whId = r.data.webhook.id;
    expect(r.data.webhook.headers).toEqual(["X-Milton-Secret", "X-Tenant"]);
    expect(JSON.stringify(r.data).includes(SECRET)).toBe(false);
    const g = await api("GET", "/api/webhooks", undefined, mainId);
    const row = g.data.webhooks.find((w: any) => w.id === whId);
    expect(row.headers).toEqual(["X-Milton-Secret", "X-Tenant"]);
    expect(JSON.stringify(g.data).includes(SECRET)).toBe(false);
  });

  test("validation rejects bad input", async () => {
    const cases: [string, any][] = [
      ["bad name", { "Bad Name!": "x" }],
      ["blocked framing header", { "Content-Length": "5" }],
      ["blocked header lowercase", { "host": "evil" }],
      ["non-string value", { "X-A": 42 }],
      ["non-object", ["X-A"]],
      ["oversize value", { "X-A": "v".repeat(3000) }],
      ["too many", Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"]))],
    ];
    for (const [label, headers] of cases) {
      const r = await api("POST", "/api/webhooks", { name: "t", url: `${STUB}/x`, headers }, mainId);
      expect(r.status).toBe(400);
      expect(typeof r.data.error).toBe("string");
    }
    // the blocked-header error names the offender
    const r = await api("POST", "/api/webhooks", { name: "t", url: `${STUB}/x`, headers: { "Content-Length": "5" } }, mainId);
    expect(r.data.error).toContain("Content-Length");
  });

  test("test delivery carries custom headers; defaults intact", async () => {
    seen.length = 0;
    const r = await api("POST", `/api/webhooks/${whId}/test`, undefined, mainId);
    expect(r.status).toBe(200);
    expect(r.data.status).toBe("ok");
    expect(seen.length).toBe(1);
    const h = seen[0].headers;
    expect(h["x-milton-secret"]).toBe(SECRET);
    expect(h["x-tenant"]).toBe("acme");
    expect(h["content-type"]).toContain("application/json");
    expect(h["x-crm-event"]).toBe("test");
  });

  test("custom X-CRM-Event override wins over default", async () => {
    const r = await api("PATCH", `/api/webhooks/${whId}`, {
      headers: { "X-Milton-Secret": SECRET, "X-CRM-Event": "custom-evt" },
    }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.webhook.headers).toEqual(["X-Milton-Secret", "X-CRM-Event"]);
    seen.length = 0;
    await api("POST", `/api/webhooks/${whId}/test`, undefined, mainId);
    expect(seen[0].headers["x-crm-event"]).toBe("custom-evt");
    // and a lowercase variant still wins case-insensitively
    await api("PATCH", `/api/webhooks/${whId}`, {
      headers: { "X-Milton-Secret": SECRET, "x-crm-event": "lower-evt" },
    }, mainId);
    seen.length = 0;
    await api("POST", `/api/webhooks/${whId}/test`, undefined, mainId);
    const vals = Object.entries(seen[0].headers).filter(([k]) => k.toLowerCase() === "x-crm-event");
    expect(vals.length).toBe(1);
    expect(vals[0][1]).toBe("lower-evt");
  });

  test("real event delivery (deal.created) carries headers", async () => {
    const w = await api("POST", "/api/webhooks", {
      name: "deal watcher",
      url: `${STUB}/deals`,
      events: ["deal.created"],
      headers: { "X-Milton-Secret": SECRET, "X-Test-Run": "dealcreated" },
    }, mainId);
    expect(w.status).toBe(201);
    seen.length = 0;
    const r = await api("POST", "/api/deals", { title: "Header deal" }, mainId);
    expect(r.status).toBe(201);
    // fireWebhooks is intentionally fire-and-forget — poll for the delivery
    let hit: any;
    for (let i = 0; i < 40 && !hit; i++) {
      hit = seen.find((s) => s.headers["x-test-run"] === "dealcreated");
      if (!hit) await new Promise((res) => setTimeout(res, 100));
    }
    expect(hit).toBeTruthy();
    expect(hit!.headers["x-milton-secret"]).toBe(SECRET);
    expect(hit!.headers["x-crm-event"]).toBe("deal.created");
    expect(hit!.headers["content-type"]).toContain("application/json");
  });

  test("PATCH empty value keeps the stored secret; omitted key is removed", async () => {
    // set two headers
    await api("PATCH", `/api/webhooks/${whId}`, {
      headers: { "X-Milton-Secret": SECRET, "X-Tenant": "acme" },
    }, mainId);
    // blank value for the secret = keep; X-Tenant omitted = removed
    const r = await api("PATCH", `/api/webhooks/${whId}`, {
      headers: { "X-Milton-Secret": "" },
    }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.webhook.headers).toEqual(["X-Milton-Secret"]);
    seen.length = 0;
    await api("POST", `/api/webhooks/${whId}/test`, undefined, mainId);
    expect(seen[0].headers["x-milton-secret"]).toBe(SECRET);
    expect(seen[0].headers["x-tenant"]).toBeUndefined();
  });

  test("PATCH unknown id and cross-workspace id are 404", async () => {
    const a = await api("PATCH", "/api/webhooks/999999", { name: "x" }, mainId);
    expect(a.status).toBe(404);
    const b = await api("PATCH", `/api/webhooks/${whId}`, { name: "x" }, betaId);
    expect(b.status).toBe(404);
  });

  test("workspace scoping intact: webhooks isolated per workspace", async () => {
    const a = await api("GET", "/api/webhooks", undefined, betaId);
    expect(a.data.webhooks.map((w: any) => w.id)).not.toContain(whId);
    const b = await api("GET", "/api/webhooks", undefined, mainId);
    expect(b.data.webhooks.map((w: any) => w.id)).toContain(whId);
  });

  test("delivery log never contains secret values", async () => {
    const r = await api("GET", "/api/deliveries", undefined, mainId);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.data).includes(SECRET)).toBe(false);
    expect(r.data.deliveries.length).toBeGreaterThan(0);
  });

  test("webhook without headers still works (empty default)", async () => {
    const r = await api("POST", "/api/webhooks", { name: "plain", url: `${STUB}/p` }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.webhook.headers).toEqual([]);
    seen.length = 0;
    await api("POST", `/api/webhooks/${r.data.webhook.id}/test`, undefined, mainId);
    expect(seen[0].headers["x-crm-event"]).toBe("test");
    expect(seen[0].headers["content-type"]).toContain("application/json");
  });
});

// ---------------------------------------------------------------- UI (DOM-stubbed)
describe("headers editor UI", () => {
  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c as string] as string));

  let headerRowHtml: any, headersEditorHtml: any, bindHeadersEditor: any, collectHeaders: any;

  beforeAll(async () => {
    const src = await Bun.file(join(new URL(".", import.meta.url).pathname, "../public/app.js")).text();
    const start = src.indexOf("function headerRowHtml");
    const end = src.indexOf("/* ---------- custom schema fields");
    if (start < 0 || end < 0) throw new Error("header editor helpers not found in app.js");
    const fns = new Function("esc", src.slice(start, end) +
      "; return { headerRowHtml, headersEditorHtml, bindHeadersEditor, collectHeaders };");
    ({ headerRowHtml, headersEditorHtml, bindHeadersEditor, collectHeaders } = fns(esc));
  });

  // minimal fake DOM: rows container + add/delete/collect
  function fakeRoot(initialHtml: string) {
    const state: { rows: { name: string; valPh: string }[] } = { rows: [] };
    const parseRow = (inner: string) => {
      const nm = inner.match(/class="hdr-name"[^>]*value="([^"]*)"/);
      const vp = inner.match(/class="hdr-value"[^>]*placeholder="([^"]*)"/);
      return { name: nm ? nm[1] : "", valPh: vp ? vp[1] : "" };
    };
    const sync = () => {
      state.rows = [];
      const re = /<div class="hdr-row"[^>]*>([\s\S]*?)<\/div>/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(root.innerHTML))) state.rows.push(parseRow(m[1]));
    };
    const rowEls = () =>
      state.rows.map((_, i) => ({
        querySelector: (sel: string) => {
          if (sel === ".hdr-name")
            return { get value() { return state.rows[i].name; }, set value(v: string) { state.rows[i].name = v; } };
          if (sel === ".hdr-value") return { value: "" };
          return null;
        },
        remove: () => { state.rows.splice(i, 1); },
      }));
    let addFn: any = null;
    let clickFn: any = null;
    const root: any = {
      innerHTML: initialHtml,
      querySelector: (sel: string) => {
        if (sel === "#hdr-add") return { set onclick(f: any) { addFn = f; } };
        if (sel === "#hdr-rows")
          return {
            insertAdjacentHTML: (_pos: string, html: string) => {
              const m = html.match(/<div class="hdr-row"[^>]*>([\s\S]*?)<\/div>/);
              if (m) state.rows.push(parseRow(m[1]));
            },
            addEventListener: (_ev: string, fn: any) => { clickFn = fn; },
          };
        return null;
      },
      querySelectorAll: (sel: string) => (sel === ".hdr-row" ? rowEls() : []),
    };
    sync();
    return {
      root,
      rowCount: () => state.rows.length,
      clickAdd: () => addFn && addFn(),
      // simulate the delegated delete click on row i
      clickDelete: (i: number) => {
        const rowEl = rowEls()[i];
        const btnFake = { closest: (s: string) => (s === ".hdr-row" ? rowEl : null) };
        clickFn({ target: { closest: (s: string) => (s === "[data-hdr-del]" ? btnFake : null) } });
      },
      setName: (i: number, v: string) => { state.rows[i].name = v; },
    };
  }

  test("empty editor prefills exactly one blank row + add button", () => {
    const html = headersEditorHtml([]);
    const rowCount = (html.match(/class="hdr-row"/g) || []).length;
    expect(rowCount).toBe(1);
    expect(html).toContain('id="hdr-add"');
    expect(html).toContain("Custom headers");
    expect(html).not.toContain("••••••");
  });

  test("existing header names prefill with masked placeholder", () => {
    const html = headersEditorHtml(["X-Milton-Secret"]);
    const rowCount = (html.match(/class="hdr-row"/g) || []).length;
    expect(rowCount).toBe(2); // one prefilled + one blank
    expect(html).toContain('value="X-Milton-Secret"');
    expect(html).toContain("•••••• (unchanged — type to replace)");
  });

  test("add appends a row; delete removes the right row", () => {
    const ed = fakeRoot(headersEditorHtml([]));
    bindHeadersEditor(ed.root);
    expect(ed.rowCount()).toBe(1);
    ed.clickAdd();
    ed.clickAdd();
    expect(ed.rowCount()).toBe(3);
    ed.setName(0, "X-A");
    ed.setName(1, "X-B");
    ed.setName(2, "X-C");
    ed.clickDelete(1);
    expect(ed.rowCount()).toBe(2);
    const got = collectHeaders(ed.root);
    expect(got).toEqual({ "X-A": "", "X-C": "" });
  });

  test("collectHeaders skips blank names and trims", () => {
    const ed = fakeRoot(headersEditorHtml(["X-Keep"]));
    bindHeadersEditor(ed.root);
    ed.setName(0, "X-Keep");
    ed.setName(1, "   "); // blank row stays blank
    const got = collectHeaders(ed.root);
    expect(got).toEqual({ "X-Keep": "" });
  });

  test("header names are HTML-escaped in the editor", () => {
    const html = headerRowHtml('"><script>alert(1)</script>', true);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
