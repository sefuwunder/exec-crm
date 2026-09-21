// tests/messaging-ui.test.ts — DOM-stubbed renders for the messaging + calls
// frontend: campaign tabs, email/SMS template + campaign UI, messaging settings
// (secret masking), SMS segment counter, call log modal/history/list.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  // skip the parameter list (it may contain default {} values) before counting braces
  let i = m.index + m[0].length - 1, pdepth = 0;
  let str0: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str0) {
      if (ch === "\\") { i++; continue; }
      if (ch === str0) str0 = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str0 = ch; continue; }
    if (ch === "(") pdepth++;
    else if (ch === ")") { pdepth--; if (pdepth === 0) break; }
  }
  let depth = 0;
  let str: string | null = null;
  const tplStack: number[] = [];
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (str === "`" && ch === "$" && nx === "{") { tplStack.push(depth + 1); str = null; depth++; i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "/" && nx === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && nx === "*") { i += 2; while (!(src[i] === "*" && src[i + 1] === "/")) i++; i++; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (tplStack.length && depth === tplStack[tplStack.length - 1] - 1) { tplStack.pop(); str = "`"; continue; }
      if (depth === 0 && !tplStack.length) return src.slice(m.index, i + 1);
    }
  }
  throw new Error("unbalanced braces in " + name);
}

function extractConst(src: string, name: string): string {
  const m = new RegExp(`const ${name} =`).exec(src);
  if (!m) throw new Error("const not found: " + name);
  let i = m.index, depth = 0;
  let str: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return src.slice(m.index, i + 1);
  }
  throw new Error("unterminated const " + name);
}

const extractAny = (name: string): string => {
  try { return extractFn(appSrc, name); } catch { return extractConst(appSrc, name); }
};
const extractValueConst = (name: string): string => {
  const m = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\}|\\[[\\s\\S]*?\\]|"(?:[^"\\\\]|\\\\.)*");`, "").exec(appSrc);
  if (!m) throw new Error("const not found: " + name);
  return `const ${name} = ${m[1]};`;
};

const escT = (s: any) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const PREAMBLE =
  extractValueConst("CALL_OUTCOMES") + "\n" + extractValueConst("OUTCOME_COLORS") + "\n" +
  extractValueConst("CAMPAIGN_TABS") + "\n" + extractValueConst("MERGE_TAGS") + "\n" +
  extractValueConst("GSM7_BASIC") + "\n" + extractValueConst("GSM7_EXT") + "\n" +
  `let callDirFilter = "", callOutcomeFilter = "", callQ = "";\n`;

const fns = [
  "renderMergeJs", "smsSegCount", "outcomePill", "cap", "fmtDuration", "fmtWhen",
  "mergeHintHtml", "callSectionHtml", "collectCallBody", "msgSettingsHtml",
  "callFormHtml", "campaignTabsHtml", "wireCampaignTabs",
  "vMsgTab", "msgTemplateModal", "msgCampaignModal", "wireMsgSettings",
  "vMsgCampaignDetail", "msgAudienceInfo",
  "vCalls", "logCallModal", "editCallModal", "fillCallHistory", "wireCallSection",
].map((n) => extractAny(n)).join("\n");

const mkEl = (): any => ({
  _html: "", _handlers: {} as Record<string, Function>,
  set innerHTML(v: string) { this._html = v; },
  get innerHTML() { return this._html; },
  textContent: "", value: "", style: {}, dataset: {}, disabled: false,
  addEventListener(ev: string, fn: Function) { this._handlers[ev] = fn; },
  querySelectorAll: () => [] as any[],
  querySelector: () => null,
  closest: () => mkEl(),
  append() {},
});

const captured: any = {};
const mkStubs = (over: Record<string, any> = {}) => {
  captured.modal = captured.post = captured.patch = captured.del = undefined;
  const elCache: Record<string, any> = {};
  const docEls: Record<string, any> = {};
  const routeCalls = { n: 0 };
  const alerts: string[] = [];
  return {
    elCache, docEls, alerts, routeCalls,
    $: (s: string) => (elCache[s] = elCache[s] || mkEl()),
    document: {
      querySelector: (s: string) => docEls[s] || null,
      querySelectorAll: () => [] as any[],
      getElementById: (id: string) => docEls["#" + id] || null,
    },
    location: {} as Record<string, string>,
    view: Object.assign(mkEl(), {}),
    route: async () => { routeCalls.n++; },
    openModal: (title: string, body: string, onSubmit: Function, label: string) => {
      captured.modal = { title, body, onSubmit, label };
    },
    GET: async (_p: string) => ({}),
    POST: async (p: string, b: any) => { captured.post = { p, b }; return { campaign: { id: 9 }, template: { id: 3 } }; },
    PATCH: async (p: string, b: any) => { captured.patch = { p, b }; return {}; },
    DEL: async (p: string) => { captured.del = p; return {}; },
    field: (l: string, c: string) => `<div class="field"><label>${l}</label>${c}</div>`,
    input: (n: string, v: any = "", t = "text", a = "") => `<input name="${n}" value="${v}" type="${t}" ${a}>`,
    select: (n: string, opts: any[], v: any = "") =>
      `<select name="${n}">${opts.map(([o, l]: any[]) => `<option value="${o}"${String(o) === String(v) ? " selected" : ""}>${l}</option>`).join("")}</select>`,
    statusPill: (s: string) => `<span class="pill">${s}</span>`,
    confirm: () => true,
    alert: (m: string) => { alerts.push(String(m)); },
    ...over,
  };
};

const evalIn = (expr: string, stubs: any, extra: Record<string, any> = {}) => {
  const keys = Object.keys(extra);
  return new Function(
    "esc", "$", "document", "location", "view", "route", "openModal",
    "GET", "POST", "PATCH", "DEL", "field", "input", "select", "statusPill",
    "confirm", "alert", ...keys,
    PREAMBLE + fns + `\nreturn (${expr});`
  )(
    escT, stubs.$, stubs.document, stubs.location, stubs.view, stubs.route, stubs.openModal,
    stubs.GET, stubs.POST, stubs.PATCH, stubs.DEL, stubs.field, stubs.input, stubs.select,
    stubs.statusPill, stubs.confirm, stubs.alert, ...keys.map((k) => extra[k])
  );
};

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- pure helpers
describe("sms segment counter", () => {
  test("GSM-7 counts septets, 160/153 boundaries", () => {
    const t = (expr: string) => evalIn(expr, mkStubs());
    expect(t(`smsSegCount("hello")`)).toEqual({ chars: 5, encoding: "GSM-7", segments: 1 });
    expect(t(`smsSegCount("x".repeat(160))`).segments).toBe(1);
    expect(t(`smsSegCount("x".repeat(161))`).segments).toBe(2);
    expect(t(`smsSegCount("x".repeat(306))`).segments).toBe(2);
    expect(t(`smsSegCount("x".repeat(307))`).segments).toBe(3);
  });
  test("GSM extension characters count double", () => {
    expect(evalIn(`smsSegCount("a^b")`, mkStubs())).toEqual({ chars: 4, encoding: "GSM-7", segments: 1 });
  });
  test("non-GSM text switches to Unicode with 70/67 limits", () => {
    const t = (expr: string) => evalIn(expr, mkStubs());
    expect(t(`smsSegCount("😀")`)).toEqual({ chars: 1, encoding: "Unicode", segments: 1 });
    expect(t(`smsSegCount("😀".repeat(70))`).segments).toBe(1);
    expect(t(`smsSegCount("😀".repeat(71))`).segments).toBe(2);
  });
});

describe("renderMergeJs", () => {
  test("renders all tags and empties missing values", () => {
    const html = evalIn(
      `renderMergeJs("Hi {{first_name}} {{last_name}} at {{company}} ({{title}}) <{{email}}>", { name: "Ann Lee", company_name: "Acme" })`,
      mkStubs());
    expect(html).toBe("Hi Ann Lee at Acme () <>");
  });
  test("unknown tags are left untouched", () => {
    expect(evalIn(`renderMergeJs("{{foo}} {{ first_name }}", { name: "Zed" })`, mkStubs())).toBe("{{foo}} Zed");
  });
});

describe("call formatting helpers", () => {
  const t = (expr: string) => evalIn(expr, mkStubs());
  test("fmtDuration", () => {
    expect(t(`fmtDuration(30)`)).toBe("30s");
    expect(t(`fmtDuration(95)`)).toBe("1m 35s");
    expect(t(`fmtDuration(120)`)).toBe("2m");
  });
  test("outcomePill + cap", () => {
    expect(t(`outcomePill("connected")`)).toContain("connected");
    expect(t(`outcomePill("")`)).toContain("—");
    expect(t(`cap("voicemail")`)).toBe("Voicemail");
  });
  test("callSectionHtml", () => {
    const h = t(`callSectionHtml("deal", 4)`);
    expect(h).toContain('id="calls-deal-4"');
    expect(h).toContain('id="logcall-deal-4"');
    expect(h).toContain("Log a call");
  });
  test("mergeHintHtml lists the merge tags", () => {
    expect(t(`mergeHintHtml()`)).toContain("{{first_name}}");
  });
});

describe("collectCallBody", () => {
  test("converts minutes to seconds and normalizes the timestamp", () => {
    const b = evalIn(`collectCallBody({ contact_id: "1", company_id: "", deal_id: "", direction: "in", outcome: "busy", duration_min: "2.5", called_at: "2026-09-20T09:30", notes: "hi" })`, mkStubs());
    expect(b).toMatchObject({
      contact_id: 1, company_id: null, deal_id: null, direction: "in",
      outcome: "busy", duration_sec: 150, called_at: "2026-09-20 09:30:00", notes: "hi",
    });
  });
});

// ---------------------------------------------------------------- campaign tabs
describe("campaign tabs", () => {
  test("campaignTabsHtml renders the four tabs with active state", () => {
    const html = evalIn(`campaignTabsHtml("sms")`, mkStubs());
    for (const id of ["overview", "pipeline", "email", "sms"]) expect(html).toContain(`data-ctab="${id}"`);
    expect(html).toContain('data-ctab="sms"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  });
  test("wireCampaignTabs routes tab clicks to the tab hash", () => {
    const stubs = mkStubs();
    const btns = [{ dataset: { ctab: "email" }, onclick: null as any }, { dataset: { ctab: "pipeline" }, onclick: null as any }];
    stubs.document.querySelectorAll = () => btns;
    evalIn(`wireCampaignTabs()`, stubs);
    btns[0].onclick();
    expect(stubs.location.hash).toBe("#/campaigns/email");
    btns[1].onclick();
    expect(stubs.location.hash).toBe("#/campaigns/pipeline");
  });
  test("vCampaigns dispatches to the tab renderers", () => {
    const src = extractFn(appSrc, "vCampaigns");
    expect(src).toContain("vMsgTab(tab)");
    expect(src).toContain("vCampaignPipeline()");
    expect(src).toContain("vCampaignOverview()");
  });
  test("router sends tab names to vCampaigns and ids to campaign detail", () => {
    const src = extractFn(appSrc, "route");
    expect(src).toContain('["overview", "pipeline", "email", "sms"]');
    expect(src).toContain("vMsgCampaignDetail");
    expect(src).toContain("vCampaignDetail(Number(sub))");
  });
});

// ---------------------------------------------------------------- email/SMS tab
describe("vMsgTab", () => {
  const msgStubs = () => mkStubs({
    GET: async (p: string) => {
      if (p === "/api/email-templates")
        return { templates: [{ id: 1, name: "Intro", subject: "Hi", body: "Hello {{first_name}}" }] };
      if (p === "/api/email-campaigns")
        return { campaigns: [{ id: 2, name: "Q4", template_name: "Intro", status: "draft", sent_count: 0, failed_count: 0, created_at: "2026-09-20 10:00:00" }] };
      return { values: { smtp_host: "smtp.x.com", smtp_pass: "hunter2" }, secrets_set: { smtp_pass: true } };
    },
  });
  test("renders templates, campaigns and settings with masked secrets", async () => {
    const stubs = msgStubs();
    await evalIn(`vMsgTab("email")`, stubs);
    const html = stubs.elCache["#ctab-body"].innerHTML;
    expect(html).toContain("Intro");
    expect(html).toContain("Hello {{first_name}}");
    expect(html).toContain("Q4");
    expect(html).toContain('data-camp="2"');
    expect(html).toContain("Messaging settings");
    expect(html).toContain("SMTP password set");
    // secrets are write-only: even a leaked value must never render back
    expect(html).not.toContain("hunter2");
    expect(html).not.toMatch(/value="[^"]*hunter2/);
  });
  test("new-template button opens the template modal", async () => {
    const stubs = msgStubs();
    await evalIn(`vMsgTab("email")`, stubs);
    stubs.elCache["#msg-new-tpl"].onclick();
    expect(captured.modal.title).toBe("New email template");
    expect(captured.modal.body).toContain("{{first_name}}");
  });
});

describe("msgTemplateModal", () => {
  test("SMS template shows a live segment counter", async () => {
    const stubs = mkStubs();
    await evalIn(`msgTemplateModal("sms")`, stubs);
    expect(stubs.elCache["#msg-seg-hint"].innerHTML).toContain("segment");
    stubs.elCache["#msg-tpl-body"].value = "x".repeat(200);
    stubs.elCache["#msg-tpl-body"]._handlers["input"]();
    expect(stubs.elCache["#msg-seg-hint"].innerHTML).toContain("2 segments");
    expect(stubs.elCache["#msg-seg-hint"].innerHTML).toContain("GSM-7");
  });
  test("email template has a subject field and no segment counter", async () => {
    const stubs = mkStubs();
    await evalIn(`msgTemplateModal("email")`, stubs);
    expect(captured.modal.body).toContain('name="subject"');
    expect(captured.modal.body).not.toContain("msg-seg-hint");
  });
  test("blank name is rejected, valid input POSTs", async () => {
    const stubs = mkStubs();
    await evalIn(`msgTemplateModal("email")`, stubs);
    await captured.modal.onSubmit({ name: "   ", body: "x" });
    expect(stubs.alerts.length).toBe(1);
    expect(captured.post).toBeUndefined();
    await captured.modal.onSubmit({ name: "T", subject: "S", body: "hello {{first_name}}" });
    expect(captured.post.p).toBe("/api/email-templates");
    expect(captured.post.b.body).toBe("hello {{first_name}}");
  });
  test("editing loads the existing template and PATCHes", async () => {
    const stubs = mkStubs();
    await evalIn(`msgTemplateModal("sms", { id: 8, name: "Old", body: "yo" })`, stubs);
    expect(captured.modal.title).toBe("Edit sms template");
    await captured.modal.onSubmit({ name: "Old", body: "yo2" });
    expect(captured.post).toBeUndefined();
    expect(captured.patch.p).toBe("/api/sms-templates/8");
  });
});

describe("msgCampaignModal", () => {
  const campStubs = () => mkStubs({
    GET: async (p: string) => p === "/api/email-templates"
      ? { templates: [{ id: 5, name: "Intro" }] }
      : { contacts: [{ id: 1, name: "Ann", email: "a@x" }, { id: 2, name: "Bob", email: "b@x" }] },
  });
  test("offers all-contacts or a contact multiselect", async () => {
    const stubs = campStubs();
    await evalIn(`msgCampaignModal("email")`, stubs);
    expect(captured.modal.body).toContain('name="audmode"');
    expect(captured.modal.body).toContain('id="msg-aud-contacts"');
    expect(captured.modal.body).toContain("Ann");
  });
  test("selected contacts become the audience payload", async () => {
    const stubs = campStubs();
    await evalIn(`msgCampaignModal("email")`, stubs);
    stubs.docEls["#msg-aud-contacts"] = { selectedOptions: [{ value: "1" }, { value: "2" }] };
    stubs.docEls['input[name="audmode"]:checked'] = { value: "sel" };
    await captured.modal.onSubmit({ name: "Q4", template_id: "5" });
    expect(captured.post.p).toBe("/api/email-campaigns");
    expect(captured.post.b.audience).toEqual({ contact_ids: [1, 2] });
    expect(stubs.location.hash).toBe("#/campaigns/email/9");
  });
  test("all-contacts audience sends { mode: 'all' }", async () => {
    const stubs = campStubs();
    await evalIn(`msgCampaignModal("email")`, stubs);
    stubs.docEls["#msg-aud-contacts"] = { selectedOptions: [] };
    stubs.docEls['input[name="audmode"]:checked'] = { value: "all" };
    await captured.modal.onSubmit({ name: "Q4", template_id: "5" });
    expect(captured.post.b.audience).toEqual({ mode: "all" });
  });
});

describe("msgSettingsHtml + wireMsgSettings", () => {
  test("settings render SMTP/SMS fields and mask set secrets", () => {
    const html = evalIn(
      `msgSettingsHtml({ values: { smtp_host: "h", sms_provider: "twilio" }, secrets_set: { smtp_pass: true, twilio_token: true } })`,
      mkStubs());
    expect(html).toContain('name="smtp_host"');
    expect(html).toContain('name="twilio_token"');
    expect(html).toContain("SMTP password set");
    expect(html).toContain("Twilio token set");
    expect(html).not.toMatch(/value="[^"]*token[^"]*"/i);
  });
  test("save PATCHes the settings and confirms", async () => {
    const stubs = mkStubs();
    evalIn(`wireMsgSettings()`, stubs);
    await stubs.elCache["#msg-settings-save"].onclick();
    expect(captured.patch.p).toBe("/api/msg-settings");
    await tick();
    expect(stubs.elCache["#msg-settings-msg"].textContent).toBe("Saved.");
  });
});

// ---------------------------------------------------------------- campaign detail
describe("vMsgCampaignDetail", () => {
  const camp = {
    id: 3, name: "Q4", template_id: 7, template_name: "Intro", status: "draft",
    created_at: "2026-09-20 10:00:00", audience_json: JSON.stringify({ mode: "all" }),
  };
  const detailStubs = () => mkStubs({
    GET: async (p: string) => {
      if (p === "/api/email-campaigns/3") return {
        campaign: camp,
        sends: [
          { dest: "a@x.com", contact_name: "Ann", status: "sent", error: "", sent_at: "2026-09-20 10:01:00" },
          { dest: "b@x.com", contact_name: "Bob", status: "failed", error: "SMTP refused", sent_at: "2026-09-20 10:01:05" },
        ],
      };
      if (p === "/api/email-templates")
        return { templates: [{ id: 7, name: "Intro", subject: "Hi {{first_name}}", body: "Dear {{first_name}} {{last_name}}" }] };
      if (p === "/api/contacts")
        return { contacts: [{ id: 1, name: "Ann Lee", email: "a@x.com", email_opt_out: 0 }] };
      return { values: { sms_provider: "" }, secrets_set: {} };
    },
    POST: async (p: string, b: any) => { captured.post = { p, b }; return { sent: 1, failed: 0, total: 1 }; },
  });
  test("draft shows send/delete, delivery log and a merge preview", async () => {
    const stubs = detailStubs();
    await evalIn(`vMsgCampaignDetail("email", 3)`, stubs);
    await tick();
    const html = stubs.view._html;
    expect(html).toContain("Send now");
    expect(html).toContain("Delivery log (2)");
    expect(html).toContain("SMTP refused");
    expect(html).toContain("a@x.com");
    expect(stubs.elCache["#msg-aud"].innerHTML).toContain("1 recipient");
    expect(stubs.elCache["#msg-preview"].innerHTML).toContain("Dear Ann Lee");
    expect(stubs.elCache["#msg-preview"].innerHTML).toContain("Hi Ann");
  });
  test("send-now confirms, posts, and re-routes", async () => {
    const stubs = detailStubs();
    await evalIn(`vMsgCampaignDetail("email", 3)`, stubs);
    await stubs.elCache["#msg-camp-send"].onclick();
    expect(captured.post.p).toBe("/api/email-campaigns/3/send");
    expect(stubs.alerts.join(" ")).toContain("1 sent");
    expect(stubs.routeCalls.n).toBeGreaterThan(0);
  });
  test("sent campaign hides the send button", async () => {
    const stubs = detailStubs();
    const sentCamp = { ...camp, status: "sent" };
    stubs.GET = async (p: string) => p === "/api/email-campaigns/3"
      ? { campaign: sentCamp, sends: [] }
      : { values: {}, secrets_set: {} };
    await evalIn(`vMsgCampaignDetail("email", 3)`, stubs);
    expect(stubs.view._html).not.toContain("Send now");
    expect(stubs.view._html).toContain("Delivery log");
  });
});

describe("msgAudienceInfo", () => {
  const audStubs = (contacts: any[], smsProvider: string) => mkStubs({
    GET: async (p: string) => p === "/api/contacts"
      ? { contacts }
      : { values: { sms_provider: smsProvider }, secrets_set: {} },
  });
  test("email excludes opted-out and email-less contacts", async () => {
    const stubs = audStubs([
      { id: 1, name: "Ann", email: "a@x", email_opt_out: 0 },
      { id: 2, name: "Bob", email: "b@x", email_opt_out: 1 },
      { id: 3, name: "Ned", email: "", email_opt_out: 0 },
    ], "");
    const info = await evalIn(`msgAudienceInfo("email", { audience_json: '{"mode":"all"}' })`, stubs);
    expect(info.count).toBe(1);
    expect(info.sample.name).toBe("Ann");
  });
  test("sms via twilio needs a phone and no opt-out", async () => {
    const stubs = audStubs([
      { id: 1, name: "Ann", phone: "+1", sms_opt_out: 0 },
      { id: 2, name: "Bob", phone: "+2", sms_opt_out: 1 },
      { id: 3, name: "Ned", phone: "", sms_opt_out: 0 },
    ], "twilio");
    expect((await evalIn(`msgAudienceInfo("sms", { audience_json: '{"mode":"all"}' })`, stubs)).count).toBe(1);
  });
  test("sms via gateway needs a gateway address", async () => {
    const stubs = audStubs([
      { id: 1, name: "Ann", sms_gateway: "1@vtext.com", sms_opt_out: 0 },
      { id: 2, name: "Bob", sms_gateway: "", sms_opt_out: 0 },
    ], "gateway");
    expect((await evalIn(`msgAudienceInfo("sms", { audience_json: '{"mode":"all"}' })`, stubs)).count).toBe(1);
  });
  test("explicit contact_ids narrow the audience", async () => {
    const stubs = audStubs([
      { id: 1, name: "Ann", email: "a@x", email_opt_out: 0 },
      { id: 2, name: "Bob", email: "b@x", email_opt_out: 0 },
    ], "");
    const info = await evalIn(`msgAudienceInfo("email", { audience_json: '{"contact_ids":[2]}' })`, stubs);
    expect(info.count).toBe(1);
    expect(info.sample.name).toBe("Bob");
  });
});

// ---------------------------------------------------------------- calls UI
describe("vCalls", () => {
  const callsStubs = () => mkStubs({
    GET: async (p: string) => p.startsWith("/api/calls") ? {
      calls: [
        { id: 1, contact_name: "Ann", company_name: "Acme", deal_title: "", direction: "out", duration_sec: 95, outcome: "connected", notes: "good chat", called_at: "2026-09-20 09:00:00" },
        { id: 2, contact_name: "", company_name: "", deal_title: "Big", direction: "in", duration_sec: 30, outcome: "voicemail", notes: "", called_at: "2026-09-20 10:00:00" },
      ],
      outcomes: ["connected", "voicemail"],
    } : p === "/api/contacts" ? { contacts: [{ id: 1, name: "Ann" }] }
      : p === "/api/companies" ? { companies: [] } : { deals: [] },
  });
  test("renders the call list with filters and outcome pills", async () => {
    const stubs = callsStubs();
    await evalIn(`vCalls()`, stubs);
    const html = stubs.view._html;
    expect(html).toContain("Ann");
    expect(html).toContain("connected");
    expect(html).toContain("voicemail");
    expect(html).toContain("1m 35s");
    expect(html).toContain('id="call-q"');
    expect(html).toContain('id="call-dir"');
    expect(html).toContain('id="call-outcome"');
    expect(html).toContain("+ Log a call");
  });
  test("filter controls re-route the list", async () => {
    const stubs = callsStubs();
    await evalIn(`vCalls()`, stubs);
    stubs.elCache["#call-q"].value = "ann";
    stubs.elCache["#call-go"].onclick();
    expect(stubs.routeCalls.n).toBe(1);
    stubs.elCache["#call-dir"].value = "in";
    stubs.elCache["#call-dir"].onchange();
    expect(stubs.routeCalls.n).toBe(2);
  });
  test("log button opens the call modal", async () => {
    const stubs = callsStubs();
    await evalIn(`vCalls()`, stubs);
    await stubs.elCache["#log-call"].onclick();
    expect(captured.modal.title).toBe("Log a call");
    expect(captured.modal.body).toContain('name="outcome"');
  });
});

describe("logCallModal", () => {
  const modalStubs = () => mkStubs({
    GET: async (p: string) => p === "/api/contacts" ? { contacts: [{ id: 1, name: "Ann" }] }
      : p === "/api/companies" ? { companies: [{ id: 2, name: "Acme" }] } : { deals: [] },
  });
  test("form has direction, outcome, duration and timestamp fields", async () => {
    const stubs = modalStubs();
    await evalIn(`logCallModal({ contact_id: 1 })`, stubs);
    expect(captured.modal.body).toContain('name="direction"');
    expect(captured.modal.body).toContain('name="outcome"');
    expect(captured.modal.body).toContain('name="duration_min"');
    expect(captured.modal.body).toContain('type="datetime-local"');
    expect(captured.modal.body).toContain("follow-up");
  });
  test("submit POSTs the normalized call", async () => {
    const stubs = modalStubs();
    await evalIn(`logCallModal()`, stubs);
    await captured.modal.onSubmit({
      contact_id: "1", company_id: "", deal_id: "", direction: "out",
      outcome: "connected", duration_min: "2.5", called_at: "2026-09-20T09:30", notes: "hi",
    });
    expect(captured.post.p).toBe("/api/calls");
    expect(captured.post.b).toMatchObject({
      contact_id: 1, company_id: null, deal_id: null, direction: "out",
      outcome: "connected", duration_sec: 150, called_at: "2026-09-20 09:30:00", notes: "hi",
    });
    expect(stubs.routeCalls.n).toBe(1);
  });
});

describe("fillCallHistory + wireCallSection", () => {
  test("history renders compact rows with delete buttons", async () => {
    const stubs = mkStubs({
      GET: async () => ({
        calls: [{ id: 5, direction: "out", outcome: "busy", duration_sec: 45, notes: "n/a", called_at: "2026-09-20 11:00:00" }],
      }),
    });
    const host = mkEl();
    stubs.docEls["#calls-host"] = host;
    await evalIn(`fillCallHistory("calls-host", "contact_id=1")`, stubs);
    expect(host.innerHTML).toContain("busy");
    expect(host.innerHTML).toContain("45s");
    expect(host.innerHTML).toContain("data-hcalldel");
  });
  test("wireCallSection fills history and wires the log button with a preset", async () => {
    const stubs = mkStubs({
      GET: async (p: string) => p.startsWith("/api/calls") ? { calls: [] }
        : p === "/api/contacts" ? { contacts: [{ id: 9, name: "Zed" }] }
        : p === "/api/companies" ? { companies: [] } : { deals: [] },
    });
    const host = mkEl();
    const btn = mkEl();
    stubs.docEls["#calls-contact-9"] = host;
    stubs.docEls["#logcall-contact-9"] = btn;
    await evalIn(`wireCallSection("contact", 9, { contact_id: 9 })`, stubs);
    await tick();
    expect(host.innerHTML).toContain("No calls logged yet");
    await btn.onclick();
    expect(captured.modal.title).toBe("Log a call");
    expect(captured.modal.body).toContain('value="9" selected');
  });
});

describe("callFormHtml", () => {
  test("preselects the preset contact and outcome", () => {
    const html = evalIn(
      `callFormHtml({ contact_id: 1, outcome: "no answer", direction: "in" }, [{ id: 1, name: "Ann" }], [], [])`,
      mkStubs());
    expect(html).toContain('value="1" selected');
    expect(html).toContain('value="no answer" selected');
    expect(html).toContain('value="in" selected');
  });
});
