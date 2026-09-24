// tests/widgets.test.ts — the widget registry (phase 1 scaffold): install,
// manifest validation, version history + rollback, enable/disable, the
// sandboxed bundle endpoint, and the permission-checked invoke bridge.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("widget registry API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3481";
  const WDIR = "widget-dev";

  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r), headers: r.headers };
  };
  const waitUp = async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(BASE + "/api/workspaces");
        if (r.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("server never came up");
  };

  const GOOD_MANIFEST = {
    name: "stalled-deals",
    title: "Stalled Deals",
    version: "1.0.0",
    mount: "dashboard",
    permissions: ["deals:read"],
    description: "Shows deals stuck in a stage.",
  };
  const JS_V1 = "/* WIDGET_MARKER_V1 */\ndocument.getElementById('wroot').textContent='v1';";
  const JS_V2 = "/* WIDGET_MARKER_V2 */\ndocument.getElementById('wroot').textContent='v2';";

  let mainId: number;
  let widgetId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-widgets-"));
    // dev-dir widget: picked up on boot into the first workspace
    const devDir = join(dir, WDIR, "dev-hello");
    await mkdir(devDir, { recursive: true });
    await writeFile(join(devDir, "manifest.json"), JSON.stringify({
      name: "dev-hello", title: "Dev Hello", version: "0.1.0",
      mount: "dashboard", permissions: ["feed:read"],
    }));
    await writeFile(join(devDir, "widget.js"), "/* DEV_MARKER */\n1+1;");
    const env = {
      ...process.env,
      CRM_DB: join(dir, "test.db"),
      CRM_UPLOADS: join(dir, "uploads"),
      CRM_WIDGETS: join(dir, WDIR),
    };
    const cwd = new URL("..", import.meta.url).pathname;
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd, env: { ...env, PORT: "3481" }, stdout: "ignore", stderr: "ignore",
    });
    await waitUp();
    const w = await api("GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
  });

  afterAll(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("dev directory widget is picked up on boot", async () => {
    const { status, data } = await api("GET", "/api/widgets", undefined, mainId);
    expect(status).toBe(200);
    expect(data.widgets.some((x: any) => x.name === "dev-hello")).toBe(true);
  });

  test("install: 201 with the widget, update snapshots a version", async () => {
    const ins = await api("POST", "/api/widgets", { manifest: GOOD_MANIFEST, js: JS_V1, css: ".x{color:red}" }, mainId);
    expect(ins.status).toBe(201);
    expect(ins.data.updated).toBe(false);
    widgetId = ins.data.widget.id;
    expect(ins.data.widget.manifest.permissions).toEqual(["deals:read"]);

    const upd = await api("POST", "/api/widgets",
      { manifest: { ...GOOD_MANIFEST, version: "1.1.0" }, js: JS_V2, css: "" }, mainId);
    expect(upd.status).toBe(200);
    expect(upd.data.updated).toBe(true);
    expect(upd.data.widget.version).toBe("1.1.0");

    const vers = await api("GET", `/api/widgets/${widgetId}/versions`, undefined, mainId);
    expect(vers.status).toBe(200);
    expect(vers.data.versions.length).toBe(1);
    expect(vers.data.versions[0].version).toBe("1.0.0");

    const full = await api("GET", `/api/widgets/${widgetId}`, undefined, mainId);
    expect(full.data.widget.js).toContain("WIDGET_MARKER_V2");
  });

  test("rollback restores the prior bundle (pop semantics)", async () => {
    const rb = await api("POST", `/api/widgets/${widgetId}/rollback`, undefined, mainId);
    expect(rb.status).toBe(200);
    expect(rb.data.widget.version).toBe("1.0.0");
    const full = await api("GET", `/api/widgets/${widgetId}`, undefined, mainId);
    expect(full.data.widget.js).toContain("WIDGET_MARKER_V1");
    // rolling back again re-applies the newer bundle: each rollback swaps
    // the current bundle with the most recent prior version
    const rb2 = await api("POST", `/api/widgets/${widgetId}/rollback`, undefined, mainId);
    expect(rb2.status).toBe(200);
    expect(rb2.data.widget.version).toBe("1.1.0");
    // …and it toggles back again
    const rb3 = await api("POST", `/api/widgets/${widgetId}/rollback`, undefined, mainId);
    expect(rb3.status).toBe(200);
    expect(rb3.data.widget.version).toBe("1.0.0");
    // a widget that was never updated has no prior version
    const fresh = await api("POST", "/api/widgets",
      { manifest: { ...GOOD_MANIFEST, name: "fresh-widget", version: "1.0.0" }, js: JS_V1 }, mainId);
    const rb4 = await api("POST", `/api/widgets/${fresh.data.widget.id}/rollback`, undefined, mainId);
    expect(rb4.status).toBe(400);
    expect(rb4.data.error).toMatch(/no prior version/);
    await api("DELETE", `/api/widgets/${fresh.data.widget.id}`, undefined, mainId);
  });

  test("manifest validation rejects bad bundles", async () => {
    const bad: any[] = [
      [{ ...GOOD_MANIFEST, name: "Bad Name!" }, /slug/],
      [{ ...GOOD_MANIFEST, name: "ok2", title: "" }, /title/],
      [{ ...GOOD_MANIFEST, name: "ok3", version: "v1" }, /semver/],
      [{ ...GOOD_MANIFEST, name: "ok4", mount: "sidebar" }, /mount/],
      [{ ...GOOD_MANIFEST, name: "ok5", permissions: ["deals:nuke"] }, /unknown permission/],
      [{ ...GOOD_MANIFEST, name: "ok6", permissions: [] }, /non-empty/],
      [{ ...GOOD_MANIFEST, name: "ok7", permissions: ["deals:read", "deals:read"] }, /duplicate/],
      [{ ...GOOD_MANIFEST, name: "ok8", description: "x".repeat(281) }, /too long/],
    ];
    for (const [m, re] of bad) {
      const r = await api("POST", "/api/widgets", { manifest: m, js: JS_V1 }, mainId);
      expect(r.status).toBe(400);
      expect(r.data.error).toMatch(re);
    }
    const noJs = await api("POST", "/api/widgets", { manifest: { ...GOOD_MANIFEST, name: "nojs" } }, mainId);
    expect(noJs.status).toBe(400);
    expect(noJs.data.error).toMatch(/js is required/);
  });

  test("disable hides the bundle; enable restores it", async () => {
    const dis = await api("PATCH", `/api/widgets/${widgetId}`, { enabled: false }, mainId);
    expect(dis.status).toBe(200);
    expect(dis.data.widget.enabled).toBe(false);
    const b404 = await fetch(`${BASE}/api/widgets/${widgetId}/bundle?workspace=${mainId}`);
    expect(b404.status).toBe(404);
    const en = await api("PATCH", `/api/widgets/${widgetId}`, { enabled: true }, mainId);
    expect(en.data.widget.enabled).toBe(true);
    const b200 = await fetch(`${BASE}/api/widgets/${widgetId}/bundle?workspace=${mainId}`);
    expect(b200.status).toBe(200);
    expect(b200.headers.get("content-type")).toContain("text/html");
    const html = await b200.text();
    expect(html).toContain("WIDGET_MARKER_V1"); // widget sits at v1.0.0 after the rollback toggles
    expect(html).toContain("window.__EXECRM_CTX__");
    expect(html).toContain("window.execrm");
    // the sandbox is strict: the widget cannot open network connections
    expect(html).toContain("connect-src 'none'");
    // </script> inside widget code is escaped so it can't break out of its
    // script tag: the bundle carries exactly the three script closers we emit
    expect((html.match(/<\/script>/g) || []).length).toBe(3);
  });

  test("bundle and registry are workspace-scoped", async () => {
    const ws2 = await api("POST", "/api/workspaces", { name: "Second" });
    const other = ws2.data.workspace.id;
    const list = await api("GET", "/api/widgets", undefined, other);
    expect(list.data.widgets.length).toBe(0);
    const b = await fetch(`${BASE}/api/widgets/${widgetId}/bundle?workspace=${other}`);
    expect(b.status).toBe(404);
    const inv = await api("POST", `/api/widgets/${widgetId}/invoke`, { method: "GET", path: "/api/deals" }, other);
    expect(inv.status).toBe(404);
  });

  test("invoke: granted reads work, ungranted writes are denied", async () => {
    // a deal for the widget to read
    await api("POST", "/api/deals", { title: "Widget probe deal", value: 1000, stage: "prospecting" }, mainId);
    const ok = await api("POST", `/api/widgets/${widgetId}/invoke`,
      { method: "GET", path: "/api/deals" }, mainId);
    expect(ok.status).toBe(200);
    expect(ok.data.deals.some((d: any) => d.title === "Widget probe deal")).toBe(true);
    // write was never granted
    const denied = await api("POST", `/api/widgets/${widgetId}/invoke`,
      { method: "POST", path: "/api/deals", body: { title: "sneaky" } }, mainId);
    expect(denied.status).toBe(403);
    expect(denied.data.error).toMatch(/permission denied.*"deals:write"/);
    // non-allowlisted endpoints are unreachable even if "readable"
    for (const p of ["/api/widgets", "/api/milton/status", "/api/workspaces", "/api/hooks/in/abc"]) {
      const r = await api("POST", `/api/widgets/${widgetId}/invoke`, { method: "GET", path: p }, mainId);
      expect(r.status).toBe(403);
    }
    // a smuggled workspace param is overridden with the widget's own
    const smuggled = await api("POST", `/api/widgets/${widgetId}/invoke`,
      { method: "GET", path: "/api/deals?workspace=99999" }, mainId);
    expect(smuggled.status).toBe(200);
  });

  test("invoke: granted writes work end to end", async () => {
    const ins = await api("POST", "/api/widgets",
      { manifest: { name: "writer", title: "Writer", version: "1.0.0", mount: "dashboard", permissions: ["deals:write", "deals:read"] }, js: JS_V1 }, mainId);
    const wid = ins.data.widget.id;
    const created = await api("POST", `/api/widgets/${wid}/invoke`,
      { method: "POST", path: "/api/deals", body: { title: "Widget-made deal", value: 500, stage: "prospecting" } }, mainId);
    expect(created.status).toBe(201);
    expect(created.data.deal.title).toBe("Widget-made deal");
    const read = await api("POST", `/api/widgets/${wid}/invoke`, { method: "GET", path: "/api/deals" }, mainId);
    expect(read.data.deals.some((d: any) => d.title === "Widget-made deal")).toBe(true);
    // disabled widgets can't invoke
    await api("PATCH", `/api/widgets/${wid}`, { enabled: false }, mainId);
    const dead = await api("POST", `/api/widgets/${wid}/invoke`, { method: "GET", path: "/api/deals" }, mainId);
    expect(dead.status).toBe(403);
    await api("DELETE", `/api/widgets/${wid}`, undefined, mainId);
  });

  test("invoke: the allowlist mirrors real CRM routes (no phantoms)", async () => {
    const ins = await api("POST", "/api/widgets",
      { manifest: { name: "mapcheck", title: "Map Check", version: "1.0.0", mount: "dashboard",
        permissions: ["contacts:write", "contacts:read", "outreach:write", "outreach:read"] }, js: JS_V1 }, mainId);
    const wid = ins.data.widget.id;
    const invoke = (method: string, p: string, body?: any) =>
      api("POST", `/api/widgets/${wid}/invoke`, { method, path: p, body }, mainId);
    // contacts has no item-level DELETE route in the CRM, so the map must
    // not grant it: 403 from the bridge, not a proxied 404
    const del = await invoke("DELETE", "/api/contacts/1");
    expect(del.status).toBe(403);
    // outreach item-level DELETE exists: reachable with outreach:write
    const odel = await invoke("DELETE", "/api/outreach/99999");
    expect(odel.status).toBe(404);
    const created = await invoke("POST", "/api/outreach", { channel: "call", note: "bridge probe" });
    expect(created.status).toBe(200);
    const oid = created.data.outreach.id;
    const patched = await invoke("PATCH", `/api/outreach/${oid}`, { outcome: "connected" });
    expect(patched.status).toBe(200);
    const odel2 = await invoke("DELETE", `/api/outreach/${oid}`);
    expect(odel2.status).toBe(200);
    await api("DELETE", `/api/widgets/${wid}`, undefined, mainId);
  });

  test("uninstall removes the widget and its history", async () => {
    const del = await api("DELETE", `/api/widgets/${widgetId}`, undefined, mainId);
    expect(del.status).toBe(200);
    const gone = await api("GET", `/api/widgets/${widgetId}`, undefined, mainId);
    expect(gone.status).toBe(404);
    const list = await api("GET", "/api/widgets", undefined, mainId);
    // only the dev-dir widget remains
    expect(list.data.widgets.every((x: any) => x.name !== "stalled-deals")).toBe(true);
  });

  test("list omits bundle code (detail endpoint carries it)", async () => {
    const { data } = await api("GET", "/api/widgets", undefined, mainId);
    for (const w of data.widgets) {
      expect(w.js).toBeUndefined();
      expect(w.css).toBeUndefined();
      expect(w.manifest).toBeDefined();
    }
  });
});
