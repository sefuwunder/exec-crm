// tests/widget-proposals.test.ts — phase 3: Milton proposes a widget or set,
// the user previews it and approves it in chat. Covers the proposal inbox
// (submit/list/validation), the sandboxed preview, approve (installs through
// the normal registry/set paths), decline, and workspace isolation.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("widget proposal inbox (phase 3)", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3489";
  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r), headers: r.headers };
  };

  const W_MANIFEST = {
    name: "stalled-radar", title: "Stalled Radar", version: "1.0.0",
    mount: "dashboard", permissions: ["deals:read", "tasks:write"],
    description: "Keeps stalled deals on the dashboard.",
  };
  const W_JS = "/* PROPOSAL_V1 */\ndocument.getElementById('wroot').textContent='radar';";
  const W_CSS = "/* proposal css */";
  const M2_MANIFEST = {
    name: "task-pulse", title: "Task Pulse", version: "1.0.0",
    mount: "dashboard", permissions: ["tasks:read"],
  };

  let mainId: number, betaId: number;
  let widgetPropId: number, setPropId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-proposals-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3489", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const ws = await api("GET", "/api/workspaces");
    mainId = ws.data.workspaces[0].id;
    const b = await api("POST", "/api/workspaces", { name: "Beta", color: "#ff8a5c" });
    betaId = b.data.workspace.id;
  });
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("submit a widget proposal → 201 pending, no bundle in the public view", async () => {
    const r = await api("POST", "/api/widget-proposals", {
      kind: "widget", title: "Stalled deals radar",
      rationale: "Six deals are stuck in qualification; this keeps them visible.",
      manifest: W_MANIFEST, js: W_JS, css: W_CSS,
    }, mainId);
    expect(r.status).toBe(201);
    const p = r.data.proposal;
    expect(p.status).toBe("pending");
    expect(p.kind).toBe("widget");
    expect(p.title).toBe("Stalled deals radar");
    expect(p.rationale).toContain("Six deals");
    expect(p.permissions.sort()).toEqual(["deals:read", "tasks:write"]);
    expect(p.manifest.name).toBe("stalled-radar");
    expect(JSON.stringify(p)).not.toContain("PROPOSAL_V1"); // bundle stays server-side
    widgetPropId = p.id;
  });

  test("proposal validation rejects bad input", async () => {
    const bad1 = await api("POST", "/api/widget-proposals",
      { kind: "widget", manifest: W_MANIFEST, js: W_JS }, mainId);
    expect(bad1.status).toBe(400); // title required
    const bad2 = await api("POST", "/api/widget-proposals",
      { kind: "gadget", title: "x", manifest: W_MANIFEST, js: W_JS }, mainId);
    expect(bad2.status).toBe(400);
    const bad3 = await api("POST", "/api/widget-proposals",
      { kind: "widget", title: "no js", manifest: W_MANIFEST, js: "  " }, mainId);
    expect(bad3.status).toBe(400);
    const bad4 = await api("POST", "/api/widget-proposals", {
      kind: "widget", title: "bad perm",
      manifest: { ...W_MANIFEST, name: "bad-perm", permissions: ["deals:destroy"] }, js: W_JS,
    }, mainId);
    expect(bad4.status).toBe(400);
  });

  test("duplicate title in the same workspace → 409", async () => {
    const r = await api("POST", "/api/widget-proposals", {
      kind: "widget", title: "Stalled deals radar", manifest: { ...W_MANIFEST, name: "other" }, js: W_JS,
    }, mainId);
    expect(r.status).toBe(409);
  });

  test("submit a set proposal → 201 with member permissions", async () => {
    const r = await api("POST", "/api/widget-proposals", {
      kind: "set", title: "Morning duo",
      rationale: "Radar plus pulse, one install.",
      manifest: { name: "morning-duo", title: "Morning Duo", version: "1.0.0", description: "Two widgets, one grant." },
      members: [
        { manifest: W_MANIFEST, js: W_JS, css: W_CSS },
        { manifest: M2_MANIFEST, js: "/* PULSE */1+1;", css: "" },
      ],
    }, mainId);
    expect(r.status).toBe(201);
    const p = r.data.proposal;
    expect(p.kind).toBe("set");
    expect(p.permissions.sort()).toEqual(["deals:read", "tasks:read", "tasks:write"]);
    expect(p.members.map((m: any) => m.name).sort()).toEqual(["stalled-radar", "task-pulse"]);
    setPropId = p.id;
  });

  test("list filters by status", async () => {
    const all = await api("GET", "/api/widget-proposals", undefined, mainId);
    expect(all.data.proposals.length).toBe(2);
    const pend = await api("GET", "/api/widget-proposals?status=pending", undefined, mainId);
    expect(pend.data.proposals.length).toBe(2);
    const appr = await api("GET", "/api/widget-proposals?status=approved", undefined, mainId);
    expect(appr.data.proposals.length).toBe(0);
  });

  test("proposals are workspace-isolated", async () => {
    const b = await api("GET", "/api/widget-proposals", undefined, betaId);
    expect(b.data.proposals.length).toBe(0);
    const r = await api("POST", "/api/widget-proposals", {
      kind: "widget", title: "Beta only", manifest: { ...W_MANIFEST, name: "beta-only" }, js: W_JS,
    }, betaId);
    expect(r.status).toBe(201);
    const b2 = await api("GET", "/api/widget-proposals?status=pending", undefined, betaId);
    expect(b2.data.proposals.map((p: any) => p.title)).toEqual(["Beta only"]);
    const m = await api("GET", "/api/widget-proposals?status=pending", undefined, mainId);
    expect(m.data.proposals.length).toBe(2);
  });

  test("preview renders the sandboxed widget with demo-only bridge", async () => {
    const r = await fetch(`${BASE}/api/widget-proposals/${widgetPropId}/preview?workspace=${mainId}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const csp = r.headers.get("content-security-policy") || "";
    expect(csp).toContain("connect-src 'none'");
    const html = await r.text();
    expect(html).toContain("PROPOSAL_V1");
    expect(html).toContain("Preview");
    expect(html).toContain("preview mode: API calls are disabled");
    expect(html).not.toContain("/api/widgets/"); // no live bridge wiring
  });

  test("set preview renders the chosen member", async () => {
    const r = await fetch(`${BASE}/api/widget-proposals/${setPropId}/preview?member=task-pulse&workspace=${mainId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("PULSE");
    expect(html).not.toContain("PROPOSAL_V1");
  });

  test("approve installs the widget through the registry", async () => {
    const r = await api("POST", `/api/widget-proposals/${widgetPropId}/approve`, {}, mainId);
    expect(r.status).toBe(200);
    expect(r.data.proposal.status).toBe("approved");
    expect(r.data.installed.type).toBe("widget");
    expect(r.data.installed.widget.name).toBe("stalled-radar");
    const reg = await api("GET", "/api/widgets", undefined, mainId);
    expect(reg.data.widgets.map((w: any) => w.name)).toContain("stalled-radar");
    // second approve is a conflict
    const r2 = await api("POST", `/api/widget-proposals/${widgetPropId}/approve`, {}, mainId);
    expect(r2.status).toBe(409);
    // preview of a decided proposal is gone
    const pv = await fetch(`${BASE}/api/widget-proposals/${widgetPropId}/preview?workspace=${mainId}`);
    expect(pv.status).toBe(409);
  });

  test("approve installs the set and its members", async () => {
    const r = await api("POST", `/api/widget-proposals/${setPropId}/approve`, {}, mainId);
    expect(r.status).toBe(200);
    expect(r.data.installed.type).toBe("set");
    expect(r.data.installed.set.name).toBe("morning-duo");
    const sets = await api("GET", "/api/widget-sets", undefined, mainId);
    expect(sets.data.sets.map((s: any) => s.name)).toContain("morning-duo");
    const reg = await api("GET", "/api/widgets", undefined, mainId);
    expect(reg.data.widgets.map((w: any) => w.name)).toContain("task-pulse");
  });

  test("decline closes a proposal; decided proposals are final", async () => {
    const sub = await api("POST", "/api/widget-proposals", {
      kind: "widget", title: "Decline me", manifest: { ...W_MANIFEST, name: "decline-me" }, js: W_JS,
    }, mainId);
    const id = sub.data.proposal.id;
    const d = await api("POST", `/api/widget-proposals/${id}/decline`, {}, mainId);
    expect(d.status).toBe(200);
    expect(d.data.proposal.status).toBe("declined");
    const a = await api("POST", `/api/widget-proposals/${id}/approve`, {}, mainId);
    expect(a.status).toBe(409);
    const reg = await api("GET", "/api/widgets", undefined, mainId);
    expect(reg.data.widgets.map((w: any) => w.name)).not.toContain("decline-me");
  });

  test("manual set install still works after the refactor", async () => {
    const r = await api("POST", "/api/widget-sets", {
      manifest: { name: "manual-set", title: "Manual Set", version: "1.0.0", description: "d" },
      members: [{ manifest: { ...M2_MANIFEST, name: "manual-m" }, js: "1+1;", css: "" }],
    }, mainId);
    expect(r.status).toBe(201);
    expect(r.data.set.name).toBe("manual-set");
    expect(r.data.installed).toBe(true);
  });
});
