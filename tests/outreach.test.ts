// tests/outreach.test.ts — Outreach: the Action log (all channels, workspace-scoped)
// + /api/milton/* proxy and status.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- db-level
describe("outreach migration", () => {
  test("legacy DB (no outreach table) gains it on open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "crm-or-mig-"));
    const db = new Database(join(dir, "t.db"), { create: true });
    db.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      color TEXT DEFAULT '#579bfc', created_at TEXT DEFAULT (datetime('now')))`);
    db.exec(`INSERT INTO workspaces (name) VALUES ('Main')`);
    db.close();
    const mdb = openDb(join(dir, "t.db"));
    const cols = mdb.query(`PRAGMA table_info(outreach)`).all() as any[];
    const names = cols.map((c) => c.name);
    for (const col of ["workspace_id", "channel", "deal_id", "contact_id", "note", "outcome", "happened_at"]) {
      expect(names).toContain(col);
    }
    mdb.close();
    // idempotent: reopening doesn't fail or duplicate
    const mdb2 = openDb(join(dir, "t.db"));
    const cols2 = mdb2.query(`PRAGMA table_info(outreach)`).all() as any[];
    expect(cols2.filter((c) => c.name === "channel")).toHaveLength(1);
    mdb2.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("two processes opening the same fresh DB concurrently both survive migration", async () => {
    // Regression: two exec-crm instances sharing one DB raced in openDb —
    // both saw campaign_id missing, both ran ALTER TABLE, the loser crashed
    // with "duplicate column name".
    const dir = await mkdtemp(join(tmpdir(), "crm-or-race-"));
    const dbPath = join(dir, "race.db");
    const dbTs = join(new URL(".", import.meta.url).pathname, "..", "src", "db.ts");
    const script = `const { openDb } = await import(${JSON.stringify(dbTs)}); openDb(${JSON.stringify(dbPath)}).close();`;
    const procs = [0, 1].map(() =>
      Bun.spawn(["bun", "-e", script], { stdout: "ignore", stderr: "pipe" }));
    const codes = await Promise.all(procs.map((pr) => pr.exited));
    const errs = await Promise.all(procs.map(async (pr) => new Response(pr.stderr).text()));
    expect(errs.join("\n")).not.toContain("duplicate column name");
    expect(codes).toEqual([0, 0]);
    await rm(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- API
describe("outreach API", () => {
  let dir: string;
  let proc: any;
  let stub: any;
  let procMilton: any;
  const BASE = "http://localhost:3466";
  const BASE_M = "http://localhost:3468"; // exec-crm pointed at the stub milton
  const MILTON_STUB = "http://localhost:3467";
  const j = (r: Response) => r.json();
  const api = async (base: string, method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = base + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
  };
  const waitUp = async (base: string) => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(base + "/api/workspaces");
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`server at ${base} never came up`);
  };

  let mainId: number, betaId: number, dealId: number, contactId: number;
  let betaDealId: number, betaContactId: number;
  let stubHygieneWs: string | null = null;
  const stubSessions: Record<string, number> = {};
  const stubChatSeen: { session: string; message: string }[] = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-or-live-"));
    // stub milton: health + hygiene, records the workspace query param
    stub = Bun.serve({
      port: 3467,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/health") return Response.json({ ok: true, llm: false });
        if (url.pathname === "/api/hygiene") {
          stubHygieneWs = url.searchParams.get("workspace");
          return Response.json({
            ok: true, workspace_id: Number(stubHygieneWs),
            lead: "1 in review, 2 in action, 0 in outcome",
            counts: { review: 1, action: 2, outcome: 0 },
            items: [
              { phase: "review", icon: "🔍", text: "stub finding", fix: "stub fix", kind: "no_contact" },
              { phase: "action", icon: "📞", text: "stub: Beta LLC went quiet", kind: "quiet_early",
                ref: { deal_id: 7, contact_id: 3 } },
              { phase: "action", icon: "🕸️", text: "stub: 2 stale deals", kind: "stale",
                ref: { deal_ids: [7, 8] } },
            ],
            chips: ["refresh"],
          });
        }
        // chat surface for the embedded agent page
        if (url.pathname === "/api/chat-sessions" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          stubSessions["s-stub1"] = Number(b.workspace_id);
          return Response.json({ session: { id: "s-stub1", name: "exec-crm" } }, { status: 201 });
        }
        if (url.pathname === "/api/session/workspace" && req.method === "GET") {
          const sid = url.searchParams.get("session") || "";
          const wid = stubSessions[sid];
          if (wid == null) return new Response("nf", { status: 404 });
          return Response.json({ workspace_id: wid, workspace_name: "Stub" });
        }
        if (url.pathname === "/api/chat" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          stubChatSeen.push({ session: b.session, message: b.message });
          return Response.json({ text: `stub heard: ${b.message}`, chips: ["thanks"] });
        }
        if (url.pathname === "/api/history" && req.method === "GET") {
          return Response.json({ messages: [
            { role: "user", text: "hello stub", created_at: "2026-09-23 10:00:00" },
            { role: "milton", text: "stub heard: hello stub", created_at: "2026-09-23 10:00:01" },
          ] });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const env = { ...process.env, CRM_DB: join(dir, "test.db"), CRM_UPLOADS: join(dir, "uploads") };
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...env, PORT: "3466" }, // default MILTON_URL → nothing on 3009 (down state)
      stdout: "ignore", stderr: "ignore",
    });
    await waitUp(BASE);
    // Boot the second instance only after the first is fully up: both run the
    // DB migrations at startup, and concurrent boots on one SQLite file
    // contend on write locks. (Concurrent-openDb robustness itself is covered
    // by the dedicated race test above.)
    procMilton = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...env, PORT: "3468", MILTON_URL: MILTON_STUB },
      stdout: "ignore", stderr: "ignore",
    });
    await waitUp(BASE_M);
    const w = await api(BASE, "GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    const beta = await api(BASE, "POST", "/api/workspaces", { name: "Beta" });
    betaId = beta.data.workspace.id;
    const deals = await api(BASE, "GET", "/api/deals", undefined, mainId);
    dealId = deals.data.deals[0].id;
    const contacts = await api(BASE, "GET", "/api/contacts", undefined, mainId);
    contactId = contacts.data.contacts[0].id;
    // beta workspace starts empty — create its own deal/contact for foreign-key tests
    const bdeal = await api(BASE, "POST", "/api/deals", { title: "Beta deal", value: 5000 }, betaId);
    betaDealId = bdeal.data.deal.id;
    const bcontact = await api(BASE, "POST", "/api/contacts", { name: "Beta person" }, betaId);
    betaContactId = bcontact.data.contact.id;
  });
  afterAll(async () => {
    proc?.kill(); procMilton?.kill(); stub?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("channels metadata is exposed", async () => {
    const r = await api(BASE, "GET", "/api/outreach", undefined, mainId);
    expect(r.status).toBe(200);
    const values = r.data.channels.map((c: any) => c.value).sort();
    expect(values).toEqual(["call", "email", "in_person", "social", "video"]);
    expect(r.data.channels.find((c: any) => c.value === "in_person").label).toBe("In person");
  });

  test("create + list + join deal/contact names, all five channels", async () => {
    const channels = ["call", "email", "social", "video", "in_person"];
    for (const ch of channels) {
      const r = await api(BASE, "POST", "/api/outreach", {
        channel: ch, deal_id: dealId, contact_id: contactId,
        note: `${ch} note`, outcome: ch === "call" ? "voicemail" : "", happened_at: "2026-09-20",
      }, mainId);
      expect(r.status).toBe(200);
      expect(r.data.outreach.channel).toBe(ch);
      expect(r.data.outreach.deal_title).toBeTruthy();
      expect(r.data.outreach.contact_name).toBeTruthy();
    }
    const list = await api(BASE, "GET", "/api/outreach", undefined, mainId);
    expect(list.data.outreach.length).toBe(5);
    const filt = await api(BASE, "GET", "/api/outreach?channel=email", undefined, mainId);
    expect(filt.data.outreach.length).toBe(1);
    expect(filt.data.outreach[0].channel).toBe("email");
  });

  test("validation: bad channel, foreign deal/contact, unknown ids", async () => {
    const bad = await api(BASE, "POST", "/api/outreach", { channel: "pigeon" }, mainId);
    expect(bad.status).toBe(400);
    const foreignDeal = await api(BASE, "POST", "/api/outreach", { channel: "call", deal_id: betaDealId }, mainId);
    expect(foreignDeal.status).toBe(400);
    const foreignContact = await api(BASE, "POST", "/api/outreach", { channel: "call", contact_id: betaContactId }, mainId);
    expect(foreignContact.status).toBe(400);
    const noDeal = await api(BASE, "POST", "/api/outreach", { channel: "call", deal_id: 424242 }, mainId);
    expect(noDeal.status).toBe(400);
    const noContact = await api(BASE, "POST", "/api/outreach", { channel: "call", contact_id: 424242 }, mainId);
    expect(noContact.status).toBe(400);
    const missing = await api(BASE, "POST", "/api/outreach", {}, mainId);
    expect(missing.status).toBe(400);
  });

  test("workspace isolation", async () => {
    await api(BASE, "POST", "/api/outreach", { channel: "email", note: "beta only" }, betaId);
    const main = await api(BASE, "GET", "/api/outreach", undefined, mainId);
    const beta = await api(BASE, "GET", "/api/outreach", undefined, betaId);
    expect(main.data.outreach.length).toBe(5);
    expect(beta.data.outreach.length).toBe(1);
    expect(beta.data.outreach[0].note).toBe("beta only");
    // cross-workspace read is refused
    const other = beta.data.outreach[0].id;
    const r = await api(BASE, "GET", `/api/outreach/${other}`, undefined, mainId);
    expect(r.status).toBe(404);
  });

  test("update + delete", async () => {
    const created = await api(BASE, "POST", "/api/outreach", { channel: "video", note: "demo" }, mainId);
    const id = created.data.outreach.id;
    const patched = await api(BASE, "PATCH", `/api/outreach/${id}`, { outcome: "meeting booked", channel: "in_person" });
    expect(patched.status).toBe(200);
    expect(patched.data.outreach.outcome).toBe("meeting booked");
    expect(patched.data.outreach.channel).toBe("in_person");
    const badCh = await api(BASE, "PATCH", `/api/outreach/${id}`, { channel: "smoke" });
    expect(badCh.status).toBe(400);
    const noop = await api(BASE, "PATCH", `/api/outreach/${id}`, {});
    expect(noop.status).toBe(400);
    const gone = await api(BASE, "PATCH", "/api/outreach/424242", { outcome: "x" }, mainId);
    expect(gone.status).toBe(404);
    const del = await api(BASE, "DELETE", `/api/outreach/${id}`, undefined, mainId);
    expect(del.status).toBe(200);
    const del2 = await api(BASE, "DELETE", `/api/outreach/${id}`, undefined, mainId);
    expect(del2.status).toBe(404);
  });

  test("outreach log writes an activity", async () => {
    await api(BASE, "POST", "/api/outreach", { channel: "call", note: "act-check" }, mainId);
    const acts = await api(BASE, "GET", "/api/activities", undefined, mainId);
    expect(acts.data.activities.some((a: any) => a.kind === "outreach" && a.text.includes("Call logged"))).toBe(true);
  });

  test("workspace deletion cascades outreach", async () => {
    const w = await api(BASE, "POST", "/api/workspaces", { name: "Temp" });
    const tid = w.data.workspace.id;
    await api(BASE, "POST", "/api/outreach", { channel: "social", note: "temp" }, tid);
    const del = await api(BASE, "DELETE", `/api/workspaces/${tid}`, { confirm: "Temp" });
    expect(del.status).toBe(200);
    // Temp held 7 seeded stages + the one outreach row — the cascade took all
    expect(del.data.deleted_records).toBe(8);
    // and the workspace itself is gone
    const gone = await api(BASE, "GET", "/api/outreach", undefined, tid);
    expect(gone.status).toBe(400);
  });

  test("milton status reports down state when milton is unreachable", async () => {
    const st = await api(BASE, "GET", "/api/milton/status");
    expect(st.status).toBe(200);
    expect(st.data.reachable).toBe(false);
    // the milton URL stays server-side: never leaked to the browser
    expect(st.data.url).toBeUndefined();
    const h = await api(BASE, "GET", "/api/milton/hygiene", undefined, mainId);
    expect(h.status).toBe(502);
    expect(h.data.error).toContain("isn't running");
  });

  test("milton proxy forwards workspace and returns structured hygiene", async () => {
    const st = await api(BASE_M, "GET", "/api/milton/status");
    expect(st.status).toBe(200);
    expect(st.data.reachable).toBe(true);
    expect(st.data.url).toBeUndefined();
    const h = await api(BASE_M, "GET", "/api/milton/hygiene", undefined, mainId);
    expect(h.status).toBe(200);
    expect(stubHygieneWs).toBe(String(mainId));
    expect(h.data.items[0]).toMatchObject({ phase: "review", text: "stub finding" });
    expect(h.data.counts).toEqual({ review: 1, action: 2, outcome: 0 });
  });

  test("milton proxy passes hygiene refs and kinds through untouched", async () => {
    const h = await api(BASE_M, "GET", "/api/milton/hygiene", undefined, mainId);
    expect(h.status).toBe(200);
    const byKind = Object.fromEntries(h.data.items.map((i: any) => [i.kind, i]));
    // the Outreach screen's clickable suggestions depend on these refs
    expect(byKind["quiet_early"].ref).toEqual({ deal_id: 7, contact_id: 3 });
    expect(byKind["stale"].ref).toEqual({ deal_ids: [7, 8] });
    // no ref key at all when milton sent none (not an empty object)
    expect("ref" in byKind["no_contact"]).toBe(false);
  });

  test("milton proxy: unknown workspace is rejected before any milton call", async () => {
    stubHygieneWs = null;
    const h = await api(BASE_M, "GET", "/api/milton/hygiene", undefined, 424242);
    expect(h.status).toBe(400);
    expect(stubHygieneWs).toBeNull();
  });

  test("milton chat: creates a workspace-bound session, chats, reads history", async () => {
    // no session → exec-crm asks milton to create one bound to mainId
    const c = await api(BASE_M, "POST", "/api/milton/chat", { message: "pipeline hygiene" }, mainId);
    expect(c.status).toBe(200);
    expect(c.data.text).toContain("stub heard: pipeline hygiene");
    expect(c.data.chips).toEqual(["thanks"]);
    const sid = c.data.session;
    expect(sid).toBe("s-stub1");
    // stub saw the chat on the bound session
    expect(stubChatSeen.at(-1)).toEqual({ session: "s-stub1", message: "pipeline hygiene" });
    // history round-trips through the same session
    const h = await api(BASE_M, "GET", `/api/milton/history?session=${sid}`, undefined, mainId);
    expect(h.status).toBe(200);
    expect(h.data.session).toBe("s-stub1");
    expect(h.data.messages.map((m: any) => m.role)).toEqual(["user", "milton"]);
    // a session bound to another workspace is refused
    const other = await api(BASE, "POST", "/api/workspaces", { name: "Gamma" });
    const gid = other.data.workspace.id;
    const bad = await api(BASE_M, "POST", "/api/milton/chat", { message: "hi", session: sid }, gid);
    expect(bad.status).toBe(400);
    expect(bad.data.error).toContain("unknown milton session");
    await api(BASE, "DELETE", `/api/workspaces/${gid}`, { confirm: "Gamma" });
  });

  test("milton chat: down state is a 502, empty message is a 400", async () => {
    const down = await api(BASE, "POST", "/api/milton/chat", { message: "hi" }, mainId);
    expect(down.status).toBe(502);
    expect(down.data.error).toContain("isn't running");
    const empty = await api(BASE_M, "POST", "/api/milton/chat", { message: "  " }, mainId);
    expect(empty.status).toBe(400);
  });
});

// ---------------------------------------------------------------- frontend
describe("restructured frontend", () => {
  const appSrc = readFileSync(
    join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
  const indexSrc = readFileSync(
    join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");

  test("nav has Milton + Outreach, no global calendar, no calls tab", () => {
    expect(indexSrc).toContain('href="#/milton"');
    expect(indexSrc).toContain('href="#/outreach"');
    expect(indexSrc).not.toMatch(/calendar/i);
    expect(indexSrc).not.toMatch(/#\/calls/);
  });

  test("dashboard is milton-insights-only: no KPI/pipeline/closing-soon markup", () => {
    const dashFn = appSrc.slice(appSrc.indexOf("async function vDashboard()"));
    const body = dashFn.slice(0, dashFn.indexOf("/* ---------- outreach"));
    expect(body).toContain("/api/milton/hygiene");
    expect(body).not.toContain("/api/kpis");
    expect(body).not.toContain("/api/activities");
    expect(body).not.toContain("closing-soon");
    expect(body).toContain("review");
    expect(body).toContain("action");
    expect(body).toContain("outcome");
  });

  test("router + palette expose milton and outreach views", () => {
    expect(appSrc).toContain("milton: vMilton");
    expect(appSrc).toContain("outreach: vOutreach");
    expect(appSrc).toContain('["Milton", "#/milton"]');
    expect(appSrc).toContain('["Outreach", "#/outreach"]');
    expect(appSrc).toContain("milton: \"Milton\"");
    expect(appSrc).toContain("outreach: \"Outreach\"");
  });
});
