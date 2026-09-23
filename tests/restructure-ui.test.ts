// tests/restructure-ui.test.ts — DOM-stubbed render of the restructured surface:
// Dashboard shows the Milton-built daily feed (take + stream) with Milton's
// insights below, Outreach renders the action log, and Milton lives in a
// floating, collapsible dock.
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
    appSrc + "\nreturn { route, vDashboard, vOutreach, miltonDockOpen, miltonDockToggle, miltonDockApi, sugAction, sugLiveDeals, outreachSuggestions, outreachModal };");
  const app = factory(documentStub, fetchStub, locationStub, localStorageStub, () => true, { addEventListener() {} });
  const view = () => documentStub.querySelector("#view").innerHTML as string;
  const waitFor = async (pred: (h: string) => boolean, label: string) => {
    for (let i = 0; i < 200; i++) {
      if (pred(view())) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out waiting for " + label + ":\n" + view().slice(0, 600));
  };
  const insights = () => documentStub.querySelector("#dash-insights").innerHTML;
  const booted = (h: string) => h.includes("Today's stream") || h.includes("Milton's take") || insights().includes("cycle-strip") || insights().includes("Milton insights");
  return { app, view, waitFor, doc: documentStub, location: locationStub, insights, booted };
}

const FEED = {
  generated_at: "2026-09-23T12:00:00Z",
  milton: { available: true, take: "Today: follow up on **Beta LLC**.\nCall Bea back." },
  due_count: 1,
  items: [
    { type: "task", label: "Plan", date: "2026-09-23",
      task: { id: 1, title: "Call Bea", done: false, due_date: "2026-09-23",
        owner: "You", deal_id: 7, deal_title: "Beta LLC rollout" } },
    { type: "prep", label: "Prep", date: "2026-09-25",
      prep: { kind: "contact", id: 3, name: "Bea", sub: "CEO · bea@beta.com",
        reason: "Beta LLC rollout — closes 2026-09-25" } },
    { type: "deal", label: "Hygiene", date: null, note: "untouched 31 days",
      deal: { id: 7, title: "Beta LLC rollout", value: 5000, stage: "proposal",
        stage_name: "Proposal", probability: 50, expected_close: "", owner: "You",
        company_id: null, contact_id: 3, campaign_id: null,
        company_name: "Beta LLC", contact_name: "Bea" } },
  ],
};

const BOOT_CANNED = {
  "/api/deals": { deals: [], stages: [], labels: [] },
  "/api/meta-colors": { colors: {} },
  "/api/workspaces": { workspaces: [{ id: 1, name: "Main", color: "#579bfc" }] },
  "/api/daily-feed": FEED,
  "/api/milton/hygiene": HYGIENE,
  "/api/milton/status": { ok: true, reachable: true },
  "/api/milton/chat": { text: "stub heard: hello", chips: ["thanks"] },
  "/api/outreach": OUTREACH,
  "/api/contacts": { contacts: [] },
};

describe("restructured views (DOM-stubbed render)", () => {
  test("dashboard shows the daily feed: take + stream, then insights", async () => {
    const { view, waitFor, booted, insights } = bootApp(BOOT_CANNED);
    // the boot IIFE routes to the dashboard by itself
    await waitFor((h) => h.includes("Today's stream"), "dashboard feed");
    const h = view();
    // the Milton-built feed: take with **bold** rendered, chronological stream
    expect(h).toContain("✦ Milton's take");
    expect(h).toContain("follow up on <b>Beta LLC</b>");
    expect(h).toContain("Call Bea");
    expect(h).toContain("Beta LLC rollout");
    expect(h).toContain("feed-pill");
    expect(h).toContain("untouched 31 days");
    expect(h).toContain("1</b> things need you today");
    // the playbook insights still render below the feed
    await waitFor(() => insights().includes("cycle-strip"), "insights strip");
    const h2 = view() + insights();
    for (const label of ["Review", "Action", "Outcome"]) expect(h2).toContain(label);
    expect(h2).toContain("Acme Corp has no research notes");
    // feed comes before insights in the document
    expect(view().indexOf("Today's stream")).toBeLessThan(view().indexOf("dash-insights"));
    // the old dashboard content is gone
    expect(h2).not.toContain("Open pipeline");
    expect(h2).not.toContain("Weighted pipeline");
    expect(h2).not.toContain("Closing soon");
  });

  test("dashboard still renders when milton is down: stream empty, take + insights show the offline state", async () => {
    const { view, waitFor, booted, insights } = bootApp({ ...BOOT_CANNED, "/api/daily-feed": "THROW", "/api/milton/hygiene": "THROW" });
    await waitFor((h) => h.includes("Milton's take"), "dashboard down state");
    const h = view() + insights();
    expect(h).toContain("Milton's take");
    expect(h).toContain("Milton is unreachable");
    expect(h).toContain("Milton insights");
    expect(h).not.toContain("cycle-strip");
    // quick-add still renders so the day can be seeded by hand
    expect(h).toContain('id="qa-title"');
  });

  test("outreach renders every channel and the outcome affordance", async () => {
    const { app, view, waitFor, booted } = bootApp(BOOT_CANNED);
    await waitFor(booted, "boot");
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

  test("milton dock: collapsible, same-origin chat shell, no iframe, no MILTON_URL leak", async () => {
    const { app, doc, waitFor, booted } = bootApp(BOOT_CANNED);
    await waitFor(booted, "boot");
    const head = doc.querySelector("#milton-dock-head");
    const body = doc.querySelector("#milton-dock-body");
    // starts collapsed
    expect(body.hidden).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    app.miltonDockOpen();
    // wait for init to finish (status check + history/greeting)
    for (let i = 0; i < 200; i++) {
      if (body.hidden === false && head.getAttribute("aria-expanded") === "true" &&
        doc.querySelector("#milton-msgs").innerHTML.includes("pipeline agent")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(body.hidden).toBe(false);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    const msgs = doc.querySelector("#milton-msgs").innerHTML;
    expect(msgs).toContain("your pipeline agent");
    expect(msgs).not.toContain("127.0.0.1:3009");
    expect(msgs).not.toContain("<iframe");
    // send a message through the same-origin proxy
    await app.miltonDockApi.send("hello");
    const after = doc.querySelector("#milton-msgs").innerHTML;
    expect(after).toContain("hello");
    expect(after).toContain("stub heard: hello");
    // open state persists; collapse again
    app.miltonDockToggle();
    expect(body.hidden).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  test("milton dock shows the offline state when milton is down", async () => {
    const { app, doc, waitFor, booted } = bootApp({
      ...BOOT_CANNED,
      "/api/milton/status": { ok: false, reachable: false },
    });
    await waitFor(booted, "boot");
    app.miltonDockOpen();
    for (let i = 0; i < 200; i++) {
      if (doc.querySelector("#milton-msgs").innerHTML.includes("isn't running")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const msgs = doc.querySelector("#milton-msgs").innerHTML;
    expect(msgs).toContain("isn't running");
    expect(msgs).not.toContain("127.0.0.1:3009");
  });

  test("old milton/feed routes redirect to the dashboard", async () => {
    const { app, location, waitFor, booted } = bootApp(BOOT_CANNED);
    await waitFor(booted, "boot");
    for (const hash of ["#/milton", "#/feed"]) {
      location.hash = hash;
      await app.route();
      expect(location.hash).toBe("#/dashboard");
    }
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
    const { app, view, waitFor, booted } = bootApp(SUG_CANNED);
    await waitFor(booted, "boot");
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
    const { app, view, waitFor, booted } = bootApp({ ...SUG_CANNED, "/api/milton/hygiene": "THROW" });
    await waitFor(booted, "boot");
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
