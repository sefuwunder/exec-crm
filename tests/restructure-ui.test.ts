// tests/restructure-ui.test.ts — DOM-stubbed render of the restructured surface:
// Dashboard renders Milton insights only (Review → Action → Outcome),
// Outreach renders the action log, Milton page embeds the agent.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

function makeEl(): any {
  return {
    innerHTML: "", textContent: "", value: "", hidden: false,
    dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, focus() {}, click() {},
  };
}

const HYGIENE = {
  ok: true, workspace_id: 1,
  lead: "2 in review, 1 in action, 1 in outcome",
  counts: { review: 2, action: 1, outcome: 1 },
  items: [
    { phase: "review", icon: "🔍", text: "Acme Corp has no research notes", fix: "ask Milton to research it" },
    { phase: "review", icon: "📋", text: "3 deals have no next step", fix: "" },
    { phase: "action", icon: "📞", text: "Beta LLC went quiet 9 days ago", fix: "log a call in Outreach" },
    { phase: "outcome", icon: "💡", text: "log the outcome of the Acme demo", fix: "" },
  ],
  chips: ["refresh"],
};

const OUTREACH = {
  outreach: [
    { id: 1, workspace_id: 1, channel: "call", deal_id: 7, contact_id: 3, note: "Left voicemail",
      outcome: "", happened_at: "2026-09-20", created_at: "2026-09-20 10:00:00",
      deal_title: "Acme rollout", contact_name: "Ada Lovelace" },
    { id: 2, workspace_id: 1, channel: "email", deal_id: null, contact_id: null, note: "Sent proposal",
      outcome: "Meeting booked", happened_at: "2026-09-21", created_at: "2026-09-21 10:00:00",
      deal_title: null, contact_name: null },
  ],
  channels: [
    { value: "call", label: "Call" }, { value: "email", label: "Email" },
    { value: "social", label: "Social message" }, { value: "video", label: "Video call" },
    { value: "in_person", label: "In person" },
  ],
};

function bootApp(canned: Record<string, any>) {
  const els = new Map<string, any>();
  const documentStub = {
    querySelector: (s: string) => { if (!els.has(s)) els.set(s, makeEl()); return els.get(s); },
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const fetchStub = async (url: any) => {
    const u = String(url);
    for (const [key, body] of Object.entries(canned)) {
      if (u.includes(key)) {
        if (body === "THROW") throw new Error("connection refused");
        return { ok: true, status: 200, json: async () => body };
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
    appSrc + "\nreturn { route, vDashboard, vOutreach, vMilton };");
  const app = factory(documentStub, fetchStub, locationStub, localStorageStub, () => true, { addEventListener() {} });
  const view = () => documentStub.querySelector("#view").innerHTML as string;
  const waitFor = async (pred: (h: string) => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred(view())) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for " + label + ":\n" + view().slice(0, 600));
  };
  return { app, view, waitFor, doc: documentStub };
}

const BOOT_CANNED = {
  "/api/deals": { deals: [], stages: [], labels: [] },
  "/api/meta-colors": { colors: {} },
  "/api/workspaces": { workspaces: [{ id: 1, name: "Main", color: "#579bfc" }] },
  "/api/milton/hygiene": HYGIENE,
  "/api/milton/status": { ok: true, reachable: true },
  "/api/outreach": OUTREACH,
  "/api/contacts": { contacts: [] },
};

describe("restructured views (DOM-stubbed render)", () => {
  test("dashboard renders milton insights grouped Review → Action → Outcome", async () => {
    const { view, waitFor } = bootApp(BOOT_CANNED);
    // the boot IIFE routes to the dashboard by itself
    await waitFor((h) => h.includes("cycle-strip"), "dashboard cycle strip");
    const h = view();
    for (const label of ["Review", "Action", "Outcome"]) expect(h).toContain(label);
    expect(h).toContain("Acme Corp has no research notes");
    expect(h).toContain("Beta LLC went quiet 9 days ago");
    expect(h).toContain("log the outcome of the Acme demo");
    // phase order in the document: review group before action before outcome
    const ri = h.indexOf("Review <span"), ai = h.indexOf("Action <span"), oi = h.indexOf("Outcome <span");
    expect(ri).toBeGreaterThan(-1); expect(ai).toBeGreaterThan(-1); expect(oi).toBeGreaterThan(-1);
    expect(ri).toBeLessThan(ai); expect(ai).toBeLessThan(oi);
    // the old dashboard content is gone
    expect(h).not.toContain("Open pipeline");
    expect(h).not.toContain("Weighted pipeline");
    expect(h).not.toContain("Closing soon");
  });

  test("dashboard shows a helpful empty state when milton is down", async () => {
    const { view, waitFor } = bootApp({ ...BOOT_CANNED, "/api/milton/hygiene": "THROW" });
    await waitFor((h) => h.includes("Milton insights"), "dashboard down state");
    const h = view();
    expect(h).toContain("Milton");
    expect(h).not.toContain("cycle-strip");
  });

  test("outreach renders every channel and the outcome affordance", async () => {
    const { app, view, waitFor } = bootApp(BOOT_CANNED);
    await waitFor((h) => h.includes("cycle-strip") || h.includes("Milton insights"), "boot");
    await app.vOutreach();
    const h = view();
    for (const label of ["Call", "Email", "Social message", "Video call", "In person"]) {
      expect(h).toContain(label);
    }
    expect(h).toContain("Log outreach");
    expect(h).toContain("Left voicemail");
    expect(h).toContain("Acme rollout");
    expect(h).toContain("Ada Lovelace");
    // row 1 has no outcome → the "log the outcome" affordance; row 2 shows it
    expect(h).toContain("log the outcome");
    expect(h).toContain("Meeting booked");
  });

  test("milton page is a same-origin chat shell, never an iframe", async () => {
    const up = bootApp(BOOT_CANNED);
    await up.waitFor((h) => h.includes("cycle-strip") || h.includes("Milton insights"), "boot");
    await up.app.vMilton();
    // wait for the history fetch to settle into the greeting
    await up.waitFor((h) => h.includes("milton-text"), "chat shell");
    const h = up.view();
    expect(h).not.toContain("<iframe");
    expect(h).toContain('id="milton-text"');
    expect(h).toContain("New conversation");
    expect(h).not.toContain("127.0.0.1:3009");
    // the greeting paints into the messages element (stub keeps it separate
    // from #view's html string, as a real DOM would nest it)
    const msgs = up.doc.querySelector("#milton-msgs").innerHTML;
    expect(msgs).toContain("your pipeline agent");

    const down = bootApp({ ...BOOT_CANNED, "/api/milton/status": { ok: false, reachable: false } });
    await down.waitFor((h) => h.includes("cycle-strip") || h.includes("Milton insights"), "boot");
    await down.app.vMilton();
    const hd = down.view();
    expect(hd).not.toContain("milton-text");
    expect(hd).toContain("isn't running");
  });
});
