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
    appSrc + "\nreturn { route, vDashboard, vOutreach, vMilton, sugAction, sugLiveDeals, outreachSuggestions, outreachModal };");
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

// ---------------------------------------------------------------- milton suggestions on the outreach screen
const SUG_DEALS = [
  { id: 7, title: "Beta LLC", stage: "prospecting", contact_id: 3, company_name: "Beta", contact_name: "Bea" },
  { id: 9, title: "Gamma Inc", stage: "qualification", contact_id: null, company_name: "Gamma", contact_name: "" },
  { id: 11, title: "Won Deal", stage: "closed_won", contact_id: null, company_name: "", contact_name: "" },
];
const SUG_CONTACTS = [{ id: 3, name: "Bea" }, { id: 5, name: "Cal" }];
const SUG_HYGIENE = {
  ok: true, workspace_id: 1, lead: "x", counts: { review: 1, action: 3, outcome: 2 },
  items: [
    { phase: "action", icon: "📞", kind: "quiet_early", text: "Beta LLC went quiet 9 days ago", fix: "log a call", ref: { deal_id: 7, contact_id: 3 } },
    { phase: "action", icon: "🕸️", kind: "stale", text: "2 stale deals untouched for 30+ days", ref: { deal_ids: [7, 9] } },
    { phase: "action", icon: "💡", kind: "R14", text: "rotate the channel, says Milton", ref: null },
    { phase: "outcome", icon: "📞", kind: "R15", text: "Beta LLC: voicemail left 2d ago — call back", ref: { deal_id: 7 } },
    { phase: "outcome", icon: "💡", kind: "R18", text: "no-interest fork advice", ref: null },
    { phase: "review", icon: "🔍", kind: "no_research", text: "Beta LLC has no research notes", ref: { deal_id: 7 } },
  ],
  chips: [],
};
const SUG_CANNED = {
  ...BOOT_CANNED,
  "/api/deals": { deals: SUG_DEALS, stages: [], labels: [] },
  "/api/contacts": { contacts: SUG_CONTACTS },
  "/api/milton/hygiene": SUG_HYGIENE,
};

describe("milton suggestions on the outreach screen", () => {
  test("sugAction resolves log / pick / ask", async () => {
    const { app } = bootApp(SUG_CANNED);
    const [quiet, stale, chan, vm] = SUG_HYGIENE.items;
    const log = app.sugAction(quiet, SUG_DEALS);
    expect(log.kind).toBe("log");
    expect(log.deal.title).toBe("Beta LLC");
    const pick = app.sugAction(stale, SUG_DEALS);
    expect(pick.kind).toBe("pick");
    expect(pick.deals.map((d) => d.title)).toEqual(["Beta LLC", "Gamma Inc"]);
    // ref.deal_ids pointing at unknown deals → no live deals → ask milton
    const gone = app.sugAction({ ...stale, ref: { deal_ids: [404, 405] } }, SUG_DEALS);
    expect(gone.kind).toBe("ask");
    expect(gone.prompt).toContain("2 stale deals");
    const ask = app.sugAction(chan, SUG_DEALS);
    expect(ask.kind).toBe("ask");
    expect(ask.prompt).toContain("rotate the channel");
    // outcome item with a live deal ref is a log action too
    expect(app.sugAction(vm, SUG_DEALS).kind).toBe("log");
  });

  test("outreachSuggestions keeps action + outcome-with-deal, drops review", async () => {
    const { app } = bootApp(SUG_CANNED);
    const kept = app.outreachSuggestions(SUG_HYGIENE.items, SUG_DEALS);
    expect(kept.map((i) => i.kind)).toEqual(["quiet_early", "stale", "R14", "R15"]);
    // outcome item without a deal ref is dropped (no useful click target)
    expect(kept.some((i) => i.kind === "R18")).toBe(false);
    // capped at 8
    const many = Array.from({ length: 20 }, (_, n) => ({ phase: "action", text: `s${n}` }));
    expect(app.outreachSuggestions(many, SUG_DEALS)).toHaveLength(8);
  });

  test("vOutreach renders clickable suggestion cards", async () => {
    const { app, view, waitFor } = bootApp(SUG_CANNED);
    await waitFor((h) => h.includes("cycle-strip") || h.includes("Milton insights"), "boot");
    await app.vOutreach();
    const h = view();
    expect(h).toContain("Milton suggests");
    // single-deal suggestion → clickable card with a log CTA
    expect(h).toContain("Beta LLC went quiet 9 days ago");
    expect(h).toContain("Log outreach — Beta LLC");
    expect(h).toContain('data-sug="0"');
    // aggregate → per-deal chips, not a single button
    expect(h).toContain("2 stale deals untouched for 30+ days");
    expect(h).toContain('data-sug-pick="1:7"');
    expect(h).toContain('data-sug-pick="1:9"');
    expect(h).toContain(">Beta LLC</button>");
    // ref-less action item → ask-Milton card
    expect(h).toContain("rotate the channel, says Milton");
    expect(h).toContain("Ask Milton");
    // outcome item with a deal ref renders; outcome without one doesn't
    expect(h).toContain("voicemail left 2d ago");
    expect(h).not.toContain("no-interest fork advice");
    // review-phase prep stays on the Dashboard, not here
    expect(h).not.toContain("has no research notes");
  });

  test("vOutreach renders the log with no suggestion panel when milton is down", async () => {
    const { app, view, waitFor } = bootApp({ ...SUG_CANNED, "/api/milton/hygiene": "THROW" });
    await waitFor((h) => h.includes("cycle-strip") || h.includes("Milton insights"), "boot");
    await app.vOutreach();
    const h = view();
    expect(h).not.toContain("Milton suggests");
    expect(h).toContain("Log outreach");
  });

  test("outreachModal prefills deal + contact from a suggestion", async () => {
    const { app, doc } = bootApp(SUG_CANNED);
    const channels = OUTREACH.channels;
    app.outreachModal(null, channels, SUG_DEALS, SUG_CONTACTS, "2026-09-23",
      { deal_id: 7, contact_id: 3 });
    const modal = doc.querySelector("#modal-root").innerHTML;
    expect(modal).toContain('<option value="7" selected>Beta LLC</option>');
    expect(modal).toContain('<option value="3" selected>Bea</option>');
  });

  test("outreachModal ignores prefill ids that are not in the dropdowns", async () => {
    const { app, doc } = bootApp(SUG_CANNED);
    const channels = OUTREACH.channels;
    app.outreachModal(null, channels, SUG_DEALS, SUG_CONTACTS, "2026-09-23",
      { deal_id: 404, contact_id: 405 });
    const modal = doc.querySelector("#modal-root").innerHTML;
    expect(modal).not.toContain('value="404" selected');
    expect(modal).not.toContain('value="405" selected');
    // falls back to the unselected placeholder
    expect(modal).toContain('<option value="" selected>—</option>');
  });
});
