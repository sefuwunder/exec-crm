// tests/widget-sets.test.ts — widget SETS (phase 2): installable bundles of
// widgets that work together. One install, one permission grant, a pinned set
// version while members may be updated independently (divergence flag), and
// set-level rollback restoring every member bundle at once.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

describe("widget sets API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3482";
  const DB = () => new Database(join(dir, "test.db"), { readonly: true });

  const j = (r: Response) => r.json();
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await j(r) };
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

  const member = (name: string, title: string, version: string, permissions: string[], jsMark: string) => ({
    manifest: { name, title, version, mount: "dashboard", permissions, description: "" },
    js: `/* ${jsMark} */\ndocument.getElementById('wroot').textContent='${name}';`,
    css: "",
  });
  const setDef = (version: string, members: any[]) => ({
    manifest: { name: "morning-briefing", title: "Morning Briefing", version, description: "Starter set." },
    members,
  });
  const two = (v1: string, v2: string, m1 = "JS_A", m2 = "JS_B") => setDef("1.0.0", [
    member("briefing-greeting", "Greeting", v1, ["feed:read"], m1),
    member("briefing-actions", "Actions", v2, ["deals:read", "deals:write"], m2),
  ]);

  let mainId: number;
  let betaId: number;
  let setId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-wsets-"));
    await mkdir(join(dir, "uploads"), { recursive: true });
    await mkdir(join(dir, "widgets"), { recursive: true });
    const env = { ...process.env, CRM_DB: join(dir, "test.db"), CRM_UPLOADS: join(dir, "uploads"), CRM_WIDGETS: join(dir, "widgets") };
    const cwd = new URL("..", import.meta.url).pathname;
    proc = Bun.spawn(["bun", "src/server.ts"], { cwd, env: { ...env, PORT: "3482" }, stdout: "ignore", stderr: "ignore" });
    await waitUp();
    const w = await api("GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    const b = await api("POST", "/api/workspaces", { name: "Beta Team" });
    betaId = b.data.workspace.id;
  });

  afterAll(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("installing a set installs its members as widgets in one shot", async () => {
    const { status, data } = await api("POST", "/api/widget-sets", two("1.0.0", "2.0.0"), mainId);
    expect(status).toBe(201);
    expect(data.installed).toBe(true);
    const s = data.set;
    expect(s.name).toBe("morning-briefing");
    expect(s.version).toBe("1.0.0");
    expect(s.members).toHaveLength(2);
    expect(s.diverged).toBe(false);
    expect(s.snapshots).toBe(0);
    setId = s.id;
    // members landed as ordinary registry widgets with their own permissions
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    const names = wl.data.widgets.map((w: any) => w.name);
    expect(names).toContain("briefing-greeting");
    expect(names).toContain("briefing-actions");
    const actions = wl.data.widgets.find((w: any) => w.name === "briefing-actions");
    expect(actions.version).toBe("2.0.0");
    expect(actions.manifest.permissions).toEqual(["deals:read", "deals:write"]);
  });

  test("set manifest validation rejects bad bundles", async () => {
    const bad = (def: any) => api("POST", "/api/widget-sets", def, mainId);
    let r = await bad({ ...setDef("1.0.0", [member("a", "A", "1.0.0", ["feed:read"], "x")]), manifest: { name: "Bad Name", title: "T", version: "1.0.0" } });
    expect(r.status).toBe(400);
    r = await bad(setDef("1.0.0", []));
    expect(r.status).toBe(400);
    r = await bad({ manifest: { name: "s", title: "S", version: "1.0.0" } });
    expect(r.status).toBe(400);
    const dup = two("1.0.0", "1.0.0");
    dup.members.push(member("briefing-greeting", "Greeting dup", "1.0.0", ["feed:read"], "y"));
    r = await bad(dup);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/duplicate member/);
    const badPerm = two("1.0.0", "1.0.0");
    badPerm.members[0].manifest.permissions = ["deals:nuke"];
    r = await bad(badPerm);
    expect(r.status).toBe(400);
    const tooMany = setDef("1.0.0", Array.from({ length: 13 }, (_, i) => member(`m${i}`, `M${i}`, "1.0.0", ["feed:read"], `z${i}`)));
    r = await bad(tooMany);
    expect(r.status).toBe(400);
    const emptyJs = two("1.0.0", "1.0.0");
    emptyJs.members[0].js = "   ";
    r = await bad(emptyJs);
    expect(r.status).toBe(400);
  });

  test("updating a set snapshots the prior state and keeps the version pinned", async () => {
    const { status, data } = await api("POST", "/api/widget-sets", two("1.1.0", "2.1.0", "JS_A2", "JS_B2"), mainId);
    expect(status).toBe(200);
    expect(data.installed).toBe(false);
    expect(data.set.version).toBe("1.0.0"); // pinned — member versions moved, set version did not
    expect(data.set.snapshots).toBe(1);
    expect(data.set.diverged).toBe(false);
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    const g = wl.data.widgets.find((w: any) => w.name === "briefing-greeting");
    expect(g.version).toBe("1.1.0");
  });

  test("independent widget updates leave the set version pinned and flag divergence", async () => {
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    const g = wl.data.widgets.find((w: any) => w.name === "briefing-greeting");
    const upd = await api("POST", "/api/widgets", {
      manifest: { ...g.manifest, version: "9.9.9" }, js: "/* LONE */\n1;", css: "",
    }, mainId);
    expect(upd.status).toBe(200);
    const s = await api("GET", `/api/widget-sets/${setId}`, undefined, mainId);
    expect(s.data.set.version).toBe("1.0.0"); // still pinned
    expect(s.data.set.diverged).toBe(true);
    const m = s.data.set.members.find((x: any) => x.name === "briefing-greeting");
    expect(m.version).toBe("9.9.9");
    expect(m.snapshot_version).toBe("1.1.0");
    expect(m.diverged).toBe(true);
  });

  test("set rollback restores every member at once; a second rollback restores the newer state", async () => {
    // current: greeting 9.9.9 (diverged), actions 2.1.0; latest snapshot is the
    // pre-update state (1.0.0 / 2.0.0) — rollback undoes the set update.
    const r1 = await api("POST", `/api/widget-sets/${setId}/rollback`, undefined, mainId);
    expect(r1.status).toBe(200);
    expect(r1.data.set.version).toBe("1.0.0"); // pinned through rollback
    expect(r1.data.set.diverged).toBe(false);
    const g1 = r1.data.set.members.find((x: any) => x.name === "briefing-greeting");
    expect(g1.version).toBe("1.0.0");
    // the newer bundle was preserved in widget_versions — widget-level rollback could restore it
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    const gw = wl.data.widgets.find((w: any) => w.name === "briefing-greeting");
    expect(gw.versions).toBeGreaterThan(0);
    // pop semantics: a second rollback re-applies the newer (9.9.9) state
    const r2 = await api("POST", `/api/widget-sets/${setId}/rollback`, undefined, mainId);
    expect(r2.status).toBe(200);
    const g2 = r2.data.set.members.find((x: any) => x.name === "briefing-greeting");
    expect(g2.version).toBe("9.9.9");
    // the restored bundles become the new pin, so nothing is diverged now
    expect(r2.data.set.diverged).toBe(false);
  });

  test("rollback with no prior snapshot is a 400", async () => {
    const fresh = await api("POST", "/api/widget-sets", {
      manifest: { name: "fresh-set", title: "Fresh", version: "1.0.0", description: "" },
      members: [member("fresh-one", "Fresh One", "1.0.0", ["feed:read"], "F")],
    }, mainId);
    expect(fresh.status).toBe(201);
    const r = await api("POST", `/api/widget-sets/${fresh.data.set.id}/rollback`, undefined, mainId);
    expect(r.status).toBe(400);
    expect(r.data.error).toMatch(/no prior set snapshot/);
    await api("DELETE", `/api/widget-sets/${fresh.data.set.id}`, undefined, mainId);
  });

  test("uninstalling a set removes the set record but leaves member widgets", async () => {
    const r = await api("DELETE", `/api/widget-sets/${setId}`, undefined, mainId);
    expect(r.status).toBe(200);
    const g = await api("GET", `/api/widget-sets/${setId}`, undefined, mainId);
    expect(g.status).toBe(404);
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    expect(wl.data.widgets.map((w: any) => w.name)).toContain("briefing-greeting");
    const db = DB();
    const leftovers = db.query("SELECT COUNT(*) AS n FROM widget_sets WHERE id = ?").get(setId) as any;
    expect(leftovers.n).toBe(0);
    const snapLeft = db.query("SELECT COUNT(*) AS n FROM widget_set_versions WHERE set_id = ?").get(setId) as any;
    expect(snapLeft.n).toBe(0);
    db.close();
  });

  test("sets are workspace-scoped: invisible across workspaces", async () => {
    const inst = await api("POST", "/api/widget-sets", two("1.0.0", "1.0.0"), mainId);
    const sid = inst.data.set.id;
    const listB = await api("GET", "/api/widget-sets", undefined, betaId);
    expect(listB.data.sets).toHaveLength(0);
    const getB = await api("GET", `/api/widget-sets/${sid}`, undefined, betaId);
    expect(getB.status).toBe(404);
    // member widgets landed only in the installing workspace
    const wlB = await api("GET", "/api/widgets", undefined, betaId);
    expect(wlB.data.widgets.map((w: any) => w.name)).not.toContain("briefing-greeting");
    await api("DELETE", `/api/widget-sets/${sid}`, undefined, mainId);
  });

  test("deleting a workspace cascades its sets and snapshots", async () => {
    const c = await api("POST", "/api/workspaces", { name: "Gamma Set" });
    const gid = c.data.workspace.id;
    const inst = await api("POST", "/api/widget-sets", two("1.0.0", "1.0.0"), gid);
    const sid = inst.data.set.id;
    await api("POST", "/api/widget-sets", two("1.1.0", "1.1.0"), gid); // creates a snapshot row
    const del = await api("DELETE", `/api/workspaces/${gid}`, { confirm: "Gamma Set" });
    expect(del.status).toBe(200);
    const db = DB();
    const s = db.query("SELECT COUNT(*) AS n FROM widget_sets WHERE workspace_id = ?").get(gid) as any;
    const v = db.query("SELECT COUNT(*) AS n FROM widget_set_versions WHERE set_id = ?").get(sid) as any;
    expect(s.n).toBe(0);
    expect(v.n).toBe(0);
    db.close();
  });

  test("the sandboxed bundle exposes the phase-2 bridge: context + events", async () => {
    const wl = await api("GET", "/api/widgets", undefined, mainId);
    const w = wl.data.widgets.find((x: any) => x.name === "briefing-greeting");
    const r = await fetch(`${BASE}/api/widgets/${w.id}/bundle?workspace=${mainId}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("contextSlots");
    expect(html).toContain("widget-context-get");
    expect(html).toContain("widget-context-set");
    expect(html).toContain("widget-event-publish");
    expect(html).toContain("selectedDeal");
    expect(html).toContain("selectedContact");
    expect(html).toContain("selectedCompany");
  });
});
