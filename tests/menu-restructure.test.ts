// tests/menu-restructure.test.ts — menu restructure:
// Dashboard = KPIs + Milton widgets (defaults + pinned) + global calendar,
// Daily Feed = Milton-suggestion feed, Data Workshop = captures/schema/automation tabs.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";
import { Database } from "bun:sqlite";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
const indexSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");

// ---- function extractor (same brace-counting approach as the other UI suites)
function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index + m[0].length - 1, pdepth = 0;
  let str: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "(") pdepth++;
    else if (ch === ")") { if (--pdepth === 0) break; }
  }
  let depth = 0;
  str = null;
  const tplStack: number[] = [];
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (str === "`" && ch === "$" && nx === "{") { tplStack.push(depth + 1); str = null; depth++; i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "/" && nx === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") { i += 2; while (!(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1] - 1) { tplStack.pop(); str = "`"; continue; }
      if (depth === 0 && !tplStack.length) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

describe("menu structure", () => {
  test("TITLES has the workshop, drops captures/automations/schema", () => {
    expect(appSrc).toContain('workshop: "Data Workshop"');
    expect(appSrc).not.toMatch(/^\s*(captures|automations|schema):/m);
  });
  test("legacy routes redirect into the workshop tabs", () => {
    expect(appSrc).toContain('const LEGACY_ROUTES = { captures: "captures", automations: "automation", schema: "schema" }');
    expect(appSrc).toContain("location.hash = `#/workshop/${LEGACY_ROUTES[r]}`");
  });
  test("router dispatches the workshop, not the old views", () => {
    expect(appSrc).toContain("workshop: () => vWorkshop(parts[1])");
    expect(appSrc).not.toContain("captures: vCaptures");
    expect(appSrc).not.toContain("automations: vAutomations");
    expect(appSrc).not.toContain("schema: vSchema");
  });
  test("sidebar has Data Workshop, no captures/schema/automations entries", () => {
    const nav = indexSrc.match(/<nav class="nav" id="nav">[\s\S]*?<\/nav>/)![0];
    expect(nav).toContain('data-r="workshop"');
    expect(nav).toContain("Data Workshop");
    for (const r of ["captures", "schema", "automations"]) {
      expect(nav).not.toContain(`data-r="${r}"`);
    }
  });
  test("vWorkshop renders the three tabs and dispatches each panel", () => {
    expect(appSrc).toContain('["captures", "Captures"]');
    expect(appSrc).toContain('["schema", "Schema"]');
    expect(appSrc).toContain('["automation", "Automation"]');
    expect(appSrc).toContain("await vCaptures(root)");
    expect(appSrc).toContain("await vSchema(root)");
    expect(appSrc).toContain("await vAutomations(root)");
  });
});

describe("data workshop (DOM-stubbed)", () => {
  const load = (scope: any, name: string) => {
    const fn = new Function(...Object.keys(scope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(scope));
    scope[name] = fn;
    return fn;
  };
  test("tab shell renders three tabs; clicking switches the hash", async () => {
    let html = "";
    const clicks: any[] = [];
    let mounted: string | null = null;
    const scope: any = {
      view: { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } },
      WORKSHOP_TABS: [["captures", "Captures"], ["schema", "Schema"], ["automation", "Automation"]],
      vCaptures: async (root: any) => { mounted = "captures"; },
      vSchema: async (root: any) => { mounted = "schema"; },
      vAutomations: async (root: any) => { mounted = "automation"; },
      $: () => ({ set mounted(v: string | null) { mounted = v; }, get mounted() { return mounted; } }),
      document: {
        querySelectorAll: (sel: string) => {
          if (sel === "#ws-seg button") {
            return [0, 1, 2].map((i) => ({
              dataset: { tab: ["captures", "schema", "automation"][i] },
              set onclick(f: any) { clicks.push(f); },
            }));
          }
          return [];
        },
      },
      location: { hash: "" },
    };
    const vWorkshop = load(scope, "vWorkshop");
    await vWorkshop("schema");
    expect(html).toContain('data-tab="captures"');
    expect(html).toContain('data-tab="schema"');
    expect(html).toContain('data-tab="automation"');
    expect(html).toContain('id="ws-body"');
    expect(mounted).toBe("schema");
    expect(clicks).toHaveLength(3);
    clicks[0]();
    expect(scope.location.hash).toBe("#/workshop/captures");
  });

  test("unknown sub-tab falls back to captures", async () => {
    let mounted: string | null = null;
    const scope: any = {
      view: { innerHTML: "" },
      WORKSHOP_TABS: [["captures", "Captures"], ["schema", "Schema"], ["automation", "Automation"]],
      vCaptures: async () => { mounted = "captures"; },
      vSchema: async () => { mounted = "schema"; },
      vAutomations: async () => { mounted = "automation"; },
      document: { querySelectorAll: () => [] },
      $: () => ({}),
      location: { hash: "" },
    };
    const vWorkshop = load(scope, "vWorkshop");
    await vWorkshop("nonsense");
    expect(mounted).toBe("captures");
  });
});

describe("dashboard widgets (DOM-stubbed)", () => {
  const esc = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const moneyShort = (n: any) => {
    n = Number(n) || 0;
    if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
    if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
    return "$" + Math.round(n);
  };
  const mwRelTime = () => "just now";
  const scope: any = { esc, moneyShort, mwRelTime };
  const load = (name: string) => {
    const fn = new Function(...Object.keys(scope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(scope));
    scope[name] = fn;
    return fn;
  };
  test("mwCardHtml: defaults render without a delete button, pinned keep it", () => {
    const mwCardHtml = load("mwCardHtml");
    const w = { id: 5, kind: "stat", title: "T", created_at: Date.now(), payload: { value: "1", label: "l" } };
    expect(mwCardHtml(w)).toContain("data-mw-del");
    const noDel = mwCardHtml(w, { deletable: false });
    expect(noDel).not.toContain("data-mw-del");
    expect(noDel).toContain("mw-card");
  });
  test("loadDashboardWidgets: pinned + suggested groups, defaults not deletable", async () => {
    const mwCardHtml = load("mwCardHtml");
    let html = "";
    const s: any = {
      ...scope,
      $: (sel: string) => (sel === "#dash-widgets"
        ? { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, querySelectorAll: () => [] }
        : null),
      GET: async (p: string) => p === "/api/milton/widgets"
        ? { widgets: [{ id: 7, kind: "stat", title: "Pinned one", created_at: Date.now(), payload: { value: "x", label: "y" } }] }
        : { widgets: [{ kind: "bars", title: "Forecast by stage", created_at: Date.now(), payload: { format: "currency", items: [] } }] },
    };
    const fn = new Function(...Object.keys(s), `${extractFn(appSrc, "loadDashboardWidgets")}; return loadDashboardWidgets;`)(...Object.values(s));
    await fn();
    expect(html).toContain("Pinned");
    expect(html).toContain("Suggested");
    expect(html).toContain("Pinned one");
    expect(html).toContain("Forecast by stage");
    expect(html).toContain('data-mw-del="7"');
    // the suggested widget must not carry a delete button
    const suggested = html.slice(html.indexOf("Suggested"));
    expect(suggested).not.toContain("data-mw-del");
  });
  test("loadDashboardWidgets: API failure degrades to an empty state", async () => {
    let html = "";
    const s: any = {
      ...scope,
      $: () => ({ set innerHTML(v: string) { html = v; }, get innerHTML() { return html; }, querySelectorAll: () => [] }),
      GET: async () => { throw new Error("down"); },
    };
    const fn = new Function(...Object.keys(s), `${extractFn(appSrc, "loadDashboardWidgets")}; return loadDashboardWidgets;`)(...Object.values(s));
    await fn();
    expect(html).toContain("Couldn't load widgets");
  });
});

describe("daily feed (DOM-stubbed)", () => {
  const esc = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const money = (n: any) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
  const toISODate = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const stageFunnelColor = () => "var(--phase-early)";
  const taskRow = (t: any) => `<div class="task"><input type="checkbox" data-id="${t.id}"><span>${esc(t.title)}</span></div>`;
  const feed = {
    milton: { available: true, take: "**2 open deals** worth **$50k**.\nDue today: Call Acme" },
    sections: [
      { id: "plan", title: "Today's plan", items: [{ kind: "task", task: { id: 1, title: "Call Acme", done: false, due_date: "2026-09-20", owner: "You" } }] },
      { id: "prep", title: "Meeting prep", items: [{ kind: "prep", name: "Dana", sub: "CEO", reason: "Acme deal — closes 2026-09-25" }] },
      { id: "hygiene", title: "Hygiene nudges", items: [{ kind: "deal", note: "untouched 45 days", deal: { id: 3, title: "Stale deal", value: 1000, stage: "proposal", stage_name: "Proposal", expected_close: "", company_name: "Acme" } }] },
      { id: "blocked", title: "Blocked tasks", items: [{ kind: "task", blocked_by: [{ id: 9, title: "First step" }], task: { id: 2, title: "Blocked thing", done: false, owner: "You" } }] },
    ],
  };
  const runFeed = async (feedPayload: any) => {
    let html = "";
    const handlers: Record<string, any> = {};
    const s: any = {
      esc, money, toISODate, stageFunnelColor, taskRow,
      view: { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } },
      GET: async (p: string) => p === "/api/daily-feed" ? feedPayload : { deals: [] },
      POST: async () => ({}),
      wireTaskRows: () => {},
      editDealModal: () => {},
      route: () => {},
      $: (sel: string) => sel === "#qa-title"
        ? { value: "", addEventListener: () => {} }
        : ({ onclick: null, addEventListener: () => {} } as any),
      document: { querySelectorAll: () => [] },
      location: { hash: "" },
    };
    const fn = new Function(...Object.keys(s), `${extractFn(appSrc, "vFeed")}; return vFeed;`)(...Object.values(s));
    await fn();
    return html;
  };
  test("feed renders Milton take + all four sections with items", async () => {
    const html = await runFeed(feed);
    expect(html).toContain("Milton's take");
    expect(html).toContain("<b>2 open deals</b>");
    expect(html).toContain("Today&#39;s plan");
    expect(html).toContain("Meeting prep");
    expect(html).toContain("Hygiene nudges");
    expect(html).toContain("Blocked tasks");
    expect(html).toContain("Call Acme");
    expect(html).toContain("Stale deal");
    expect(html).toContain("untouched 45 days");
    expect(html).toContain("blocked by First step");
    expect(html).toContain("Dana");
  });
  test("Milton down: feed degrades to a plain unavailable note", async () => {
    const html = await runFeed({ ...feed, milton: { available: false, take: null } });
    expect(html).toContain("Milton is unreachable");
    expect(html).toContain("Today&#39;s plan");
    expect(html).toContain("Call Acme");
  });
  test("feedSection helper finds sections by id", () => {
    const s: any = { esc };
    const fn = new Function(...Object.keys(s), `${extractFn(appSrc, "feedSection")}; return feedSection;`)(...Object.values(s));
    expect(fn(feed, "prep").title).toBe("Meeting prep");
    expect(fn(feed, "missing").items).toEqual([]);
  });
});

describe("calendar campaign items", () => {
  const esc = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const money = (n: any) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
  const stageFunnelColor = () => "var(--phase-early)";
  const scope: any = { esc, money, stageFunnelColor };
  const load = (name: string) => {
    const fn = new Function(...Object.keys(scope), `${extractFn(appSrc, name)}; return ${name};`)(...Object.values(scope));
    scope[name] = fn;
    return fn;
  };
  test("calDayRowHtml renders campaign start/end rows", () => {
    const calDayRowHtml = load("calDayRowHtml");
    const row = calDayRowHtml({ type: "campaign", id: 1, title: "Q4 Push", date: "2026-10-01", edge: "starts", status: "scheduled", company_name: "Acme" }, "2026-09-20");
    expect(row).toContain("Q4 Push");
    expect(row).toContain("campaign starts");
    expect(row).toContain("Acme");
    expect(row).toContain('data-cal-item="campaign:1"');
    const end = calDayRowHtml({ type: "campaign", id: 1, title: "Q4 Push", date: "2026-12-01", edge: "ends", status: "sent" }, "2026-09-20");
    expect(end).toContain("campaign ends");
    expect(end).not.toContain("is-overdue");
  });
});

// ---------------------------------------------------------------- live API
describe("menu restructure API", () => {
  let dir: string;
  let proc: any;
  let db: Database;
  const BASE = "http://localhost:3473";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let wsId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-menu-"));
    const dbPath = join(dir, "test.db");
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: dbPath, PORT: "3473", CRM_UPLOADS: join(dir, "uploads"), MILTON_URL: "http://localhost:9" },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    wsId = (await api("GET", "/api/workspaces")).data.workspaces[0].id;
    db = new Database(dbPath);
  });
  afterAll(async () => { proc?.kill(); db?.close(); await rm(dir, { recursive: true, force: true }); });

  test("dashboard/widgets: default set renders with no pins", async () => {
    await api("POST", "/api/deals", { title: "Menu deal", value: 50000, stage: "proposal", probability: 50 }, wsId);
    const { status, data } = await api("GET", "/api/dashboard/widgets", undefined, wsId);
    expect(status).toBe(200);
    const titles = data.widgets.map((w: any) => w.title);
    expect(titles).toContain("Forecast by stage");
    expect(titles).toContain("Pipeline analysis");
    expect(titles).toContain("Hygiene summary");
    expect(titles).toContain("Top deals");
    expect(titles).toContain("Weighted forecast");
    for (const w of data.widgets) {
      expect(["stat", "table", "bars", "list"]).toContain(w.kind);
      expect(w.payload).toBeTruthy();
    }
    const forecast = data.widgets.find((w: any) => w.title === "Forecast by stage");
    expect(forecast.payload.items.length).toBeGreaterThan(0);
    expect(forecast.payload.format).toBe("currency");
    const top = data.widgets.find((w: any) => w.title === "Top deals");
    expect(top.payload.headers).toEqual(["Deal", "Company", "Stage", "Value"]);
  });

  test("dashboard/widgets: pinned widgets come first and keep their ids", async () => {
    const pinned = (await api("POST", "/api/milton/widgets",
      { kind: "stat", title: "Pinned test stat", payload: { value: "1", label: "l" } }, wsId)).data.widget;
    const { data } = await api("GET", "/api/dashboard/widgets", undefined, wsId);
    expect(data.widgets[0].id).toBe(pinned.id);
    expect(data.widgets[0].title).toBe("Pinned test stat");
    expect(data.widgets.slice(1).every((w: any) => w.id == null)).toBe(true);
  });

  test("calendar global scope merges campaign start/end items", async () => {
    const co = (await api("POST", "/api/companies", { name: "Menu Co" }, wsId)).data.company;
    const c = (await api("POST", "/api/campaigns", { name: "Menu campaign", company_id: co.id, start_date: "2026-10-05", end_date: "2026-10-20" }, wsId)).data.campaign;
    const { data } = await api("GET", "/api/calendar?scope=global&from=2026-10-01&to=2026-10-31", undefined, wsId);
    const camps = data.items.filter((i: any) => i.type === "campaign" && i.id === c.id);
    expect(camps.map((i: any) => i.edge).sort()).toEqual(["ends", "starts"]);
    expect(camps[0].date).toMatch(/^2026-10-/);
  });

  test("daily-feed: sections render, Milton down degrades gracefully", async () => {
    const today = new Date();
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const todayS = iso(today);
    const yday = iso(new Date(today.getTime() - 86400000));
    const t1 = (await api("POST", "/api/tasks", { title: "Feed task today", due_date: todayS }, wsId)).data.task;
    await api("POST", "/api/tasks", { title: "Feed task overdue", due_date: yday }, wsId);
    const pred = (await api("POST", "/api/tasks", { title: "Feed predecessor" }, wsId)).data.task;
    const blocked = (await api("POST", "/api/tasks", { title: "Feed blocked task", due_date: todayS }, wsId)).data.task;
    await api("POST", `/api/tasks/${blocked.id}/dependencies`, { depends_on: [pred.id] }, wsId);
    const deal = (await api("POST", "/api/deals", { title: "Feed stale deal", value: 10000 }, wsId)).data.deal;
    db.prepare("UPDATE deals SET updated_at = '2026-01-01 00:00:00' WHERE id = ?").run(deal.id);
    // prep: contact on a deal closing this week
    const co = (await api("POST", "/api/contacts", { name: "Feed Contact", email: "feed@example.com" }, wsId)).data.contact;
    const closing = (await api("POST", "/api/deals",
      { title: "Feed closing deal", value: 20000, contact_id: co.id, expected_close: iso(new Date(today.getTime() + 3 * 86400000)) }, wsId)).data.deal;

    const t0 = Date.now();
    const { status, data } = await api("GET", "/api/daily-feed", undefined, wsId);
    const ms = Date.now() - t0;
    expect(status).toBe(200);
    expect(ms).toBeLessThan(10000); // Milton unreachable must not hang the feed
    expect(data.milton.available).toBe(false);
    expect(data.milton.take).toBeNull();
    const byId = Object.fromEntries(data.sections.map((s: any) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["blocked", "hygiene", "plan", "prep"]);
    expect(byId.plan.items.map((i: any) => i.task.title)).toContain("Feed task today");
    expect(byId.plan.items.map((i: any) => i.task.title)).toContain("Feed task overdue");
    const blockedItem = byId.blocked.items.find((i: any) => i.task.title === "Feed blocked task");
    expect(blockedItem).toBeTruthy();
    expect(blockedItem.blocked_by.map((b: any) => b.title)).toContain("Feed predecessor");
    expect(byId.hygiene.items.some((i: any) => i.deal.title === "Feed stale deal")).toBe(true);
    expect(byId.prep.items.some((p: any) => p.name === "Feed Contact")).toBe(true);
    expect(t1.id).toBeGreaterThan(0);
    expect(closing.id).toBeGreaterThan(0);
  });
});
