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
      widgetReviewHtml, widgetSlotHtml, widgetCardHtml, widgetOnMessage, widgetIframes, widgetNotify,
      widgetHostContext, widgetCheckSetDef, widgetSetReviewHtml, widgetSetCardHtml, widgetBridgeReset };`);
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
  "/api/widget-sets": { sets: [] },
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

const SET_DEF = {
  manifest: { name: "morning-briefing", title: "Morning Briefing", version: "1.0.0", description: "Starter set." },
  members: [
    { manifest: { name: "briefing-greeting", title: "Greeting", version: "1.0.0", mount: "dashboard", permissions: ["feed:read"] }, js: "1;", css: "" },
    { manifest: { name: "briefing-actions", title: "Actions", version: "2.0.0", mount: "dashboard", permissions: ["deals:read", "deals:write"] }, js: "2;", css: "" },
  ],
};
const SET_ROW = {
  id: 3, name: "morning-briefing", title: "Morning Briefing", version: "1.0.0",
  description: "Starter set.", members: [
    { widget_id: 7, name: "briefing-greeting", title: "Greeting", version: "1.0.0", snapshot_version: "1.0.0", diverged: false },
    { widget_id: 8, name: "briefing-actions", title: "Actions", version: "2.0.0", snapshot_version: "2.0.0", diverged: false },
  ],
  snapshots: 1, diverged: false, created_at: "2026-09-24 10:00:00", updated_at: "2026-09-24 10:00:00",
};

function twoFrames(app: any) {
  const a: any[] = [], b: any[] = [];
  const cwA = { postMessage: (m: any) => a.push(m) };
  const cwB = { postMessage: (m: any) => b.push(m) };
  app.widgetIframes.set(7, { contentWindow: cwA, style: {} });
  app.widgetIframes.set(8, { contentWindow: cwB, style: {} });
  return { cwA, cwB, a, b };
}
function resetContext(app: any) {
  for (const k of Object.keys(app.widgetHostContext)) app.widgetHostContext[k] = null;
}

describe("phase 2: shared context bridge (host-mediated)", () => {
  test("context set/get round-trips a slot value through the bridge", async () => {
    const { app } = bootApp(BOOT_CANNED);
    resetContext(app);
    const { cwA, a } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c1", slot: "selectedDeal", value: { id: 5, label: "Acme" } } });
    expect(a[0]).toMatchObject({ type: "widget-context-result", reqId: "c1", ok: true, value: { id: 5, label: "Acme" } });
    expect(app.widgetHostContext.selectedDeal).toEqual({ id: 5, label: "Acme" });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-get", reqId: "c2", slot: "selectedDeal" } });
    expect(a[1]).toMatchObject({ type: "widget-context-result", reqId: "c2", ok: true, value: { id: 5, label: "Acme" } });
    // clearing back to null works too
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c3", slot: "selectedDeal", value: null } });
    expect(a[2]).toMatchObject({ ok: true, value: null });
  });
  test("unknown context slots are rejected — the host owns the slot list", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, a } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c1", slot: "evilSlot", value: { id: 1 } } });
    expect(a[0]).toMatchObject({ ok: false });
    expect(String(a[0].error)).toMatch(/unknown context slot/);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-get", reqId: "c2", slot: "evilSlot" } });
    expect(a[1]).toMatchObject({ ok: false });
  });
  test("context values must be small JSON objects or null", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, a } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c1", slot: "selectedDeal", value: [1, 2] } });
    expect(a[0]).toMatchObject({ ok: false });
    expect(String(a[0].error)).toMatch(/object or null/);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c2", slot: "selectedDeal", value: "just a string" } });
    expect(a[1]).toMatchObject({ ok: false });
    const big: any = { id: 1 };
    big.blob = "x".repeat(70000);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c3", slot: "selectedDeal", value: big } });
    expect(a[2]).toMatchObject({ ok: false });
    expect(String(a[2].error)).toMatch(/64KB/);
  });
  test("subscribed widgets get change broadcasts; others don't", async () => {
    const { app } = bootApp(BOOT_CANNED);
    resetContext(app);
    const { cwA, cwB, a, b } = twoFrames(app);
    app.widgetOnMessage({ source: cwB, data: { type: "widget-context-subscribe", slot: "selectedDeal" } });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c1", slot: "selectedDeal", value: { id: 9, label: "Nine" } } });
    const changeB = b.find((m: any) => m.type === "widget-context-change");
    expect(changeB).toMatchObject({ slot: "selectedDeal", value: { id: 9, label: "Nine" } });
    // a change to another slot does not notify the selectedDeal subscriber
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c2", slot: "selectedContact", value: { id: 2 } } });
    expect(b.filter((m: any) => m.type === "widget-context-change")).toHaveLength(1);
    // unsubscribe stops the broadcasts
    app.widgetOnMessage({ source: cwB, data: { type: "widget-context-unsubscribe", slot: "selectedDeal" } });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c3", slot: "selectedDeal", value: null } });
    expect(b.filter((m: any) => m.type === "widget-context-change")).toHaveLength(1);
    void a;
  });
  test("context bridge ignores messages from unknown sources", async () => {
    const { app } = bootApp(BOOT_CANNED);
    resetContext(app);
    app.widgetOnMessage({ source: {}, data: { type: "widget-context-set", reqId: "x", slot: "selectedDeal", value: { id: 1 } } });
    expect(app.widgetHostContext.selectedDeal).toBeNull();
  });
});

describe("phase 2: open pub/sub (host-mediated)", () => {
  test("publish routes to subscribers, never back to the publisher", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, cwB, a, b } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-subscribe", topic: "deal.selected" } });
    app.widgetOnMessage({ source: cwB, data: { type: "widget-event-subscribe", topic: "deal.selected" } });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e1", topic: "deal.selected", payload: { id: 4 } } });
    expect(a[0]).toMatchObject({ type: "widget-event-result", reqId: "e1", ok: true });
    // publisher got no event back; the other subscriber did
    expect(a.filter((m: any) => m.type === "widget-event")).toHaveLength(0);
    const ev = b.find((m: any) => m.type === "widget-event");
    expect(ev).toMatchObject({ topic: "deal.selected", payload: { id: 4 } });
  });
  test("reserved host.* topics and malformed topics are rejected", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, a } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e1", topic: "host.context", payload: {} } });
    expect(a[0]).toMatchObject({ ok: false });
    expect(String(a[0].error)).toMatch(/reserved/);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e2", topic: "host", payload: {} } });
    expect(a[1]).toMatchObject({ ok: false });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e3", topic: "bad topic!", payload: {} } });
    expect(a[2]).toMatchObject({ ok: false });
    // subscribing to a reserved topic silently does nothing — no route exists
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-subscribe", topic: "host.context" } });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-unsubscribe", topic: "deal.selected" } });
  });
  test("event payloads obey the same object-or-null, 64KB rules", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, a } = twoFrames(app);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e1", topic: "t", payload: [1] } });
    expect(a[0]).toMatchObject({ ok: false });
    const big: any = {};
    big.blob = "y".repeat(70000);
    app.widgetOnMessage({ source: cwA, data: { type: "widget-event-publish", reqId: "e2", topic: "t", payload: big } });
    expect(a[1]).toMatchObject({ ok: false });
  });
});

describe("phase 2: set definition validation (client mirror)", () => {
  test("accepts a valid set definition", () => {
    const { app } = bootApp(BOOT_CANNED);
    expect(app.widgetCheckSetDef(SET_DEF)).toBeNull();
  });
  test("rejects bad set shapes with plain-language errors", () => {
    const { app } = bootApp(BOOT_CANNED);
    expect(app.widgetCheckSetDef(null)).toMatch(/object/);
    expect(app.widgetCheckSetDef({ ...SET_DEF, manifest: { name: "Bad", title: "T", version: "1.0.0" } })).toMatch(/slug/);
    expect(app.widgetCheckSetDef({ ...SET_DEF, manifest: { name: "ss", title: "T", version: "1" } })).toMatch(/semver/);
    expect(app.widgetCheckSetDef({ ...SET_DEF, members: [] })).toMatch(/non-empty/);
    expect(app.widgetCheckSetDef({ ...SET_DEF, members: undefined })).toMatch(/non-empty/);
    const dup = JSON.parse(JSON.stringify(SET_DEF));
    dup.members.push(JSON.parse(JSON.stringify(SET_DEF.members[0])));
    expect(app.widgetCheckSetDef(dup)).toMatch(/duplicate member/);
    const badJs = JSON.parse(JSON.stringify(SET_DEF));
    badJs.members[0].js = "   ";
    expect(app.widgetCheckSetDef(badJs)).toMatch(/widget js is required/);
    const badPerm = JSON.parse(JSON.stringify(SET_DEF));
    badPerm.members[1].manifest.permissions = ["nope:read"];
    expect(app.widgetCheckSetDef(badPerm)).toMatch(/unknown permission/);
    const tooMany = JSON.parse(JSON.stringify(SET_DEF));
    tooMany.members = Array.from({ length: 13 }, (_, i) => ({
      manifest: { name: `m${i}`, title: `M${i}`, version: "1.0.0", mount: "dashboard", permissions: ["feed:read"] }, js: "x;", css: "",
    }));
    expect(app.widgetCheckSetDef(tooMany)).toMatch(/max 12/);
  });
});

describe("phase 2: one-grant install review", () => {
  test("review shows the union of member permissions, reads and writes apart", () => {
    const { app } = bootApp(BOOT_CANNED);
    const html = app.widgetSetReviewHtml(SET_DEF);
    expect(html).toContain("Morning Briefing");
    expect(html).toContain("2 widgets");
    expect(html).toContain("Greeting");
    expect(html).toContain("Actions");
    expect(html).toContain("briefing-actions");
    // union: feed:read + deals:read + deals:write, deduped
    expect(html).toContain("feed · read");
    expect(html).toContain("deals · read");
    expect(html).toContain("deals · write");
    expect(html).toContain('class="perm write"');
    expect(html).toContain("One grant");
    expect(html).toContain("stays pinned");
  });
  test("set card shows members, pin state, and divergence", () => {
    const { app } = bootApp(BOOT_CANNED);
    const html = app.widgetSetCardHtml(SET_ROW);
    expect(html).toContain("Morning Briefing");
    expect(html).toContain("v1.0.0 · pinned");
    expect(html).toContain("Greeting");
    expect(html).toContain("v1.0.0");
    expect(html).toContain('data-ws-rollback="3"');
    expect(html).toContain('data-ws-del="3"');
    expect(html).not.toContain("diverged");
    const div = { ...SET_ROW, diverged: true, members: SET_ROW.members.map((m: any) => ({ ...m, diverged: m.name === "briefing-actions", version: m.name === "briefing-actions" ? "9.9.9" : m.version })) };
    const html2 = app.widgetSetCardHtml(div);
    expect(html2).toContain("diverged");
    expect(html2).toContain("wdiverged");
  });
});

describe("phase 2: sets manager section", () => {
  test("manager renders the sets section with an install-set action", async () => {
    const canned = { ...BOOT_CANNED, "/api/widget-sets": { sets: [SET_ROW] } };
    const { app, view, waitFor } = bootApp(canned);
    await app.vWidgetManager();
    await waitFor((h) => h.includes("Widget sets"), "sets section");
    const h = view();
    expect(h).toContain("Widget sets");
    expect(h).toContain("Morning Briefing");
    expect(h).toContain('id="wm-install-set"');
    expect(h).toContain("Install set");
    expect(h).toContain("Individual widgets");
    expect(h).toContain("one permission grant");
  });
  test("manager shows the empty sets state when none are installed", async () => {
    const { app, view, waitFor } = bootApp(BOOT_CANNED);
    await app.vWidgetManager();
    await waitFor((h) => h.includes("Widget sets"), "sets section");
    expect(view()).toContain("No sets installed yet");
  });
});

describe("phase 2: workspace isolation of bridge state", () => {
  test("bridge reset clears context, subscriptions, and frame registry", async () => {
    const { app } = bootApp(BOOT_CANNED);
    const { cwA, cwB, b } = twoFrames(app);
    app.widgetOnMessage({ source: cwB, data: { type: "widget-context-subscribe", slot: "selectedDeal" } });
    app.widgetOnMessage({ source: cwB, data: { type: "widget-event-subscribe", topic: "deal.selected" } });
    app.widgetOnMessage({ source: cwA, data: { type: "widget-context-set", reqId: "c1", slot: "selectedDeal", value: { id: 1 } } });
    expect(app.widgetHostContext.selectedDeal).toEqual({ id: 1 });
    expect(b.some((m: any) => m.type === "widget-context-change")).toBe(true);
    app.widgetBridgeReset();
    expect(app.widgetHostContext.selectedDeal).toBeNull();
    expect(app.widgetHostContext.selectedContact).toBeNull();
    expect(app.widgetIframes.size).toBe(0);
    // after reset, re-registered frames get no stale broadcasts
    const msgs: any[] = [];
    const cw = { postMessage: (m: any) => msgs.push(m) };
    app.widgetIframes.set(8, { contentWindow: cw, style: {} });
    app.widgetOnMessage({ source: cw, data: { type: "widget-context-set", reqId: "c2", slot: "selectedDeal", value: { id: 2 } } });
    expect(msgs.filter((m: any) => m.type === "widget-context-change")).toHaveLength(0);
  });
});
