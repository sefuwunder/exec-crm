// tests/daily-feed.test.ts — GET /api/daily-feed: the Milton-built daily
// feed. Milton's "morning brief" take rides along when Milton is reachable;
// when Milton is down the feed still returns 200 with milton.available=false.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("daily feed API", () => {
  let dir: string;
  let stub: any;
  let proc: any;
  let procDown: any;
  const BASE = "http://localhost:3471";
  const BASE_DOWN = "http://localhost:3472";
  const STUB = "http://localhost:3470";
  const chatSeen: { session: string; message: string }[] = [];

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
  const today = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const plus3 = (() => {
    const d = new Date(); d.setDate(d.getDate() + 3);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  let mainId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-feed-"));
    // stub milton: answers the server-side "morning brief" flow
    stub = Bun.serve({
      port: 3470,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/session/workspace" && req.method === "POST")
          return Response.json({ ok: true });
        if (url.pathname === "/api/chat" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          chatSeen.push({ session: b.session, message: b.message });
          return Response.json({ text: `**Morning brief** for workspace chat.\nFollow up on Acme.`, ms: 5 });
        }
        return new Response("nf", { status: 404 });
      },
    });
    const env = { ...process.env, CRM_DB: join(dir, "test.db"), CRM_UPLOADS: join(dir, "uploads") };
    const cwd = new URL("..", import.meta.url).pathname;
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd, env: { ...env, PORT: "3471", MILTON_URL: STUB }, stdout: "ignore", stderr: "ignore",
    });
    await waitUp(BASE);
    procDown = Bun.spawn(["bun", "src/server.ts"], {
      cwd, env: { ...env, PORT: "3472", MILTON_URL: "http://localhost:3499" }, stdout: "ignore", stderr: "ignore",
    });
    await waitUp(BASE_DOWN);

    const w = await api(BASE, "GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    // company + contact for the prep section
    const co = await api(BASE, "POST", "/api/companies", { name: "Acme Corp", industry: "Software" }, mainId);
    const ct = await api(BASE, "POST", "/api/contacts",
      { name: "Ada Lovelace", title: "CEO", email: "ada@acme.test", company_id: co.data.company.id }, mainId);
    // a deal closing this week, linked to both
    const deal = await api(BASE, "POST", "/api/deals",
      { title: "Acme rollout", value: 9000, stage: "proposal", expected_close: plus3,
        company_id: co.data.company.id, contact_id: ct.data.contact.id }, mainId);
    const dealId = deal.data.deal.id;
    // tasks: one overdue, one due today linked to the closing deal
    await api(BASE, "POST", "/api/tasks", { title: "Overdue follow-up", due_date: "2020-01-01", owner: "You" }, mainId);
    await api(BASE, "POST", "/api/tasks", { title: "Prep the demo", due_date: today, owner: "You", deal_id: dealId }, mainId);
    // a stale deal: untouched 40 days (written straight to the db)
    const stale = await api(BASE, "POST", "/api/deals", { title: "Dusty deal", value: 100, stage: "prospecting" }, mainId);
    const db = new Database(join(dir, "test.db"));
    db.query("UPDATE deals SET updated_at = datetime('now', '-40 days') WHERE id = ?").run(stale.data.deal.id);
    db.close();
  });

  afterAll(async () => {
    stub.stop();
    proc.kill(); procDown.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the stream with Milton's take when Milton is up", async () => {
    const { status, data } = await api(BASE, "GET", "/api/daily-feed", undefined, mainId);
    expect(status).toBe(200);
    expect(data.milton.available).toBe(true);
    expect(data.milton.take).toContain("Morning brief");
    // the server asked milton for the morning brief on a feed session
    expect(chatSeen.some((c) => c.message === "morning brief")).toBe(true);
    expect(chatSeen[0].session).toContain("exec-crm-feed");
    expect(data.due_count).toBeGreaterThanOrEqual(2);
    const labels = data.items.map((i: any) => i.label);
    expect(labels).toContain("Plan");
    expect(labels).toContain("Prep");
    expect(labels).toContain("Hygiene");
    // prep names the people/companies behind today's work
    const prepNames = data.items.filter((i: any) => i.label === "Prep").map((i: any) => i.prep.name);
    expect(prepNames).toContain("Ada Lovelace");
    expect(prepNames).toContain("Acme Corp");
    // hygiene flags the untouched deal
    const hyg = data.items.filter((i: any) => i.label === "Hygiene");
    expect(hyg.some((i: any) => i.deal.title === "Dusty deal" && /untouched \d+ days/.test(i.note))).toBe(true);
    // task items carry the shape the edit modal needs
    const plan = data.items.filter((i: any) => i.label === "Plan");
    expect(plan[0].task.title).toBeDefined();
    expect(plan[0].task.id).toBeGreaterThan(0);
  });

  test("stream is chronological: dated items first, ascending", async () => {
    const { data } = await api(BASE, "GET", "/api/daily-feed", undefined, mainId);
    const dates = data.items.map((i: any) => i.date || "");
    const dated = dates.filter(Boolean);
    const undated = dates.filter((d: string) => !d);
    // all dated items come before undated ones…
    expect(dates.indexOf("") === -1 || dates.slice(0, dated.length).every(Boolean)).toBe(true);
    expect(undated.length).toBeGreaterThan(0);
    // …and dated items ascend
    const sorted = [...dated].sort();
    expect(dated).toEqual(sorted);
    // overdue task sorts before today's task
    const planTitles = data.items.filter((i: any) => i.label === "Plan").map((i: any) => i.task.title);
    expect(planTitles.indexOf("Overdue follow-up")).toBeLessThan(planTitles.indexOf("Prep the demo"));
  });

  test("milton down: still 200, milton.available=false, stream intact", async () => {
    const { status, data } = await api(BASE_DOWN, "GET", "/api/daily-feed", undefined, mainId);
    expect(status).toBe(200);
    expect(data.milton.available).toBe(false);
    expect(data.milton.take).toBeNull();
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.items.some((i: any) => i.label === "Plan")).toBe(true);
  });

  test("unknown workspace is a 400", async () => {
    const { status } = await api(BASE, "GET", "/api/daily-feed", undefined, 99999);
    expect(status).toBe(400);
  });
});
