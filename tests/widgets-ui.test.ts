// tests/widgets-ui.test.ts — DOM-stubbed render of the widget scaffold:
// Dashboard slots (sandboxed iframes), the postMessage bridge allow/deny,
// the install permission-review step, and the manager view.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

function makeEl(): any {
  const el: any = {
    innerHTML: "", textContent: "", value: "", hidden: false,
    dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, focus() {}, click() {},
    setAttribute(k: string, v: string) { el["attr:" + k] = v; },
    getAttribute(k: string) { return el["attr:" + k]; },
  };
  return el;
}

const FEED = {
  generated_at: "2026-09-23T12:00:00Z",
  milton: { available: false, take: null },
  due_count: 0,
  items: [],
};

const WIDGETS = {
  widgets: [
    {
      id: 7, name: "stalled-deals", title: "Stalled Deals", version: "1.1.0",
      manifest: { name: "stalled-deals", title: "Stalled Deals", version: "1.1.0", mount: "dashboard", permissions: ["deals:read", "deals:write"] },
      enabled: true, versions: 2, created_at: "2026-09-23 10:00:00", updated_at: "2026-09-23 11:00:00",
    },
    {
      id: 8, name: "quiet", title: "Quiet Widget", version: "1.0.0",
      manifest: { name: "quiet", title: "Quiet Widget", version: "1.0.0", mount: "dashboard", permissions: ["feed:read"] },
      enabled: false, versions: 0, created_at: "2026-09-23 10:00:00", updated_at: "2026-09-23 10:00:00",
    },
  ],
};

function bootApp(canned: Record<string, any>, widgets = WIDGETS) {
  const els = new Map<string, any>();
  const fetched: string[] = [];
  const effective = { ...canned, "/api/widgets": widgets };
  const documentStub = {
    querySelector: (s: string) => { if (!els.has(s)) els.set(s, makeEl()); return els.get(s); },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const fetchStub = async (url: any, init?: any) => {
    const u = String(url);
    fetched.push(`${init?.method || "GET"} ${u}`);
    for (const [key, body] of Object.entries(effective)) {
      if (u.includes(key)) {
        if (body === "THROW") throw new Error("connection refused");
        const ok = !(body as any)?.__status || (body as any).__status < 400;
        const status = (body as any)?.__status || 200;
        return { ok, status, json: async () => (body as any)?.__status ? (body as any).data : body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: "not stubbed: " + u }) };
  };
  const locationStub: any = { hash: "" };
  const store = new Map<string, string>();
  const localStorageStub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  const factory = new Function("document", "fetch", "location", "localStorage", "confirm", "window",
    appSrc + `\nreturn { route, vDashboard, vWidgetManager, widgetCheckManifest, widgetPermChips,
      widgetReviewHtml, widgetSlotHtml, widgetCardHtml, widgetOnMessage, widgetIframes, widgetNotify };`);
  const app = factory(documentStub, fetchStub, locationStub, localStorageStub, () => true, { addEventListener() {} });
  const view = () => documentStub.querySelector("#view").innerHTML as string;
  const waitFor = async (pred: (h: string) => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred(view())) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for " + label + ":\n" + view().slice(0, 600));
  };
  return { app, view, waitFor, fetched, doc: documentStub };
}

const BOOT_CANNED = {
  "/api/widgets/7/invoke": { deals: [{ id: 1, title: "Acme rollout" }] },
  "/api/widgets/9/invoke": { __status: 403, data: { error: 'permission denied: "deals:write" was not granted to this widget' } },
  "/api/deals": { deals: [], stages: [], labels: [] },
  "/api/meta-colors": { colors: {} },
  "/api/workspaces": { workspaces: [{ id: 1, name: "Main", color: "#579bfc" }] },
  "/api/daily-feed": FEED,
  "/api/milton/hygiene": { error: "down" },
  "/api/milton/status": { ok: false, reachable: false },
  "/api/widgets": WIDGETS,
};

describe("widget dashboard slots (DOM-stubbed)", () => {
  test("enabled widgets mount as sandboxed iframes; disabled ones don't", async () => {
    const { view, waitFor } = bootApp(BOOT_CANNED);
    await waitFor((h) => h.includes("widget-grid"), "widget grid");
    const h = view();
    // the enabled widget gets a slot…
    expect(h).toContain('data-widget-frame="7"');
    expect(h).toContain("/api/widgets/7/bundle?workspace=1");
    // …sandboxed with scripts only: no allow-same-origin anywhere
    expect(h).toContain('sandbox="allow-scripts"');
    expect(h).not.toContain("allow-same-origin");
    // the disabled widget gets no slot
    expect(h).not.toContain('data-widget-frame="8"');
    // manage gear is present, nav stays at 4 items (no widget nav entry)
    expect(h).toContain('id="widgets-manage"');
  });

  test("dashboard with no enabled widgets shows the empty state", async () => {
    const off = { widgets: WIDGETS.widgets.map((w) => ({ ...w, enabled: false })) };
    const { view, waitFor } = bootApp(BOOT_CANNED, off);
    await waitFor((h) => h.includes("widget-grid"), "widget grid");
    const h = view();
    expect(h).not.toContain("data-widget-frame=");
    expect(h).toContain("No widgets yet");
  });

  test("bridge forwards an allowlisted call and posts the result back", async () => {
    const { app, fetched } = bootApp(BOOT_CANNED);
    const posted: any[] = [];
    const cw = { postMessage: (m: any) => posted.push(m) };
    app.widgetIframes.set(7, { contentWindow: cw, style: {}, dataset: { widgetFrame: "7" } });
    app.widgetOnMessage({ source: cw, data: { type: "widget-api", reqId: "r1", method: "GET", path: "/api/deals" } });
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched.some((f) => f.includes("/api/widgets/7/invoke"))).toBe(true);
    expect(posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ type: "widget-api-result", reqId: "r1", ok: true });
    expect(posted[0].data).toEqual({ deals: [{ id: 1, title: "Acme rollout" }] });
  });

  test("bridge surfaces a permission denial as an error to the widget", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const posted: any[] = [];
    const cw = { postMessage: (m: any) => posted.push(m) };
    app.widgetIframes.set(9, { contentWindow: cw, style: {}, dataset: { widgetFrame: "9" } });
    app.widgetOnMessage({ source: cw, data: { type: "widget-api", reqId: "r9", method: "POST", path: "/api/deals", body: { title: "x" } } });
    await new Promise((r) => setTimeout(r, 50));
    expect(posted.length).toBe(1);
    expect(posted[0]).toMatchObject({ type: "widget-api-result", reqId: "r9", ok: false });
    expect(String(posted[0].error)).toContain("permission denied");
  });

  test("bridge ignores messages from unknown sources", async () => {
    const { app, fetched, view, waitFor } = bootApp(BOOT_CANNED);
    // let the async boot settle so background fetches don't race the assertion
    await waitFor((h) => h.includes("widget-grid"), "widget grid");
    const before = fetched.length;
    app.widgetOnMessage({ source: {}, data: { type: "widget-api", reqId: "rx", method: "GET", path: "/api/deals" } });
    app.widgetOnMessage({ source: null, data: { type: "widget-api", reqId: "ry", method: "GET", path: "/api/deals" } });
    app.widgetOnMessage(null);
    await new Promise((r) => setTimeout(r, 30));
    expect(fetched.length).toBe(before);
  });

  test("bridge resize clamps the frame height", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const cw = { postMessage() {} };
    const frame: any = { contentWindow: cw, style: {} };
    app.widgetIframes.set(7, frame);
    app.widgetOnMessage({ source: cw, data: { type: "widget-resize", height: 5000 } });
    expect(frame.style.height).toBe("1200px");
    app.widgetOnMessage({ source: cw, data: { type: "widget-resize", height: 300 } });
    expect(frame.style.height).toBe("300px");
  });
});

describe("widget manifest validation (client mirror)", () => {
  const { app } = bootApp(BOOT_CANNED);
  const good = {
    name: "my-widget", title: "My Widget", version: "1.2.3",
    mount: "dashboard", permissions: ["deals:read", "tasks:write"],
  };
  test("accepts a valid manifest", () => {
    expect(app.widgetCheckManifest(good)).toBeNull();
  });
  test("rejects bad shapes with plain-language errors", () => {
    expect(app.widgetCheckManifest(null)).toMatch(/object/);
    expect(app.widgetCheckManifest({ ...good, name: "Bad Name" })).toMatch(/slug/);
    expect(app.widgetCheckManifest({ ...good, title: "" })).toMatch(/title/);
    expect(app.widgetCheckManifest({ ...good, version: "1.0" })).toMatch(/semver/);
    expect(app.widgetCheckManifest({ ...good, mount: "sidebar" })).toMatch(/dashboard/);
    expect(app.widgetCheckManifest({ ...good, permissions: ["deals:nuke"] })).toMatch(/unknown permission/);
    expect(app.widgetCheckManifest({ ...good, permissions: [] })).toMatch(/non-empty/);
    expect(app.widgetCheckManifest({ ...good, permissions: ["deals:read", "deals:read"] })).toMatch(/duplicate/);
  });
});

describe("install permission review", () => {
  const { app } = bootApp(BOOT_CANNED);
  test("reads and writes are listed separately, writes called out", () => {
    const html = app.widgetReviewHtml({
      name: "stalled-deals", title: "Stalled Deals", version: "2.0.0",
      mount: "dashboard", description: "Finds stuck deals.",
      permissions: ["deals:read", "deals:write", "tasks:write"],
    });
    expect(html).toContain("Stalled Deals");
    expect(html).toContain("v2.0.0");
    expect(html).toContain("Can read");
    expect(html).toContain("Can write");
    expect(html).toContain("changes your CRM data");
    // writes wear the terracotta chip, reads the neutral one
    expect(html).toContain('class="perm write"');
    expect(html).toContain("deals · write");
    expect(html).toContain("tasks · write");
    expect(html).toContain("deals · read");
    expect(html).toContain("this workspace only");
  });
  test("permission chips mark writes distinctly", () => {
    const html = app.widgetPermChips(["contacts:read", "contacts:write"]);
    expect(html).toContain('class="perm write"');
    expect(html).toContain('class="perm"');
  });
});

describe("widgets manager view", () => {
  test("lists widgets with toggles, permissions, rollback and uninstall", async () => {
    const { app, view, waitFor } = bootApp(BOOT_CANNED);
    await app.vWidgetManager();
    await waitFor((h) => h.includes("Stalled Deals"), "manager list");
    const h = view();
    expect(h).toContain("Stalled Deals");
    expect(h).toContain("v1.1.0");
    expect(h).toContain('data-w-toggle="7"');
    expect(h).toContain('class="perm write"');
    expect(h).toContain("Roll back (2)");
    expect(h).toContain('data-w-del="7"');
    expect(h).toContain("Quiet Widget");
    expect(h).toContain("← Dashboard");
    // destructive action wears the danger style
    expect(h).toContain("btn danger sm");
  });
});
