import { openDb, seedIfEmpty, ensureMainWorkspace, seedStages, workspaceStages, stageSlugs, slugifyStage, renumberStages, OUTREACH_CHANNELS, OUTREACH_CHANNEL_LABELS } from "./db";

const PORT = Number(process.env.PORT || 3001);
const db = openDb(process.env.CRM_DB || "./crm.db");
seedIfEmpty(db);

// Milton agent: exec-crm's Dashboard renders Milton's playbook insights and
// the Milton page embeds the agent's chat UI. Same box by default; override
// with MILTON_URL when Milton runs elsewhere.
const MILTON_URL = (process.env.MILTON_URL || "http://127.0.0.1:3009").replace(/\/+$/, "");

// ---- captured photos (business cards, client notes)
const UPLOAD_DIR = process.env.CRM_UPLOADS || "./uploads";
await Bun.$`mkdir -p ${UPLOAD_DIR}`.quiet();

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
  ".heif": "image/heif",
};
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function extFor(mime: string, originalName: string): string {
  const fromMime = Object.keys(IMAGE_TYPES).find((e) => IMAGE_TYPES[e] === mime);
  if (fromMime) return fromMime;
  const m = originalName.toLowerCase().match(/\.[a-z0-9]{3,4}$/);
  return m && IMAGE_TYPES[m[0]] ? m[0] : ".jpg";
}

// ---------------------------------------------------------------- custom fields
const CUSTOM_ENTITIES = ["contact", "company", "campaign", "task"];
const CORE_COLUMNS: Record<string, string[]> = {
  contact: ["id", "company_id", "name", "title", "email", "phone", "notes", "created_at", "company_name"],
  company: ["id", "name", "industry", "website", "size", "created_at", "deal_count", "open_value"],
  campaign: ["id", "name", "status", "start_date", "end_date", "budget", "notes", "created_at"],
  task: ["id", "title", "deal_id", "due_date", "done", "owner", "created_at", "deal_title"],
};
const FIELD_TYPES = ["text", "textarea", "number", "date", "select", "checkbox", "url"];

function getCustomFields(entity: string, w: number) {
  return db
    .query("SELECT * FROM custom_fields WHERE entity = ? AND workspace_id = ? ORDER BY position, id")
    .all(entity, w) as any[];
}
function attachCustom(entity: string, rows: any[]) {
  if (!rows.length) return rows;
  const vals = db
    .query(
      `SELECT record_id, field_id, value FROM custom_values
       WHERE entity = ? AND record_id IN (${rows.map(() => "?").join(",")})`
    )
    .all(entity, ...rows.map((r) => r.id)) as any[];
  const byRecord = new Map<number, Record<string, string>>();
  for (const v of vals) {
    if (!byRecord.has(v.record_id)) byRecord.set(v.record_id, {});
    byRecord.get(v.record_id)![v.field_id] = v.value;
  }
  for (const r of rows) r.custom = byRecord.get(r.id) || {};
  return rows;
}
function saveCustomValues(entity: string, recordId: number, custom: unknown, w: number) {
  if (!custom || typeof custom !== "object") return;
  const byId = new Map(getCustomFields(entity, w).map((f: any) => [String(f.id), f]));
  for (const [fid, raw] of Object.entries(custom as Record<string, unknown>)) {
    const f = byId.get(String(fid));
    if (!f) continue;
    let v = raw == null ? "" : String(raw);
    if (f.type === "checkbox") v = v === "1" || v === "true" ? "1" : "0";
    if (v === "") {
      db.prepare("DELETE FROM custom_values WHERE entity = ? AND record_id = ? AND field_id = ?")
        .run(entity, recordId, f.id);
    } else {
      db.prepare(
        `INSERT INTO custom_values (entity, record_id, field_id, value) VALUES (?, ?, ?, ?)
         ON CONFLICT(entity, record_id, field_id) DO UPDATE SET value = excluded.value`
      ).run(entity, recordId, f.id, v);
    }
  }
}
function slugify(label: string) {
  return (
    label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) ||
    "field"
  );
}

// ---------------------------------------------------------------- webhooks
const ALL_EVENTS = [
  "deal.created",
  "deal.stage_changed",
  "deal.updated",
  "contact.created",
  "campaign.created",
  "campaign.updated",
  "campaign.deleted",
  "task.created",
  "task.completed",
];

function logActivity(kind: string, text: string, w: number) {
  db.prepare("INSERT INTO activities (kind, text, workspace_id) VALUES (?, ?, ?)")
    .run(kind, text, w);
}

// ---- outgoing webhook custom headers ------------------------------------------
// Header values are secrets (API keys, shared secrets). They are stored
// server-side and never exposed: API/UI reads only ever see header *names*.
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
// framing headers that would corrupt delivery if overridden
const BLOCKED_HEADERS = new Set([
  "content-length", "host", "connection", "transfer-encoding", "upgrade",
  "trailer", "te", "keep-alive", "proxy-authenticate", "proxy-authorization", "expect",
]);
const MAX_CUSTOM_HEADERS = 20;
const MAX_HEADER_LEN = 2048;

function validateHeaders(input: unknown): Record<string, string> | { error: string } {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input))
    return { error: "headers must be an object of name -> value" };
  const out: Record<string, string> = {};
  const names = Object.keys(input as Record<string, unknown>);
  if (names.length > MAX_CUSTOM_HEADERS)
    return { error: `too many headers (max ${MAX_CUSTOM_HEADERS})` };
  for (const name of names) {
    const value = (input as Record<string, unknown>)[name];
    if (!name || !HEADER_NAME_RE.test(name))
      return { error: `invalid header name: ${name || "(empty)"}` };
    if (BLOCKED_HEADERS.has(name.toLowerCase()))
      return { error: `header not allowed: ${name}` };
    if (typeof value !== "string")
      return { error: `header value must be a string: ${name}` };
    if (name.length > MAX_HEADER_LEN || value.length > MAX_HEADER_LEN)
      return { error: `header too long: ${name} (max 2KB)` };
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value))
      return { error: `header must not contain line breaks: ${name}` };
    out[name] = value;
  }
  return out;
}

// stored JSON -> validated string map (tolerates legacy/garbage rows)
function storedHeaders(row: any): Record<string, string> {
  try {
    const h = JSON.parse(row.headers || "{}");
    if (h && typeof h === "object" && !Array.isArray(h)) {
      const out: Record<string, string> = {};
      for (const k of Object.keys(h))
        if (typeof h[k] === "string") out[k] = h[k];
      return out;
    }
  } catch {}
  return {};
}

// public shape: header values never leave the server — names only
function maskHeaders(row: any): any {
  return { ...row, headers: Object.keys(storedHeaders(row)) };
}

// merge custom headers over the defaults; custom wins case-insensitively,
// framing headers can never be overridden (they're rejected at write time)
function deliveryHeaders(custom: Record<string, string>, event: string): Record<string, string> {
  const lower = new Set(Object.keys(custom).map((k) => k.toLowerCase()));
  const out: Record<string, string> = { "Content-Type": "application/json", "X-CRM-Event": event };
  for (const k of Object.keys(out)) if (lower.has(k.toLowerCase())) delete out[k];
  return { ...out, ...custom };
}

async function fireWebhooks(event: string, payload: Record<string, unknown>, w: number) {
  const hooks = db
    .query("SELECT * FROM webhooks WHERE active = 1 AND workspace_id = ?")
    .all(w) as any[];
  for (const h of hooks) {
    let events: string[] = [];
    try {
      events = JSON.parse(h.events);
    } catch {}
    if (events.length && !events.includes(event) && !events.includes("*")) continue;
    const body = JSON.stringify({
      event,
      sent_at: new Date().toISOString(),
      data: payload,
    });
    let status = "ok";
    let code = 0;
    try {
      const res = await fetch(h.url, {
        method: "POST",
        headers: deliveryHeaders(storedHeaders(h), event),
        body,
        signal: AbortSignal.timeout(8000),
      });
      code = res.status;
      if (!res.ok) status = "error";
    } catch {
      status = "failed";
    }
    db.prepare(
      `INSERT INTO webhook_deliveries (webhook_id, event, payload, status, response_code)
       VALUES (?, ?, ?, ?, ?)`
    ).run(h.id, event, body, status, code);
  }
}

function dealJson(id: number, w: number) {
  return db
    .query(
      `SELECT d.*, c.name AS company_name, ct.name AS contact_name
       FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.id = ? AND d.workspace_id = ?`
    )
    .get(id, w);
}

// ---------------------------------------------------------------- helpers
// Validate an incoming campaign_id against the active workspace.
// Returns null for empty/missing, the numeric id for a workspace-owned
// campaign, or false when the id is not a campaign in this workspace.
function resolveCampaign(w: number, raw: any): number | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  const cid = Number(raw);
  if (!cid) return false;
  const hit = db
    .query("SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?")
    .get(cid, w) as any;
  return hit ? cid : false;
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- workspaces
function allWorkspaces() {
  return db.query("SELECT * FROM workspaces ORDER BY id").all() as any[];
}
// Active workspace: ?workspace=<id> wins, then the X-Workspace header,
// then the first workspace. Unknown ids get a 400 Response.
function needWs(req: Request, url: URL): number | Response {
  const list = allWorkspaces();
  if (!list.length) return ensureMainWorkspace(db);
  const raw = (url.searchParams.get("workspace") || req.headers.get("X-Workspace") || "").trim();
  if (raw) {
    const w = list.find((x) => String(x.id) === raw);
    if (!w) return json({ error: `unknown workspace "${raw}"` }, 400);
    return w.id;
  }
  return list[0].id;
}

// ---------------------------------------------------------------- daily feed
// The Milton-built daily feed, back on the Dashboard: one chronological
// stream (due → prep → hygiene) of CRM-derived suggestions, plus Milton's
// "morning brief" take when reachable. Dated items sort first, ascending;
// undated nudges follow.
// (The pre-restructure feed also ranked a Blocked section above Plan, fed
// by the task_dependencies table; that table was removed from the schema,
// so the restored feed uses the current data model.)
const mwToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function mwStageNames(w: number): Record<string, string> {
  const names: Record<string, string> = {};
  for (const s of db.query("SELECT slug, name FROM stages WHERE workspace_id = ?").all(w) as any[])
    names[s.slug] = s.name;
  return names;
}
function mwOpenDeals(w: number) {
  return db
    .query(
      `SELECT d.*, c.name AS company_name, ct.name AS contact_name FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.workspace_id = ? AND d.stage NOT IN ('closed_won', 'closed_lost')
       ORDER BY d.value DESC`
    )
    .all(w) as any[];
}
// Ask Milton directly (server-side, so MILTON_URL never leaves the server).
// Returns the reply JSON, or null when Milton is down or slow. Never throws,
// so the feed always renders with milton.available=false instead of 500ing.
async function miltonChat(session: string, message: string, w: number, timeoutMs = 7000): Promise<any | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    await fetch(`${MILTON_URL}/api/session/workspace`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, workspace_id: w }), signal: ctl.signal,
    }).catch(() => null);
    const r = await fetch(`${MILTON_URL}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session, message }), signal: ctl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
// Deal/task shapes the feed frontend can hand straight to the edit modals.
function feedDealOut(d: any, names: Record<string, string>) {
  return {
    id: d.id, title: d.title, value: d.value, stage: d.stage,
    stage_name: names[d.stage] || d.stage, probability: d.probability,
    expected_close: d.expected_close, owner: d.owner,
    company_id: d.company_id, contact_id: d.contact_id, campaign_id: d.campaign_id,
    company_name: d.company_name, contact_name: d.contact_name,
  };
}
function feedTaskOut(t: any) {
  return {
    id: t.id, title: t.title, done: !!t.done, due_date: t.due_date, owner: t.owner,
    deal_id: t.deal_id, deal_title: t.deal_title,
  };
}
async function dailyFeed(w: number) {
  const today = mwToday();
  const plus7 = (() => {
    const d = new Date(); d.setDate(d.getDate() + 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  const names = mwStageNames(w);
  const taskRows = attachCustom(
    "task",
    db.query(
      `SELECT t.*, d.title AS deal_title FROM tasks t
       LEFT JOIN deals d ON d.id = t.deal_id
       WHERE t.workspace_id = ? ORDER BY t.done, t.due_date`
    ).all(w) as any[]
  );
  const deals = mwOpenDeals(w);
  const open = taskRows.filter((t: any) => !t.done);
  const plan = open.filter((t: any) => t.due_date && t.due_date <= today);
  const closingSoon = deals.filter(
    (d) => d.expected_close && d.expected_close >= today && d.expected_close <= plus7
  );
  const staleDays = (iso: string) => {
    const m = (iso || "").slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return Math.round(
      (Date.now() - new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()) / 86400000
    );
  };
  const hygieneDeals = [
    ...deals
      .map((d) => ({ d, days: staleDays(d.updated_at) }))
      .filter((x) => x.days !== null && (x.days as number) >= 30)
      .sort((a, b) => (b.days as number) - (a.days as number))
      .slice(0, 5)
      .map((x) => ({ ...feedDealOut(x.d, names), note: `untouched ${Math.round(x.days as number)} days` })),
    ...deals.filter((d) => !d.expected_close).slice(0, 5)
      .map((d) => ({ ...feedDealOut(d, names), note: "no expected close date" })),
  ];
  // Meeting prep: distinct contacts/companies behind today's tasks and this
  // week's closing deals.
  const prepDeals = new Map<number, any>();
  for (const t of plan) {
    const d = deals.find((x) => x.id === t.deal_id);
    if (d) prepDeals.set(d.id, { deal: d, reason: `task due ${t.due_date}: ${t.title}`, date: t.due_date });
  }
  for (const d of closingSoon)
    if (!prepDeals.has(d.id)) prepDeals.set(d.id, { deal: d, reason: `closes ${d.expected_close}`, date: d.expected_close });
  const seen = new Set<string>();
  const prep: any[] = [];
  for (const { deal: d, reason, date } of prepDeals.values()) {
    const contact = d.contact_id
      ? (db.query("SELECT id, name, title, email, phone FROM contacts WHERE id = ? AND workspace_id = ?").get(d.contact_id, w) as any)
      : null;
    const company = d.company_id
      ? (db.query("SELECT id, name, industry, website FROM companies WHERE id = ? AND workspace_id = ?").get(d.company_id, w) as any)
      : null;
    if (contact && !seen.has(`c${contact.id}`)) {
      seen.add(`c${contact.id}`);
      prep.push({
        kind: "contact", id: contact.id, name: contact.name, date,
        sub: [contact.title, contact.email].filter(Boolean).join(" · ") || "—",
        reason: `${d.title} — ${reason}`,
      });
    }
    if (company && !seen.has(`o${company.id}`)) {
      seen.add(`o${company.id}`);
      prep.push({
        kind: "company", id: company.id, name: company.name, date,
        sub: company.industry || company.website || "—",
        reason: `${d.title} — ${reason}`,
      });
    }
  }
  const brief = await miltonChat(`exec-crm-feed-w${w}`, "morning brief", w);
  // One chronological stream: Plan > Prep > Hygiene rank breaks date ties.
  const rank: Record<string, number> = { Plan: 0, Prep: 1, Hygiene: 2 };
  const items: any[] = [];
  for (const t of plan) items.push({
    type: "task", label: "Plan", date: t.due_date || null, task: feedTaskOut(t),
  });
  for (const p of prep) items.push({ type: "prep", label: "Prep", date: p.date || null, prep: p });
  for (const d of hygieneDeals) items.push({
    type: "deal", label: "Hygiene", date: d.expected_close || null, note: d.note, deal: d,
  });
  items.sort((a, b) => {
    const da = a.date || "", dbb = b.date || "";
    if (da && dbb && da !== dbb) return da < dbb ? -1 : 1;
    if (!!da !== !!dbb) return da ? -1 : 1;
    return (rank[a.label] ?? 9) - (rank[b.label] ?? 9);
  });
  return {
    generated_at: new Date().toISOString(),
    milton: { available: !!brief, take: brief?.text || null },
    due_count: plan.length,
    items,
  };
}

// minimal CSV parser: handles quoted fields, embedded commas/quotes, CRLF
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function sbDecodeQP(s) {
  // quoted-printable: strip soft line breaks, then decode =XX hex bytes.
  // Bytes are re-assembled as UTF-8 (falling back to Latin-1) so
  // =C3=BC decodes to ü rather than mojibake.
  var bytes = [];
  String(s || "").replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})|[\s\S]/g, function (m, h) {
    bytes.push(h ? parseInt(h, 16) : m.charCodeAt(0) & 0xff);
    return "";
  });
  var u8 = new Uint8Array(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
  catch (e) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
}
function sbB64decode(s) {
  try { return atob(String(s || "").replace(/\s+/g, "")); }
  catch (e) { return String(s || ""); }
}
function parseVcf(text) {
  var norm = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Line unfolding: a line starting with a space or tab continues the
  // previous line (RFC 2426 §5.8.1).
  var lines = [];
  var raw = norm.split("\n");
  for (var li = 0; li < raw.length; li++) {
    var rl = raw[li];
    if (/^[ \t]/.test(rl) && lines.length) lines[lines.length - 1] += rl.slice(1);
    else lines.push(rl);
  }
  // Split into cards. A BEGIN without a matching END (or a new BEGIN before
  // the previous END) is parsed anyway and flagged malformed below — cards
  // are never silently dropped.
  var cards = [];
  var cur = null;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^BEGIN:VCARD/i.test(ln)) {
      if (cur && cur.lines.length) { cur.bad = true; cards.push(cur); }
      cur = { lines: [], bad: false };
      continue;
    }
    if (/^END:VCARD/i.test(ln)) { if (cur) { cards.push(cur); cur = null; } continue; }
    if (cur) cur.lines.push(ln);
  }
  if (cur && cur.lines.length) { cur.bad = true; cards.push(cur); }
  var out = [];
  for (var ci = 0; ci < cards.length; ci++) {
    var props = cards[ci].lines;
    var cardBad = cards[ci].bad;
    var fn = "", n = "", org = "", title = "", noteParts = [];
    var emails = [], phones = [];
    var extraFlags = [];
    for (var pi = 0; pi < props.length; pi++) {
      var line = props[pi];
      var cidx = line.indexOf(":");
      if (cidx < 0) continue; // not a property line
      var head = line.slice(0, cidx);
      var val = line.slice(cidx + 1);
      var parts = head.split(";");
      var prop = parts[0].toUpperCase();
      var params = {};
      for (var qi = 1; qi < parts.length; qi++) {
        var p = parts[qi];
        var eq = p.indexOf("=");
        if (eq < 0) {
          // vCard 2.1 bare type, e.g. TEL;HOME;VOICE:555
          params.TYPE = (params.TYPE ? params.TYPE + "," : "") + p.toUpperCase();
        } else {
          var k = p.slice(0, eq).toUpperCase();
          var v = p.slice(eq + 1).toUpperCase();
          params[k] = params[k] ? params[k] + "," + v : v;
        }
      }
      if (prop === "PHOTO" || prop === "LOGO" || prop === "SOUND" || prop === "KEY") {
        continue; // payloads are never stored
      }
      var enc = params.ENCODING || "";
      if (enc === "QUOTED-PRINTABLE" || enc === "Q") val = sbDecodeQP(val);
      else if (enc === "B" || enc === "BASE64") val = sbB64decode(val);
      val = val.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
      if (prop === "FN") { if (!fn) fn = val.trim(); }
      else if (prop === "N") { if (!n) n = val; }
      else if (prop === "ORG") { if (!org) org = val.split(";")[0].trim(); }
      else if (prop === "TITLE") { if (!title) title = val.trim(); }
      else if (prop === "NOTE") { if (val.trim()) noteParts.push(val.trim()); }
      else if (prop === "URL") { if (val.trim()) noteParts.push("Website: " + val.trim()); }
      else if (prop === "ADR") {
        var ac = val.split(";").map(function (x) { return x.trim(); }).filter(Boolean);
        if (ac.length) noteParts.push("Address: " + ac.join(", "));
      }
      else if (prop === "EMAIL" && val.trim()) { emails.push({ value: val.trim(), type: params.TYPE || "" }); }
      else if ((prop === "TEL" || prop === "X-ABPHONE") && val.trim()) { phones.push({ value: val.trim(), type: params.TYPE || "" }); }
    }
    var name = fn;
    if (!name && n) {
      var np = n.split(";");
      name = [np[3] || "", np[1] || "", np[2] || "", np[0] || "", np[4] || ""]
        .map(function (x) { return x.trim(); }).filter(Boolean).join(" ");
    }
    function pickPref(list, prefTypes) {
      for (var t = 0; t < prefTypes.length; t++) {
        for (var j = 0; j < list.length; j++) {
          if (list[j].type.indexOf(prefTypes[t]) >= 0) return list[j];
        }
      }
      return list[0] || null;
    }
    var emailPick = pickPref(emails, ["WORK", "INTERNET", "PREF"]);
    var phonePick = pickPref(phones, ["CELL", "MOBILE", "WORK", "PREF", "VOICE"]);
    var email = emailPick ? emailPick.value : "";
    var phone = phonePick ? phonePick.value : "";
    var notes = noteParts.join("\n");
    if (emails.length > 1) {
      var others = emails.filter(function (e) { return e !== emailPick; })
        .map(function (e) { return e.value + (e.type ? " (" + e.type.toLowerCase() + ")" : ""); });
      if (others.length) notes = (notes ? notes + "\n" : "") + "Other emails: " + others.join(", ");
      extraFlags.push({ code: "multi-email", reason: "vCard has " + emails.length + " emails — kept " + email + ", noted the rest." });
    }
    if (phones.length > 1) {
      var ophones = phones.filter(function (e) { return e !== phonePick; })
        .map(function (e) { return e.value + (e.type ? " (" + e.type.toLowerCase() + ")" : ""); });
      if (ophones.length) notes = (notes ? notes + "\n" : "") + "Other phones: " + ophones.join(", ");
      extraFlags.push({ code: "multi-phone", reason: "vCard has " + phones.length + " phones — kept " + phone + ", noted the rest." });
    }
    if (cardBad) {
      extraFlags.push({ code: "malformed", reason: "vCard is missing its END:VCARD line — parsed what could be read." });
    }
    if (!name && !email) {
      extraFlags.push({ code: "unusable", reason: "No usable name or email — nothing to import from this card." });
    }
    out.push({ name: name, title: title, email: email, phone: phone, company: org, notes: notes, extraFlags: extraFlags });
  }
  return out;
}
// ---------------------------------------------------------------- server
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // ---- captured photos, served from the uploads dir (not public/)
    if (path.startsWith("/uploads/")) {
      const name = path.slice("/uploads/".length);
      if (!name || name.includes("/") || name.includes("..")) {
        return new Response("not found", { status: 404 });
      }
      const f = Bun.file(`${UPLOAD_DIR}/${name}`);
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const ext = name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || "";
      return new Response(f, {
        headers: { "Content-Type": IMAGE_TYPES[ext] || "application/octet-stream" },
      });
    }

    // ---- static files
    if (path === "/" || !path.startsWith("/api/")) {
      const file = path === "/" ? "/index.html" : path;
      const f = Bun.file(`./public${file}`);
      if (await f.exists()) {
        const type = file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".svg")
              ? "image/svg+xml"
              : "text/html";
        return new Response(f, { headers: { "Content-Type": type } });
      }
      return new Response("not found", { status: 404 });
    }

    // ---- workspaces
    if (path === "/api/workspaces" && method === "GET") {
      const rows = db
        .query(
          `SELECT w.*,
             (SELECT COUNT(*) FROM companies WHERE workspace_id = w.id) AS companies,
             (SELECT COUNT(*) FROM contacts WHERE workspace_id = w.id) AS contacts,
             (SELECT COUNT(*) FROM deals WHERE workspace_id = w.id) AS deals,
             (SELECT COUNT(*) FROM tasks WHERE workspace_id = w.id) AS tasks,
             (SELECT COUNT(*) FROM campaigns WHERE workspace_id = w.id) AS campaigns
           FROM workspaces w ORDER BY w.id`
        )
        .all();
      return json({ workspaces: rows });
    }
    if (path === "/api/workspaces" && method === "POST") {
      const b = await readBody(req);
      const name = String(b.name || "").trim();
      if (!name) return json({ error: "name is required" }, 400);
      const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || "")) ? b.color : "#579bfc";
      const r = db
        .prepare("INSERT INTO workspaces (name, color) VALUES (?, ?)")
        .run(name, color);
      const newId = Number(r.lastInsertRowid);
      seedStages(db, newId);
      return json(
        { workspace: db.query("SELECT * FROM workspaces WHERE id = ?").get(newId) },
        201
      );
    }
    const wsRec = path.match(/^\/api\/workspaces\/(\d+)$/);
    if (wsRec && method === "PATCH") {
      const b = await readBody(req);
      const ws = db.query("SELECT * FROM workspaces WHERE id = ?").get(Number(wsRec[1])) as any;
      if (!ws) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.name !== undefined && String(b.name).trim()) {
        sets.push("name = ?");
        vals.push(String(b.name).trim());
      }
      if (b.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(b.color))) {
        sets.push("color = ?");
        vals.push(b.color);
      }
      if (sets.length) {
        db.prepare(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = ?`).run(...vals, ws.id);
      }
      return json({ workspace: db.query("SELECT * FROM workspaces WHERE id = ?").get(ws.id) });
    }
    if (wsRec && method === "DELETE") {
      const ws = db.query("SELECT * FROM workspaces WHERE id = ?").get(Number(wsRec[1])) as any;
      if (!ws) return json({ error: "not found" }, 404);
      if (allWorkspaces().length <= 1) {
        return json({ error: "cannot delete the last workspace" }, 400);
      }
      const counts: Record<string, number> = {};
      for (const t of ["companies", "contacts", "deals", "tasks", "campaigns", "activities", "captures", "custom_fields", "webhooks", "incoming_hooks", "stages", "outreach", "sandbox_batches", "sandbox_rows"]) {
        counts[t] = (db.query(`SELECT COUNT(*) n FROM ${t} WHERE workspace_id = ?`).get(ws.id) as any).n;
      }
      const records = Object.values(counts).reduce((a, b) => a + b, 0);
      const b = await readBody(req);
      // safe default: deleting a non-empty workspace needs the typed name as confirmation
      if (records > 0 && b.confirm !== ws.name) {
        return json(
          { error: `workspace "${ws.name}" holds ${records} record(s) — pass { "confirm": "<name>" } to delete them too`, counts },
          409
        );
      }
      // cascade, FK-safe order
      const whIds = (db.query("SELECT id FROM webhooks WHERE workspace_id = ?").all(ws.id) as any[]).map((x) => x.id);
      if (whIds.length) {
        db.query(`DELETE FROM webhook_deliveries WHERE webhook_id IN (${whIds.map(() => "?").join(",")})`).run(...whIds);
      }
      db.prepare("DELETE FROM webhooks WHERE workspace_id = ?").run(ws.id);
      db.prepare("DELETE FROM incoming_hooks WHERE workspace_id = ?").run(ws.id);
      const fieldIds = (db.query("SELECT id FROM custom_fields WHERE workspace_id = ?").all(ws.id) as any[]).map((x) => x.id);
      if (fieldIds.length) {
        db.query(`DELETE FROM custom_values WHERE field_id IN (${fieldIds.map(() => "?").join(",")})`).run(...fieldIds);
      }
      db.prepare("DELETE FROM custom_fields WHERE workspace_id = ?").run(ws.id);
      const capFiles = db.query("SELECT filename FROM captures WHERE workspace_id = ?").all(ws.id) as any[];
      for (const f of capFiles) {
        try { await Bun.$`rm -f ${UPLOAD_DIR}/${f.filename}`.quiet(); } catch {}
      }
      for (const t of ["outreach", "activities", "captures", "tasks", "deals", "contacts", "campaigns", "companies", "stages", "sandbox_rows", "sandbox_batches"]) {
        db.prepare(`DELETE FROM ${t} WHERE workspace_id = ?`).run(ws.id);
      }
      db.prepare("DELETE FROM workspaces WHERE id = ?").run(ws.id);
      return json({ ok: true, deleted_records: records });
    }

    // ---- pipeline stages (per-workspace editable schema) -----------------------
    // deals.stage stays a TEXT slug; this table owns the ordered schema.
    // Slugs are immutable once created — renames only change the display name —
    // so deal references and automation filters never silently break.
    // Fall back to the workspace's first stage when a payload names an unknown one.
    const validStage = (w: number, s: any): string => {
      const slugs = stageSlugs(db, w);
      return typeof s === "string" && slugs.includes(s) ? s : slugs[0] || "prospecting";
    };
    const stageRow = (w: number, slug: string) =>
      db.query("SELECT slug, name, position, color FROM stages WHERE workspace_id = ? AND slug = ?").get(w, slug) as any;
    const stageDeals = (w: number, slug: string) =>
      (db.query("SELECT COUNT(*) n FROM deals WHERE workspace_id = ? AND stage = ?").get(w, slug) as any).n;
    if (path === "/api/stages" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      seedStages(db, w);
      const stages = workspaceStages(db, w).map((s) => ({ ...s, deals: stageDeals(w, s.slug) }));
      return json({ stages });
    }
    if (path === "/api/stages" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const name = String(b.name || "").trim();
      if (!name) return json({ error: "name is required" }, 400);
      const slug = slugifyStage(name);
      if (!slug) return json({ error: `name "${name}" produces no usable slug` }, 400);
      seedStages(db, w);
      if (stageRow(w, slug)) return json({ error: `stage "${slug}" already exists` }, 409);
      const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || "")) ? b.color : "#579bfc";
      const order = workspaceStages(db, w).map((s) => s.slug);
      let at = order.length; // default: append
      for (const key of ["before", "after"] as const) {
        const ref = String(b[key] || "").trim();
        if (ref) {
          const i = order.indexOf(ref);
          if (i < 0) return json({ error: `unknown stage "${ref}"` }, 400);
          at = key === "before" ? i : i + 1;
        }
      }
      db.prepare("INSERT INTO stages (workspace_id, slug, name, position, color) VALUES (?, ?, ?, ?, ?)")
        .run(w, slug, name, at, color);
      // renumber with the new stage spliced into place
      order.splice(at, 0, slug);
      const upd = db.prepare("UPDATE stages SET position = ? WHERE workspace_id = ? AND slug = ?");
      order.forEach((s, i) => upd.run(i, w, s));
      logActivity("deal", `stage "${name}" added`, w);
      return json({ stage: stageRow(w, slug) }, 201);
    }
    const stageRec = path.match(/^\/api\/stages\/([a-z0-9_]+)$/);
    if (stageRec && (method === "PATCH" || method === "DELETE")) {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      seedStages(db, w);
      const slug = stageRec[1];
      const cur = stageRow(w, slug);
      if (!cur) return json({ error: `unknown stage "${slug}"` }, 404);
      const b = method === "PATCH" ? await readBody(req) : {};
      const moveTo = method === "DELETE"
        ? String(url.searchParams.get("move_to") || b.move_to || "").trim()
        : "";
      if (method === "DELETE") {
        const n = stageDeals(w, slug);
        const total = workspaceStages(db, w).length;
        if (total <= 1) return json({ error: "cannot delete the last stage" }, 400);
        if (n > 0 && !moveTo) {
          return json(
            { error: `stage "${cur.name}" holds ${n} deal(s) — pass move_to with a target stage slug to relocate them`, deals: n },
            409
          );
        }
        if (moveTo) {
          if (moveTo === slug) return json({ error: "move_to must be a different stage" }, 400);
          if (!stageRow(w, moveTo)) return json({ error: `unknown stage "${moveTo}"` }, 400);
          db.prepare("UPDATE deals SET stage = ? WHERE workspace_id = ? AND stage = ?").run(moveTo, w, slug);
        }
        db.prepare("DELETE FROM stages WHERE workspace_id = ? AND slug = ?").run(w, slug);
        renumberStages(db, w);
        logActivity("deal", `stage "${cur.name}" deleted${moveTo ? `, ${n} deal(s) moved` : ""}`, w);
        return json({ ok: true, moved: moveTo ? n : 0 });
      }
      // PATCH
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.name !== undefined && String(b.name).trim()) {
        sets.push("name = ?");
        vals.push(String(b.name).trim());
      }
      if (b.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(String(b.color))) {
        sets.push("color = ?");
        vals.push(b.color);
      }
      let moved: string | null = null;
      for (const key of ["before", "after"] as const) {
        const ref = String(b[key] || "").trim();
        if (ref) {
          if (ref === slug) return json({ error: `cannot move a stage ${key} itself` }, 400);
          if (!stageRow(w, ref)) return json({ error: `unknown stage "${ref}"` }, 400);
          moved = key + ":" + ref;
        }
      }
      if (typeof b.position === "number" && Number.isInteger(b.position)) {
        moved = "pos:" + b.position;
      }
      if (sets.length) {
        db.prepare(`UPDATE stages SET ${sets.join(", ")} WHERE workspace_id = ? AND slug = ?`).run(...vals, w, slug);
      }
      if (moved) {
        const order = workspaceStages(db, w).map((s) => s.slug).filter((s) => s !== slug);
        let at: number;
        if (moved.startsWith("before:")) at = order.indexOf(moved.slice(7));
        else if (moved.startsWith("after:")) at = order.indexOf(moved.slice(6)) + 1;
        else at = Math.max(0, Math.min(order.length, Number(moved.slice(4))));
        order.splice(at, 0, slug);
        const upd = db.prepare("UPDATE stages SET position = ? WHERE workspace_id = ? AND slug = ?");
        order.forEach((s, i) => upd.run(i, w, s));
      }
      return json({ stage: stageRow(w, slug) });
    }

    // ---- KPIs
    if (path === "/api/kpis" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const open = db
        .query(
          `SELECT COUNT(*) n, COALESCE(SUM(value),0) v,
                  COALESCE(SUM(value * probability / 100.0),0) w
           FROM deals WHERE workspace_id = ? AND stage NOT IN ('closed_won','closed_lost')`
        )
        .get(w) as any;
      const wonQ = db
        .query(
          `SELECT COALESCE(SUM(value),0) v FROM deals
           WHERE workspace_id = ? AND stage = 'closed_won' AND expected_close >= '2026-07-01'`
        )
        .get(w) as any;
      const byStage = db
        .query(
          `SELECT stage, COUNT(*) n, COALESCE(SUM(value),0) v FROM deals
           WHERE workspace_id = ? GROUP BY stage`
        )
        .all(w) as any[];
      const tasksOpen = (
        db.query("SELECT COUNT(*) n FROM tasks WHERE workspace_id = ? AND done = 0").get(w) as any
      ).n;
      return json({
        open_deals: open.n,
        pipeline_value: Math.round(open.v),
        weighted_value: Math.round(open.w),
        won_this_quarter: Math.round(wonQ.v),
        tasks_open: tasksOpen,
        by_stage: byStage,
      });
    }

    // ---- deals
    if (path === "/api/deals" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const campId = url.searchParams.get("campaign_id");
      const rows = db
        .query(
          `SELECT d.*, c.name AS company_name, ct.name AS contact_name
           FROM deals d
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN contacts ct ON ct.id = d.contact_id
           WHERE d.workspace_id = ?${campId ? " AND d.campaign_id = ?" : ""}
           ORDER BY d.updated_at DESC`
        )
        .all(w, ...(campId ? [Number(campId)] : []));
      const wsStages = workspaceStages(db, w);
      const labels: Record<string, string> = {};
      for (const s of wsStages) labels[s.slug] = s.name;
      return json({ deals: rows, stages: wsStages.map((s) => s.slug), labels });
    }
    if (path === "/api/deals" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const campaignId = resolveCampaign(w, b.campaign_id);
      if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
      const r = db
        .prepare(
          `INSERT INTO deals (title, company_id, contact_id, value, stage,
           probability, expected_close, owner, campaign_id, workspace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          b.title || "Untitled deal",
          b.company_id || null,
          b.contact_id || null,
          Number(b.value || 0),
          validStage(w, b.stage),
          Number(b.probability ?? 10),
          b.expected_close || "",
          b.owner || "",
          campaignId,
          w
        );
      const deal = dealJson(Number(r.lastInsertRowid), w);
      logActivity("deal", `${(deal as any).title} created`, w);
      fireWebhooks("deal.created", deal as any, w);
      return json({ deal }, 201);
    }
    const dealId = path.match(/^\/api\/deals\/(\d+)$/);
    if (dealId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const before = dealJson(Number(dealId[1]), w) as any;
      if (!before) return json({ error: "not found" }, 404);
      if (b.stage !== undefined && !stageSlugs(db, w).includes(b.stage)) {
        return json({ error: `unknown stage "${b.stage}"` }, 400);
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["title", "value", "stage", "probability", "expected_close", "owner", "company_id", "contact_id"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(b[k]);
        }
      }
      if (b.campaign_id !== undefined) {
        const campaignId = resolveCampaign(w, b.campaign_id);
        if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
        sets.push("campaign_id = ?");
        vals.push(campaignId);
      }
      if (sets.length) {
        sets.push("updated_at = datetime('now')");
        db.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(dealId[1]));
      }
      const after = dealJson(Number(dealId[1]), w) as any;
      if (before.stage !== after.stage) {
        const stageName = (db.query("SELECT name FROM stages WHERE workspace_id = ? AND slug = ?").get(w, after.stage) as any)?.name || after.stage;
        logActivity("deal", `${after.title} moved to ${stageName}`, w);
        fireWebhooks("deal.stage_changed", {
          ...after,
          previous_stage: before.stage,
        }, w);
      } else {
        fireWebhooks("deal.updated", after, w);
      }
      return json({ deal: after });
    }
    if (dealId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const exists = db
        .query("SELECT id FROM deals WHERE id = ? AND workspace_id = ?")
        .get(Number(dealId[1]), w);
      if (!exists) return json({ error: "not found" }, 404);
      db.prepare("DELETE FROM deals WHERE id = ?").run(Number(dealId[1]));
      return json({ ok: true });
    }

    // ---- contacts
    if (path === "/api/contacts" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const q = url.searchParams.get("q") || "";
      const campId = url.searchParams.get("campaign_id");
      const rows = attachCustom(
        "contact",
        db
          .query(
            `SELECT ct.*, c.name AS company_name FROM contacts ct
             LEFT JOIN companies c ON c.id = ct.company_id
             WHERE ct.workspace_id = ? AND (ct.name LIKE ? OR ct.email LIKE ?)
             ${campId ? "AND ct.campaign_id = ?" : ""}
             ORDER BY ct.name`
          )
          .all(w, `%${q}%`, `%${q}%`, ...(campId ? [Number(campId)] : [])) as any[]
      );
      return json({ contacts: rows });
    }
    if (path === "/api/contacts" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const campaignId = resolveCampaign(w, b.campaign_id);
      if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
      const r = db
        .prepare(
          "INSERT INTO contacts (company_id, name, title, email, phone, campaign_id, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(b.company_id || null, b.name || "Unnamed", b.title || "", b.email || "", b.phone || "", campaignId, w);
      const id = Number(r.lastInsertRowid);
      saveCustomValues("contact", id, b.custom, w);
      const contact = attachCustom("contact", [
        db.query("SELECT * FROM contacts WHERE id = ?").get(id) as any,
      ])[0];
      fireWebhooks("contact.created", contact as any, w);
      return json({ contact }, 201);
    }

    const contactId = path.match(/^\/api\/contacts\/(\d+)$/);
    if (contactId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const contactExists = db
        .query("SELECT id FROM contacts WHERE id = ? AND workspace_id = ?")
        .get(Number(contactId[1]), w);
      if (!contactExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["company_id", "name", "title", "email", "phone"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(k === "company_id" && b[k] === "" ? null : b[k]);
        }
      }
      if (b.campaign_id !== undefined) {
        const campaignId = resolveCampaign(w, b.campaign_id);
        if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
        sets.push("campaign_id = ?");
        vals.push(campaignId);
      }
      if (sets.length) {
        db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(contactId[1]));
      }
      saveCustomValues("contact", Number(contactId[1]), b.custom, w);
      const updatedContact = attachCustom("contact", [
        db.query("SELECT * FROM contacts WHERE id = ?").get(Number(contactId[1])) as any,
      ])[0];
      return json({ contact: updatedContact });
    }

    // ---- CSV import: POST { csv: "..." } with header row
    // columns: name, title, company, email, phone (case-insensitive)
    if (path === "/api/contacts/import" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const rows = parseCsv(String(b.csv || ""));
      if (!rows.length) return json({ error: "empty CSV" }, 400);
      const header = rows[0].map((h) => h.trim().toLowerCase());
      const col = (...names: string[]) => {
        for (const n of names) {
          const i = header.indexOf(n);
          if (i >= 0) return i;
        }
        return -1;
      };
      const iName = col("name", "full name", "contact", "contact name");
      if (iName < 0) return json({ error: 'CSV needs a "name" column' }, 400);
      const iTitle = col("title", "job title", "role", "position");
      const iCompany = col("company", "company name", "organization", "organisation");
      const iEmail = col("email", "e-mail", "email address");
      const iPhone = col("phone", "phone number", "tel", "mobile");

      const companyCache = new Map<string, number>();
      const companyIdFor = (name: string): number | null => {
        const key = name.trim().toLowerCase();
        if (!key) return null;
        const hit = companyCache.get(key);
        if (hit !== undefined) return hit;
        const existing = db
          .query("SELECT id FROM companies WHERE lower(name) = ? AND workspace_id = ?")
          .get(key, w) as any;
        const id = existing
          ? existing.id
          : Number(db.prepare("INSERT INTO companies (name, workspace_id) VALUES (?, ?)").run(name.trim(), w).lastInsertRowid);
        companyCache.set(key, id);
        return id;
      };

      let imported = 0;
      let skipped = 0;
      const errors: string[] = [];
      rows.slice(1).forEach((r, n) => {
        const line = n + 2;
        const name = (r[iName] || "").trim();
        if (!name) { skipped++; return; }
        const email = iEmail >= 0 ? (r[iEmail] || "").trim() : "";
        if (email) {
          const dup = db
            .query("SELECT id FROM contacts WHERE lower(email) = ? AND workspace_id = ?")
            .get(email.toLowerCase(), w) as any;
          if (dup) { skipped++; return; }
        }
        try {
          db.prepare(
            "INSERT INTO contacts (company_id, name, title, email, phone, workspace_id) VALUES (?, ?, ?, ?, ?, ?)"
          ).run(
            iCompany >= 0 ? companyIdFor(r[iCompany] || "") : null,
            name,
            iTitle >= 0 ? (r[iTitle] || "").trim() : "",
            email,
            iPhone >= 0 ? (r[iPhone] || "").trim() : "",
            w
          );
          imported++;
        } catch (e) {
          errors.push(`Row ${line}: ${(e as Error).message}`);
        }
      });
      // bulk imports intentionally don't fire outgoing webhooks
      logActivity("contact", `Imported ${imported} contact${imported === 1 ? "" : "s"} from CSV`, w);
      return json({ imported, skipped, errors: errors.slice(0, 10) });
    }
    if (path === "/api/contacts/import/template" && method === "GET") {
      return new Response(
        'name,title,company,email,phone\n"Jane Doe","VP Sales","Acme Inc","jane@acme.com","555-0100"\n',
        {
          headers: {
            "Content-Type": "text/csv",
            "Content-Disposition": 'attachment; filename="contacts-template.csv"',
          },
        }
      );
    }

    // ---- data sandbox: staged mass contact imports ---------------------------------
    // Nothing here touches the live contacts table until a batch is committed.
    // Every row is deduplicated (vs existing contacts + within the batch) and
    // flagged for obviously problematic data points before review.
    const sbNormEmail = (e: string) => String(e || "").trim().toLowerCase();
    const sbNormName = (n: string) =>
      String(n || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    function sbLevenshtein(a: string, b: string): number {
      if (a === b) return 0;
      const m = a.length, n = b.length;
      if (!m) return n; if (!n) return m;
      let prev = Array.from({ length: n + 1 }, (_, i) => i);
      for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
          cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
      }
      return prev[n];
    }
    // Two names match when they are identical after normalization, share the
    // same first + last token (middle names/initials ignored), or differ by a
    // small typo (edit distance <= 2).
    function sbNamesMatch(a: string, b: string): boolean {
      const na = sbNormName(a), nb = sbNormName(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      const ta = na.split(" "), tb = nb.split(" ");
      if (ta.length > 1 && tb.length > 1 && ta[0] === tb[0] && ta[ta.length - 1] === tb[tb.length - 1]) return true;
      if (Math.abs(na.length - nb.length) <= 2 && sbLevenshtein(na, nb) <= 2) return true;
      return false;
    }
    type SbFlag = { code: string; reason: string };
    function sbFlagRow(r: { name: string; title: string; email: string; phone: string; company: string; notes: string }): SbFlag[] {
      const flags: SbFlag[] = [];
      const name = String(r.name || "").trim();
      const email = String(r.email || "").trim();
      const phone = String(r.phone || "").trim();
      if (!name) flags.push({ code: "missing-name", reason: "No name — this row needs a name before it can be imported." });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        flags.push({ code: "bad-email", reason: `"${email}" is not a valid email address.` });
      }
      if (phone) {
        const digits = phone.replace(/\D/g, "");
        if (/[a-zA-Z]/.test(phone) || digits.length < 7) {
          flags.push({ code: "bad-phone", reason: `"${phone}" is not a valid phone number.` });
        }
      }
      const junkRe = /^(test|tests|testing|asdf+|qwerty+|xxx+|lorem|ipsum|foo|bar|baz|n\/a|na|none|null|undefined|tbd|todo|sample|example|demo)$/i;
      const repeatedRe = /^(.)\1{3,}$/;
      for (const [label, v] of [["name", name], ["title", r.title], ["company", r.company]] as [string, string][]) {
        const t = String(v || "").trim();
        const compact = t.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (t && (junkRe.test(t) || (compact.length >= 4 && repeatedRe.test(compact)))) {
          flags.push({ code: "junk", reason: `${label} "${t}" looks like junk data.` });
        }
      }
      if (name.length > 3 && /[A-Z]/.test(name) && name === name.toUpperCase()) {
        flags.push({ code: "all-caps", reason: "Name is ALL CAPS — probably a formatting glitch." });
      }
      if (name.length > 3 && /[a-z]/.test(name) && !/[A-Z]/.test(name)) {
        flags.push({ code: "no-caps", reason: "Name has no capital letters — may need cleanup." });
      }
      for (const [label, v, max] of [["name", name, 120], ["title", r.title, 120], ["email", email, 200], ["phone", phone, 60], ["company", r.company, 160], ["notes", r.notes, 2000]] as [string, string, number][]) {
        const t = String(v || "").trim();
        if (t.length > max) flags.push({ code: "too-long", reason: `${label} is unusually long (${t.length} characters).` });
      }
      return flags;
    }
    // Recompute status / dup links / flags for every row of a batch.
    function sbAnalyzeBatch(batchId: number, w: number): void {
      const rows = db
        .query("SELECT * FROM sandbox_rows WHERE batch_id = ? AND workspace_id = ? ORDER BY row_num, id")
        .all(batchId, w) as any[];
      const existing = db
        .query("SELECT id, name, email FROM contacts WHERE workspace_id = ?")
        .all(w) as any[];
      const upd = db.prepare(
        "UPDATE sandbox_rows SET status = ?, dup_of_contact_id = ?, dup_of_row_id = ?, flags = ? WHERE id = ?"
      );
      const seen: any[] = [];
      for (const r of rows) {
        const email = sbNormEmail(r.email);
        let dupContact: any = null;
        let dupRow: any = null;
        if (email) {
          dupContact = existing.find((c: any) => sbNormEmail(c.email) === email) || null;
          if (!dupContact) dupRow = seen.find((s: any) => sbNormEmail(s.email) === email) || null;
        }
        if (!dupContact && !dupRow) {
          dupContact = existing.find((c: any) => sbNamesMatch(c.name, r.name)) || null;
          if (!dupContact) dupRow = seen.find((s: any) => sbNamesMatch(s.name, r.name)) || null;
        }
        const flags = sbFlagRow(r).concat(JSON.parse(r.extra_flags || "[]"));
        const status = dupContact || dupRow ? "duplicate" : flags.length ? "flagged" : "clean";
        upd.run(status, dupContact ? dupContact.id : 0, dupRow ? dupRow.id : 0, JSON.stringify(flags), r.id);
        seen.push(r);
      }
      const n = (db.query("SELECT COUNT(*) n FROM sandbox_rows WHERE batch_id = ?").get(batchId) as any).n;
      db.prepare("UPDATE sandbox_batches SET row_count = ? WHERE id = ?").run(n, batchId);
    }
    function sbBatchOr404(id: number, w: number): any {
      return (db.query("SELECT * FROM sandbox_batches WHERE id = ? AND workspace_id = ?").get(id, w) as any) || null;
    }
    function sbSummary(batchId: number): Record<string, number> {
      const rows = db.query("SELECT status, decision FROM sandbox_rows WHERE batch_id = ?").all(batchId) as any[];
      const s: Record<string, number> = { total: rows.length, clean: 0, duplicates: 0, flagged: 0, approved: 0, rejected: 0, pending: 0 };
      for (const r of rows) {
        if (r.status === "clean") s.clean++;
        else if (r.status === "duplicate") s.duplicates++;
        else if (r.status === "flagged") s.flagged++;
        if (r.decision === "approved") s.approved++;
        else if (r.decision === "rejected") s.rejected++;
        else s.pending++;
      }
      return s;
    }
    // POST /api/sandbox/batches { name?, filename?, csv } — stage a CSV import
    // or { name?, filename?, vcf } — stage a vCard (.vcf) import. The filename
    // may also carry the .vcf extension with the payload in `csv` (robustness).
    if (path === "/api/sandbox/batches" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const rawCsv = String(b.csv || "");
      const rawVcf = String(b.vcf || "");
      const fname = String(b.filename || "");
      const wantVcf = rawVcf.length > 0 || (/\.vcf$/i.test(fname) && /^\s*BEGIN:VCARD/mi.test(rawCsv));
      const raw = wantVcf ? (rawVcf || rawCsv) : rawCsv;
      if (!raw) return json({ error: "empty upload" }, 400);
      if (raw.length > 5 * 1024 * 1024) return json({ error: `${wantVcf ? "VCF" : "CSV"} is too large (5 MB max)` }, 400);
      const warnings: string[] = [];
      if (raw.includes("�")) warnings.push("Some characters could not be decoded — check the file encoding (UTF-8 works best).");
      let staged: { name: string; title: string; email: string; phone: string; company: string; notes: string; extraFlags: SbFlag[] }[];
      if (wantVcf) {
        staged = parseVcf(raw);
        if (!staged.length) return json({ error: "no vCards found in this file" }, 400);
        if (staged.length > 5000) return json({ error: "too many vCards (5,000 max per batch)" }, 400);
      } else {
        const firstLine = raw.split(/\r?\n/, 1)[0] || "";
        if (firstLine && !firstLine.includes(",") && (firstLine.includes(";") || firstLine.includes("\t"))) {
          return json({ error: "This looks like a semicolon/tab-delimited file — please export it as comma-separated CSV and try again." }, 400);
        }
        const rows = parseCsv(raw);
        if (!rows.length) return json({ error: "empty CSV" }, 400);
        if (rows.length - 1 > 5000) return json({ error: "too many rows (5,000 max per batch)" }, 400);
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const col = (...names: string[]) => {
          for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; }
          return -1;
        };
        const iName = col("name", "full name", "contact", "contact name", "fullname");
        const iTitle = col("title", "job title", "role", "position");
        const iCompany = col("company", "company name", "organization", "organisation");
        const iEmail = col("email", "e-mail", "email address");
        const iPhone = col("phone", "phone number", "tel", "mobile", "cell");
        const iNotes = col("notes", "note", "comments", "comment", "memo");
        const cell = (r: string[], i: number) => (i >= 0 ? (r[i] || "").trim() : "");
        staged = rows.slice(1).map((r) => ({
          name: cell(r, iName), title: cell(r, iTitle), email: cell(r, iEmail),
          phone: cell(r, iPhone), company: cell(r, iCompany), notes: cell(r, iNotes),
          extraFlags: [] as SbFlag[],
        }));
      }
      const name = String(b.name || "").trim() || `Import ${new Date().toISOString().slice(0, 10)}`;
      const batchId = Number(
        db.prepare("INSERT INTO sandbox_batches (workspace_id, name, filename, source) VALUES (?, ?, ?, ?)")
          .run(w, name, fname.slice(0, 200), wantVcf ? "vcf" : "csv").lastInsertRowid
      );
      const ins = db.prepare(
        "INSERT INTO sandbox_rows (batch_id, workspace_id, row_num, name, title, email, phone, company, notes, extra_flags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );
      staged.forEach((s, n) => {
        ins.run(batchId, w, n + 1, s.name, s.title, s.email, s.phone, s.company, s.notes, JSON.stringify(s.extraFlags || []));
      });
      sbAnalyzeBatch(batchId, w);
      const batch = db.query("SELECT * FROM sandbox_batches WHERE id = ?").get(batchId);
      return json({ batch, summary: sbSummary(batchId), warnings }, 201);
    }
    // GET /api/sandbox/batches — list batches with summaries
    if (path === "/api/sandbox/batches" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const batches = db
        .query("SELECT * FROM sandbox_batches WHERE workspace_id = ? ORDER BY id DESC")
        .all(w) as any[];
      return json({ batches: batches.map((x: any) => ({ ...x, summary: sbSummary(x.id) })) });
    }
    const sbBatchId = path.match(/^\/api\/sandbox\/batches\/(\d+)$/);
    // GET /api/sandbox/batches/:id — batch + rows (dup links resolved)
    if (sbBatchId && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const batch = sbBatchOr404(Number(sbBatchId[1]), w);
      if (!batch) return json({ error: "not found" }, 404);
      const rows = db
        .query("SELECT * FROM sandbox_rows WHERE batch_id = ? AND workspace_id = ? ORDER BY row_num, id")
        .all(batch.id, w) as any[];
      const contactIds = rows.map((r: any) => r.dup_of_contact_id).filter((x: number) => x > 0);
      const rowIds = rows.map((r: any) => r.dup_of_row_id).filter((x: number) => x > 0);
      const cById = new Map<number, any>();
      if (contactIds.length) {
        for (const c of db.query(`SELECT id, name, email FROM contacts WHERE id IN (${contactIds.map(() => "?").join(",")})`).all(...contactIds) as any[]) cById.set(c.id, c);
      }
      const rById = new Map<number, any>();
      if (rowIds.length) {
        for (const r of db.query(`SELECT id, row_num, name, email FROM sandbox_rows WHERE id IN (${rowIds.map(() => "?").join(",")})`).all(...rowIds) as any[]) rById.set(r.id, r);
      }
      return json({
        batch: { ...batch, summary: sbSummary(batch.id) },
        rows: rows.map((r: any) => ({
          ...r,
          flags: JSON.parse(r.flags || "[]"),
          dup_contact: r.dup_of_contact_id ? cById.get(r.dup_of_contact_id) || null : null,
          dup_row: r.dup_of_row_id ? rById.get(r.dup_of_row_id) || null : null,
        })),
      });
    }
    // DELETE /api/sandbox/batches/:id — delete staged rows + batch; never live contacts
    if (sbBatchId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const batch = sbBatchOr404(Number(sbBatchId[1]), w);
      if (!batch) return json({ error: "not found" }, 404);
      const n = (db.query("SELECT COUNT(*) n FROM sandbox_rows WHERE batch_id = ?").get(batch.id) as any).n;
      db.prepare("DELETE FROM sandbox_rows WHERE batch_id = ?").run(batch.id);
      db.prepare("DELETE FROM sandbox_batches WHERE id = ?").run(batch.id);
      return json({ ok: true, deleted_rows: n });
    }
    // POST /api/sandbox/batches/:id/decision { action } — bulk approve-clean / reject-duplicates
    const sbDecision = path.match(/^\/api\/sandbox\/batches\/(\d+)\/decision$/);
    if (sbDecision && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const batch = sbBatchOr404(Number(sbDecision[1]), w);
      if (!batch) return json({ error: "not found" }, 404);
      if (batch.status !== "open") return json({ error: "batch is already complete" }, 400);
      const b = await readBody(req);
      let changed = 0;
      if (b.action === "approve-clean") {
        changed = Number(db.prepare("UPDATE sandbox_rows SET decision = 'approved' WHERE batch_id = ? AND workspace_id = ? AND status = 'clean' AND decision = 'pending'").run(batch.id, w).changes);
      } else if (b.action === "reject-duplicates") {
        // Also rejects vCard rows flagged unusable (no name and no email) —
        // there is nothing worth importing in them.
        changed = Number(db.prepare(
          "UPDATE sandbox_rows SET decision = 'rejected' WHERE batch_id = ? AND workspace_id = ? AND decision = 'pending' AND (status = 'duplicate' OR flags LIKE '%\"code\":\"unusable\"%')"
        ).run(batch.id, w).changes);
      } else {
        return json({ error: 'unknown action (use "approve-clean" or "reject-duplicates")' }, 400);
      }
      return json({ ok: true, changed, summary: sbSummary(batch.id) });
    }
    // POST /api/sandbox/batches/:id/commit — import approved, non-duplicate rows
    const sbCommit = path.match(/^\/api\/sandbox\/batches\/(\d+)\/commit$/);
    if (sbCommit && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const batch = sbBatchOr404(Number(sbCommit[1]), w);
      if (!batch) return json({ error: "not found" }, 404);
      if (batch.status !== "open") return json({ error: "batch is already complete" }, 400);
      const rows = db
        .query("SELECT * FROM sandbox_rows WHERE batch_id = ? AND workspace_id = ? AND decision = 'approved' ORDER BY row_num, id")
        .all(batch.id, w) as any[];
      const companyCache = new Map<string, number>();
      const companyIdFor = (nm: string): number | null => {
        const key = nm.trim().toLowerCase();
        if (!key) return null;
        const hit = companyCache.get(key);
        if (hit !== undefined) return hit;
        const existing = db.query("SELECT id FROM companies WHERE lower(name) = ? AND workspace_id = ?").get(key, w) as any;
        const id = existing ? existing.id : Number(db.prepare("INSERT INTO companies (name, workspace_id) VALUES (?, ?)").run(nm.trim(), w).lastInsertRowid);
        companyCache.set(key, id);
        return id;
      };
      let imported = 0, skipped = 0;
      const ins = db.prepare("INSERT INTO contacts (company_id, name, title, email, phone, workspace_id) VALUES (?, ?, ?, ?, ?, ?)");
      for (const r of rows) {
        if (r.status === "duplicate") { skipped++; continue; }
        ins.run(companyIdFor(r.company || ""), r.name || "Unnamed", r.title || "", r.email || "", r.phone || "", w);
        imported++;
      }
      db.prepare("UPDATE sandbox_batches SET status = 'complete', completed_at = datetime('now') WHERE id = ?").run(batch.id);
      // bulk commits intentionally don't fire outgoing webhooks
      logActivity("contact", `Sandbox import "${batch.name}": ${imported} contact${imported === 1 ? "" : "s"} imported, ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped`, w);
      return json({ ok: true, imported, skipped, summary: sbSummary(batch.id) });
    }
    // PATCH /api/sandbox/rows/:id — edit fields (re-analyzes the batch) or set decision
    const sbRowId = path.match(/^\/api\/sandbox\/rows\/(\d+)$/);
    if (sbRowId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const row = db.query("SELECT * FROM sandbox_rows WHERE id = ? AND workspace_id = ?").get(Number(sbRowId[1]), w) as any;
      if (!row) return json({ error: "not found" }, 404);
      const batch = sbBatchOr404(row.batch_id, w);
      if (!batch) return json({ error: "batch not found" }, 404);
      if (batch.status !== "open") return json({ error: "batch is already complete" }, 400);
      const b = await readBody(req);
      if (b.decision !== undefined) {
        if (!["pending", "approved", "rejected"].includes(b.decision)) return json({ error: "bad decision" }, 400);
        db.prepare("UPDATE sandbox_rows SET decision = ? WHERE id = ?").run(b.decision, row.id);
      }
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["name", "title", "email", "phone", "company", "notes"]) {
        if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(String(b[k]).trim()); }
      }
      if (sets.length) {
        db.prepare(`UPDATE sandbox_rows SET ${sets.join(", ")} WHERE id = ?`).run(...vals, row.id);
        sbAnalyzeBatch(row.batch_id, w);
      }
      const updated = db.query("SELECT * FROM sandbox_rows WHERE id = ?").get(row.id);
      return json({ row: updated, summary: sbSummary(row.batch_id) });
    }

    // ---- companies
    if (path === "/api/companies" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const campId = url.searchParams.get("campaign_id");
      const rows = attachCustom(
        "company",
        db
          .query(
            `SELECT c.*, COUNT(d.id) AS deal_count,
                    COALESCE(SUM(CASE WHEN d.stage NOT IN ('closed_won','closed_lost') THEN d.value ELSE 0 END),0) AS open_value
             FROM companies c LEFT JOIN deals d ON d.company_id = c.id AND d.workspace_id = c.workspace_id
             WHERE c.workspace_id = ?${campId ? " AND c.campaign_id = ?" : ""}
             GROUP BY c.id ORDER BY open_value DESC`
          )
          .all(w, ...(campId ? [Number(campId)] : [])) as any[]
      );
      return json({ companies: rows });
    }
    if (path === "/api/companies" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const campaignId = resolveCampaign(w, b.campaign_id);
      if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
      const r = db
        .prepare("INSERT INTO companies (name, industry, website, campaign_id, workspace_id) VALUES (?, ?, ?, ?, ?)")
        .run(b.name || "Unnamed", b.industry || "", b.website || "", campaignId, w);
      const id = Number(r.lastInsertRowid);
      saveCustomValues("company", id, b.custom, w);
      const company = attachCustom("company", [
        db.query("SELECT * FROM companies WHERE id = ?").get(id) as any,
      ])[0];
      return json({ company }, 201);
    }

    const companyId = path.match(/^\/api\/companies\/(\d+)$/);
    if (companyId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const companyExists = db
        .query("SELECT id FROM companies WHERE id = ? AND workspace_id = ?")
        .get(Number(companyId[1]), w);
      if (!companyExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["name", "industry", "website"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(b[k]);
        }
      }
      if (b.campaign_id !== undefined) {
        const campaignId = resolveCampaign(w, b.campaign_id);
        if (campaignId === false) return json({ error: "unknown campaign_id" }, 400);
        sets.push("campaign_id = ?");
        vals.push(campaignId);
      }
      if (sets.length) {
        db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(companyId[1]));
      }
      saveCustomValues("company", Number(companyId[1]), b.custom, w);
      const updatedCompany = attachCustom("company", [
        db.query("SELECT * FROM companies WHERE id = ?").get(Number(companyId[1])) as any,
      ])[0];
      return json({ company: updatedCompany });
    }

    // ---- tasks
    if (path === "/api/tasks" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const cid = url.searchParams.get("campaign_id");
      let q = `SELECT t.*, d.title AS deal_title FROM tasks t
             LEFT JOIN deals d ON d.id = t.deal_id`;
      const params: unknown[] = [w];
      q += cid ? ` WHERE t.workspace_id = ? AND t.campaign_id = ?` : ` WHERE t.workspace_id = ?`;
      if (cid) params.push(Number(cid));
      q += ` ORDER BY t.done, t.due_date`;
      const rows = attachCustom("task", db.query(q).all(...params) as any[]);
      return json({ tasks: rows });
    }
    if (path === "/api/tasks" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO tasks (title, deal_id, campaign_id, due_date, owner, workspace_id) VALUES (?, ?, ?, ?, ?, ?)")
        .run(b.title || "Untitled task", b.deal_id || null, b.campaign_id || null, b.due_date || "", b.owner || "", w);
      const id = Number(r.lastInsertRowid);
      saveCustomValues("task", id, b.custom, w);
      const task = attachCustom("task", [
        db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any,
      ])[0];
      fireWebhooks("task.created", task as any, w);
      return json({ task }, 201);
    }
    const taskId = path.match(/^\/api\/tasks\/(\d+)$/);
    if (taskId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const taskExists = db
        .query("SELECT id FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(Number(taskId[1]), w);
      if (!taskExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["title", "deal_id", "campaign_id", "due_date", "owner"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push((k === "deal_id" || k === "campaign_id") && b[k] === "" ? null : b[k]);
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(taskId[1]));
      }
      saveCustomValues("task", Number(taskId[1]), b.custom, w);
      const updatedTask = attachCustom("task", [
        db.query("SELECT * FROM tasks WHERE id = ?").get(Number(taskId[1])) as any,
      ])[0];
      return json({ task: updatedTask });
    }
    if (taskId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const t = db
        .query("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(Number(taskId[1]), w) as any;
      if (t) {
        db.prepare("DELETE FROM custom_values WHERE entity = 'task' AND record_id = ?").run(t.id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
        fireWebhooks("task.deleted", { id: t.id, title: t.title, workspace_id: w }, w);
      } else {
        return json({ error: "not found" }, 404);
      }
      return json({ ok: true });
    }
    const taskToggle = path.match(/^\/api\/tasks\/(\d+)\/toggle$/);
    if (taskToggle && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const t = db
        .query("SELECT * FROM tasks WHERE id = ? AND workspace_id = ?")
        .get(Number(taskToggle[1]), w) as any;
      if (!t) return json({ error: "not found" }, 404);
      db.prepare("UPDATE tasks SET done = ? WHERE id = ?").run(t.done ? 0 : 1, t.id);
      const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(t.id);
      if (!t.done) {
        logActivity("task", `Completed: ${t.title}`, w);
        fireWebhooks("task.completed", updated as any, w);
      }
      return json({ task: updated });
    }

    // ---- captures: business-card / client-note photos
    if (path === "/api/captures" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const rows = db
        .query(
          `SELECT c.*, ct.name AS contact_name FROM captures c
           LEFT JOIN contacts ct ON ct.id = c.contact_id
           WHERE c.workspace_id = ?
           ORDER BY c.id DESC`
        )
        .all(w);
      return json({ captures: rows });
    }
    if (path === "/api/captures" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "expected multipart form data" }, 400);
      }
      const files = form.getAll("photos").filter((f) => f instanceof File) as File[];
      if (!files.length) return json({ error: "no photos uploaded" }, 400);
      const saved: any[] = [];
      const errors: string[] = [];
      for (const file of files) {
        if (!file.type.startsWith("image/")) {
          errors.push(`${file.name || "file"}: not an image`);
          continue;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          errors.push(`${file.name || "file"}: over 12 MB`);
          continue;
        }
        const filename = `${crypto.randomUUID().replace(/-/g, "")}${extFor(file.type, file.name)}`;
        try {
          await Bun.write(`${UPLOAD_DIR}/${filename}`, file);
        } catch (e) {
          errors.push(`${file.name || "file"}: ${(e as Error).message}`);
          continue;
        }
        const r = db
          .prepare(
            "INSERT INTO captures (filename, original_name, mime, size, workspace_id) VALUES (?, ?, ?, ?, ?)"
          )
          .run(filename, file.name || "", file.type, file.size, w);
        saved.push(
          db.query("SELECT * FROM captures WHERE id = ?").get(Number(r.lastInsertRowid))
        );
      }
      if (saved.length) {
        logActivity(
          "note",
          `Captured ${saved.length} photo${saved.length === 1 ? "" : "s"} (business card / notes)`,
          w
        );
      }
      return json({ captures: saved, errors }, 201);
    }
    const captureId = path.match(/^\/api\/captures\/(\d+)$/);
    if (captureId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const capExists = db
        .query("SELECT id FROM captures WHERE id = ? AND workspace_id = ?")
        .get(Number(captureId[1]), w);
      if (!capExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.note !== undefined) {
        sets.push("note = ?");
        vals.push(b.note);
      }
      if (b.contact_id !== undefined) {
        sets.push("contact_id = ?");
        vals.push(b.contact_id === "" || b.contact_id === null ? null : Number(b.contact_id));
      }
      if (sets.length) {
        db.prepare(`UPDATE captures SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(captureId[1]));
      }
      return json({
        capture: db
          .query(
            `SELECT c.*, ct.name AS contact_name FROM captures c
             LEFT JOIN contacts ct ON ct.id = c.contact_id WHERE c.id = ?`
          )
          .get(Number(captureId[1])),
      });
    }
    if (captureId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const row = db
        .query("SELECT * FROM captures WHERE id = ? AND workspace_id = ?")
        .get(Number(captureId[1]), w) as any;
      if (row) {
        try {
          await Bun.$`rm -f ${UPLOAD_DIR}/${row.filename}`.quiet();
        } catch {}
        db.prepare("DELETE FROM captures WHERE id = ?").run(row.id);
      }
      return json({ ok: true });
    }

    // ---- custom fields (schema editor)
    const schemaEntity = path.match(/^\/api\/schema\/([a-z]+)$/);
    if (schemaEntity && CUSTOM_ENTITIES.includes(schemaEntity[1]) && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      return json({ fields: getCustomFields(schemaEntity[1], w) });
    }
    if (schemaEntity && CUSTOM_ENTITIES.includes(schemaEntity[1]) && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const entity = schemaEntity[1];
      const label = String(b.label || "").trim();
      const type = FIELD_TYPES.includes(b.type) ? b.type : "text";
      if (!label) return json({ error: "label is required" }, 400);
      let name = slugify(label);
      if (CORE_COLUMNS[entity].includes(name)) return json({ error: `"${name}" is a built-in field` }, 400);
      let n = 2;
      while (db.query("SELECT id FROM custom_fields WHERE entity = ? AND workspace_id = ? AND name = ?").get(entity, w, name)) {
        name = `${slugify(label)}_${n++}`;
      }
      let options = "[]";
      if (type === "select") {
        const opts = String(b.options || "").split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 30);
        if (!opts.length) return json({ error: "dropdown fields need at least one option" }, 400);
        options = JSON.stringify(opts);
      }
      const pos = (db.query("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM custom_fields WHERE entity = ?").get(entity) as any).p;
      const r = db
        .prepare(
          "INSERT INTO custom_fields (entity, name, label, type, options, required, position, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(entity, name, label, type, options, b.required ? 1 : 0, pos, w);
      logActivity("note", `Added custom field "${label}" to ${entity}s`, w);
      return json({ field: db.query("SELECT * FROM custom_fields WHERE id = ?").get(Number(r.lastInsertRowid)) }, 201);
    }
    const schemaFieldId = path.match(/^\/api\/schema\/fields\/(\d+)$/);
    if (schemaFieldId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const fieldExists = db
        .query("SELECT id FROM custom_fields WHERE id = ? AND workspace_id = ?")
        .get(Number(schemaFieldId[1]), w);
      if (!fieldExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      if (b.label !== undefined && String(b.label).trim()) {
        sets.push("label = ?");
        vals.push(String(b.label).trim());
      }
      if (b.type !== undefined && FIELD_TYPES.includes(b.type)) {
        sets.push("type = ?");
        vals.push(b.type);
        if (b.type !== "select") { sets.push("options = '[]'"); }
      }
      if (b.options !== undefined) {
        const opts = String(b.options).split(",").map((s: string) => s.trim()).filter(Boolean).slice(0, 30);
        sets.push("options = ?");
        vals.push(JSON.stringify(opts));
      }
      if (b.required !== undefined) {
        sets.push("required = ?");
        vals.push(b.required ? 1 : 0);
      }
      if (b.position !== undefined) {
        sets.push("position = ?");
        vals.push(Number(b.position));
      }
      if (sets.length) {
        db.prepare(`UPDATE custom_fields SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(schemaFieldId[1]));
      }
      return json({ field: db.query("SELECT * FROM custom_fields WHERE id = ?").get(Number(schemaFieldId[1])) });
    }
    if (schemaFieldId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const f = db
        .query("SELECT * FROM custom_fields WHERE id = ? AND workspace_id = ?")
        .get(Number(schemaFieldId[1]), w) as any;
      if (f) {
        db.prepare("DELETE FROM custom_values WHERE field_id = ?").run(f.id);
        db.prepare("DELETE FROM custom_fields WHERE id = ?").run(f.id);
        logActivity("note", `Removed custom field "${f.label}" from ${f.entity}s`, w);
      } else {
        return json({ error: "not found" }, 404);
      }
      return json({ ok: true });
    }

    // ---- campaigns
    if (path === "/api/campaigns" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const rows = attachCustom("campaign", db.query(
        `SELECT c.*, co.name AS company_name FROM campaigns c
         LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.workspace_id = ?
         ORDER BY c.created_at DESC`
      ).all(w) as any[]);
      return json({ campaigns: rows });
    }
    if (path === "/api/campaigns" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const companyId = Number(b.company_id) || null;
      const company = companyId
        ? (db.query("SELECT id FROM companies WHERE id = ? AND workspace_id = ?").get(companyId, w) as any)
        : null;
      if (!company) return json({ error: "a valid company_id is required" }, 400);
      const r = db
        .prepare("INSERT INTO campaigns (name, company_id, status, start_date, end_date, budget, notes, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(b.name || "Untitled campaign", companyId, b.status || "draft", b.start_date || "", b.end_date || "",
          Number(b.budget) || 0, b.notes || "", w);
      const id = Number(r.lastInsertRowid);
      saveCustomValues("campaign", id, b.custom, w);
      // autopopulate the standard sales workflow (beginning -> closing)
      const base = b.start_date || new Date().toISOString().slice(0, 10);
      const dueFor = (offset: number) => {
        const d = new Date(base + "T12:00:00");
        d.setDate(d.getDate() + offset);
        return d.toISOString().slice(0, 10);
      };
      const WORKFLOW: [string, number][] = [
        ["Define ICP & target account list", 0],
        ["Build & enrich prospect list", 2],
        ["Launch outreach sequence", 4],
        ["Book discovery calls", 7],
        ["Run discovery & qualify", 10],
        ["Deliver tailored demo", 14],
        ["Send proposal", 17],
        ["Proposal follow-up", 21],
        ["Negotiate terms", 25],
        ["Send contract", 28],
        ["Contract signed", 32],
        ["Handoff to onboarding", 35],
        ["Post-close check-in", 65],
      ];
      const insTask = db.prepare(
        "INSERT INTO tasks (title, campaign_id, due_date, owner, workspace_id) VALUES (?, ?, ?, ?, ?)"
      );
      for (const [title, offset] of WORKFLOW) {
        insTask.run(title, id, dueFor(offset), "", w);
      }
      logActivity("note", `Autopopulated ${WORKFLOW.length} workflow tasks for campaign "${b.name || "Untitled campaign"}"`, w);
      const campaign = attachCustom("campaign", [db.query("SELECT * FROM campaigns WHERE id = ?").get(id) as any])[0];
      logActivity("note", `Created campaign "${campaign.name}"`, w);
      fireWebhooks("campaign.created", campaign, w);
      return json({ campaign }, 201);
    }
    const campaignId = path.match(/^\/api\/campaigns\/(\d+)$/);
    if (campaignId && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const campaignExists = db
        .query("SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?")
        .get(Number(campaignId[1]), w);
      if (!campaignExists) return json({ error: "not found" }, 404);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["name", "status", "start_date", "end_date", "notes"]) {
        if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
      }
      if (b.company_id !== undefined) {
        const cid = b.company_id === "" ? null : Number(b.company_id);
        if (cid && !(db.query("SELECT id FROM companies WHERE id = ? AND workspace_id = ?").get(cid, w) as any)) {
          return json({ error: "unknown company_id" }, 400);
        }
        sets.push("company_id = ?");
        vals.push(cid);
      }
      if (b.budget !== undefined) { sets.push("budget = ?"); vals.push(Number(b.budget) || 0); }
      if (sets.length) {
        db.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(campaignId[1]));
      }
      saveCustomValues("campaign", Number(campaignId[1]), b.custom, w);
      const campaign = attachCustom("campaign", [db.query("SELECT * FROM campaigns WHERE id = ?").get(Number(campaignId[1])) as any])[0];
      fireWebhooks("campaign.updated", campaign, w);
      return json({ campaign });
    }
    if (campaignId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const c = db
        .query("SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?")
        .get(Number(campaignId[1]), w) as any;
      if (c) {
        db.prepare("DELETE FROM custom_values WHERE entity = 'campaign' AND record_id = ?").run(c.id);
        db.prepare("UPDATE tasks SET campaign_id = NULL WHERE campaign_id = ?").run(c.id);
        // deleting a campaign unlinks its pipeline/contacts/companies, never removes them
        db.prepare("UPDATE deals SET campaign_id = NULL WHERE campaign_id = ?").run(c.id);
        db.prepare("UPDATE contacts SET campaign_id = NULL WHERE campaign_id = ?").run(c.id);
        db.prepare("UPDATE companies SET campaign_id = NULL WHERE campaign_id = ?").run(c.id);
        db.prepare("DELETE FROM campaigns WHERE id = ?").run(c.id);
        fireWebhooks("campaign.deleted", { id: c.id, name: c.name, workspace_id: w }, w);
      } else {
        return json({ error: "not found" }, 404);
      }
      return json({ ok: true });
    }

    // ---- stage colors for the frontend (per-workspace schema)
    if (path === "/api/meta-colors" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      seedStages(db, w);
      const colors: Record<string, string> = {};
      for (const s of workspaceStages(db, w)) colors[s.slug] = s.color;
      return json({ colors });
    }

    // ---- activities
    if (path === "/api/activities" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const rows = db
        .query("SELECT * FROM activities WHERE workspace_id = ? ORDER BY id DESC LIMIT 30")
        .all(w);
      return json({ activities: rows });
    }

    // ---- outreach: the Action phase, logged in one place ------------------------
    // Every communication channel (call, email, social message, video call,
    // in person) logs its touches here, linked to deals and contacts. The
    // optional outcome field is the Outcome phase of the
    // Review → Action → Outcome cycle.
    const outreachRow = (id: number, w: number) =>
      db.query(`SELECT o.*, d.title AS deal_title, c.name AS contact_name
                FROM outreach o
                LEFT JOIN deals d ON d.id = o.deal_id
                LEFT JOIN contacts c ON c.id = o.contact_id
                WHERE o.id = ? AND o.workspace_id = ?`).get(id, w) as any;
    if (path === "/api/outreach" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const channel = (url.searchParams.get("channel") || "").trim();
      const rows = db.query(`SELECT o.*, d.title AS deal_title, c.name AS contact_name
                FROM outreach o
                LEFT JOIN deals d ON d.id = o.deal_id
                LEFT JOIN contacts c ON c.id = o.contact_id
                WHERE o.workspace_id = ? ${channel ? "AND o.channel = ?" : ""}
                ORDER BY COALESCE(NULLIF(o.happened_at, ''), o.created_at) DESC, o.id DESC
                LIMIT 200`)
        .all(...(channel ? [w, channel] : [w]));
      return json({ outreach: rows, channels: OUTREACH_CHANNELS.map((c) => ({ value: c, label: OUTREACH_CHANNEL_LABELS[c] })) });
    }
    if (path === "/api/outreach" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const channel = String(b.channel || "").trim();
      if (!(OUTREACH_CHANNELS as readonly string[]).includes(channel)) {
        return json({ error: `channel must be one of: ${OUTREACH_CHANNELS.join(", ")}` }, 400);
      }
      const dealId = b.deal_id == null || b.deal_id === "" ? null : Number(b.deal_id);
      const contactId = b.contact_id == null || b.contact_id === "" ? null : Number(b.contact_id);
      if (dealId != null) {
        const d = db.query("SELECT id, title FROM deals WHERE id = ? AND workspace_id = ?").get(dealId, w) as any;
        if (!d) return json({ error: "deal not found in this workspace" }, 400);
      }
      if (contactId != null) {
        const c = db.query("SELECT id, name FROM contacts WHERE id = ? AND workspace_id = ?").get(contactId, w) as any;
        if (!c) return json({ error: "contact not found in this workspace" }, 400);
      }
      const note = String(b.note || "").slice(0, 4000);
      const outcome = String(b.outcome || "").slice(0, 1000);
      const happenedAt = String(b.happened_at || "").slice(0, 16);
      const id = (db.query(
        "INSERT INTO outreach (workspace_id, channel, deal_id, contact_id, note, outcome, happened_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"
      ).get(w, channel, dealId, contactId, note, outcome, happenedAt) as any).id;
      const row = outreachRow(id, w);
      logActivity("outreach",
        `${OUTREACH_CHANNEL_LABELS[channel]} logged${row.deal_title ? ` — ${row.deal_title}` : ""}${outcome ? ` → ${outcome}` : ""}`, w);
      return json({ ok: true, outreach: row });
    }
    const outreachRec = path.match(/^\/api\/outreach\/(\d+)$/);
    if (outreachRec && (method === "PATCH" || method === "DELETE")) {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const id = Number(outreachRec[1]);
      const existing = outreachRow(id, w);
      if (!existing) return json({ error: "not found" }, 404);
      if (method === "DELETE") {
        db.prepare("DELETE FROM outreach WHERE id = ? AND workspace_id = ?").run(id, w);
        return json({ ok: true });
      }
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: any[] = [];
      if (b.channel !== undefined) {
        const channel = String(b.channel).trim();
        if (!(OUTREACH_CHANNELS as readonly string[]).includes(channel)) {
          return json({ error: `channel must be one of: ${OUTREACH_CHANNELS.join(", ")}` }, 400);
        }
        sets.push("channel = ?"); vals.push(channel);
      }
      for (const key of ["note", "outcome", "happened_at"] as const) {
        if (b[key] !== undefined) { sets.push(`${key} = ?`); vals.push(String(b[key]).slice(0, key === "note" ? 4000 : 1000)); }
      }
      if (b.deal_id !== undefined) {
        const dealId = b.deal_id == null || b.deal_id === "" ? null : Number(b.deal_id);
        if (dealId != null && !db.query("SELECT id FROM deals WHERE id = ? AND workspace_id = ?").get(dealId, w)) {
          return json({ error: "deal not found in this workspace" }, 400);
        }
        sets.push("deal_id = ?"); vals.push(dealId);
      }
      if (b.contact_id !== undefined) {
        const contactId = b.contact_id == null || b.contact_id === "" ? null : Number(b.contact_id);
        if (contactId != null && !db.query("SELECT id FROM contacts WHERE id = ? AND workspace_id = ?").get(contactId, w)) {
          return json({ error: "contact not found in this workspace" }, 400);
        }
        sets.push("contact_id = ?"); vals.push(contactId);
      }
      if (!sets.length) return json({ error: "nothing to update" }, 400);
      db.prepare(`UPDATE outreach SET ${sets.join(", ")} WHERE id = ? AND workspace_id = ?`).run(...vals, id, w);
      return json({ ok: true, outreach: outreachRow(id, w) });
    }

    // ---- milton bridge: insights + daily feed for the Dashboard, agent for the floating chat dock ---
    // exec-crm never talks to Milton's DB — it proxies over HTTP so the
    // browser stays same-origin and needs no CORS. MILTON_URL never leaves the
    // server: the browser only ever sees /api/milton/* on this origin.
    const miltonFetch = (p: string, ms: number, init?: RequestInit) =>
      fetch(`${MILTON_URL}${p}`, { signal: AbortSignal.timeout(ms), ...init });
    const miltonDown = () =>
      json({ error: "milton isn't running — start it (default port 3009) and reload" }, 502);
    if (path === "/api/milton/status" && method === "GET") {
      try {
        const r = await miltonFetch("/api/health", 5000);
        return json({ ok: r.ok, reachable: r.ok });
      } catch {
        return json({ ok: false, reachable: false });
      }
    }
    if (path === "/api/milton/hygiene" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      try {
        const r = await miltonFetch(`/api/hygiene?workspace=${encodeURIComponent(String(w))}`, 10000);
        if (!r.ok) return json({ error: `milton answered ${r.status}` }, 502);
        const j = await r.json();
        return json(j);
      } catch {
        return miltonDown();
      }
    }
    // Chat with the embedded agent. One Milton session per exec-crm workspace,
    // created bound to that workspace; a client-supplied session id is only
    // honored when Milton confirms it belongs to this workspace.
    const miltonSessionFor = async (w: number, sid: unknown): Promise<string | Response> => {
      const id = typeof sid === "string" && /^s-[a-z0-9]+$/i.test(sid) ? sid : "";
      if (id) {
        let r: Response;
        try {
          r = await miltonFetch(`/api/session/workspace?session=${encodeURIComponent(id)}`, 5000);
        } catch {
          return miltonDown();
        }
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (Number(j.workspace_id) === w) return id;
        }
        return json({ error: "unknown milton session for this workspace" }, 400);
      }
      try {
        // milton enforces unique session names: one per workspace + timestamp
        const name = `exec-crm-w${w}-${Date.now().toString(36)}`;
        const r = await miltonFetch("/api/chat-sessions", 10000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, workspace_id: w }),
        });
        if (!r.ok) return json({ error: `milton answered ${r.status}` }, 502);
        const j = await r.json();
        return String(j.session.id);
      } catch {
        return miltonDown();
      }
    };
    if (path === "/api/milton/chat" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const message = String(b.message || "").slice(0, 2000).trim();
      if (!message) return json({ error: "message is required" }, 400);
      const sid = await miltonSessionFor(w, b.session);
      if (sid instanceof Response) return sid;
      try {
        const r = await miltonFetch("/api/chat", 60000, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: sid, message }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: j.error || `milton answered ${r.status}` }, 502);
        return json({ ...j, session: sid });
      } catch {
        return miltonDown();
      }
    }
    if (path === "/api/milton/history" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const sid = await miltonSessionFor(w, url.searchParams.get("session"));
      if (sid instanceof Response) return sid;
      try {
        const r = await miltonFetch(`/api/history?session=${encodeURIComponent(sid)}`, 10000);
        if (!r.ok) return json({ error: `milton answered ${r.status}` }, 502);
        const j = await r.json();
        return json({ messages: j.messages || [], session: sid });
      } catch {
        return miltonDown();
      }
    }

    // The Milton-built daily feed: a workspace-scoped stream plus Milton's
    // "morning brief". Never 500s when Milton is down — the feed renders
    // with milton.available=false instead.
    if (path === "/api/daily-feed" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      return json(await dailyFeed(w));
    }

    // ---- outgoing webhooks (automation platforms)
    if (path === "/api/webhooks" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const rows = (
        db.query("SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY id DESC").all(w) as any[]
      ).map(maskHeaders);
      return json({ webhooks: rows, events: ALL_EVENTS });
    }
    if (path === "/api/webhooks" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      if (!b.url) return json({ error: "url required" }, 400);
      const v = validateHeaders(b.headers);
      if ("error" in v) return json({ error: v.error }, 400);
      const r = db
        .prepare("INSERT INTO webhooks (name, url, events, active, workspace_id, headers) VALUES (?, ?, ?, ?, ?, ?)")
        .run(b.name || b.url, b.url, JSON.stringify(b.events || []), b.active === false ? 0 : 1, w, JSON.stringify(v));
      return json(
        { webhook: maskHeaders(db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(r.lastInsertRowid))) },
        201
      );
    }
    const whPatch = path.match(/^\/api\/webhooks\/(\d+)$/);
    if (whPatch && method === "PATCH") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const h = db
        .query("SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?")
        .get(Number(whPatch[1]), w) as any;
      if (!h) return json({ error: "not found" }, 404);
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: any[] = [];
      if (b.name !== undefined) { sets.push("name = ?"); vals.push(String(b.name)); }
      if (b.url !== undefined) { sets.push("url = ?"); vals.push(String(b.url)); }
      if (b.events !== undefined) { sets.push("events = ?"); vals.push(JSON.stringify(b.events || [])); }
      if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
      if (b.headers !== undefined) {
        // Replace semantics: keys present with a non-empty value are set;
        // an empty-string value keeps the existing stored value (UI "unchanged"
        // convention — values are never readable back); keys absent are removed.
        const v = validateHeaders(b.headers);
        if ("error" in v) return json({ error: v.error }, 400);
        const prev = storedHeaders(h);
        const next: Record<string, string> = {};
        for (const k of Object.keys(v))
          next[k] = v[k] === "" && k in prev ? prev[k] : v[k];
        sets.push("headers = ?"); vals.push(JSON.stringify(next));
      }
      if (sets.length)
        db.prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(whPatch[1]));
      return json({
        webhook: maskHeaders(db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(whPatch[1]))),
      });
    }
    const whId = path.match(/^\/api\/webhooks\/(\d+)$/);
    if (whId && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const whExists = db
        .query("SELECT id FROM webhooks WHERE id = ? AND workspace_id = ?")
        .get(Number(whId[1]), w);
      if (!whExists) return json({ error: "not found" }, 404);
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(Number(whId[1]));
      db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(Number(whId[1]));
      return json({ ok: true });
    }
    const whTest = path.match(/^\/api\/webhooks\/(\d+)\/test$/);
    if (whTest && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const h = db
        .query("SELECT * FROM webhooks WHERE id = ? AND workspace_id = ?")
        .get(Number(whTest[1]), w) as any;
      if (!h) return json({ error: "not found" }, 404);
      const payload = { event: "test", sent_at: new Date().toISOString(), data: { hello: "from exec-crm" } };
      let status = "ok", code = 0;
      try {
        const res = await fetch(h.url, {
          method: "POST",
          headers: deliveryHeaders(storedHeaders(h), "test"),
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        });
        code = res.status;
        if (!res.ok) status = "error";
      } catch { status = "failed"; }
      db.prepare(
        "INSERT INTO webhook_deliveries (webhook_id, event, payload, status, response_code) VALUES (?, ?, ?, ?, ?)"
      ).run(h.id, "test", JSON.stringify(payload), status, code);
      return json({ status, response_code: code });
    }
    if (path === "/api/deliveries" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const rows = db
        .query(
          `SELECT d.*, w.name AS webhook_name FROM webhook_deliveries d
           LEFT JOIN webhooks w ON w.id = d.webhook_id
           WHERE w.workspace_id = ?
           ORDER BY d.id DESC LIMIT 50`
        )
        .all(w);
      return json({ deliveries: rows });
    }

    // ---- incoming hooks (Zapier / Make / n8n -> CRM)
    // Each hook belongs to exactly one workspace. The management routes are
    // scoped to the active workspace (with ?all=1 to list every workspace's
    // hooks for the manager UI); the public /in/:key route is unscoped since
    // the hook itself determines the target workspace.
    if (path === "/api/hooks" && method === "GET") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const q = `SELECT h.*, w.name AS workspace_name, w.color AS workspace_color
                 FROM incoming_hooks h LEFT JOIN workspaces w ON w.id = h.workspace_id`;
      const rows =
        url.searchParams.get("all") === "1"
          ? db.query(q + " ORDER BY h.id DESC").all()
          : db.query(q + " WHERE h.workspace_id = ? ORDER BY h.id DESC").all(w);
      return json({ hooks: rows });
    }
    if (path === "/api/hooks" && method === "POST") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const b = await readBody(req);
      const key = b.key || crypto.randomUUID().replace(/-/g, "").slice(0, 24);
      const r = db.prepare("INSERT INTO incoming_hooks (name, key, workspace_id) VALUES (?, ?, ?)")
        .run(b.name || "Untitled hook", key, w);
      return json(
        { hook: db.query("SELECT id, name, key, workspace_id, created_at FROM incoming_hooks WHERE id = ?").get(Number(r.lastInsertRowid)) },
        201
      );
    }
    const hookDel = path.match(/^\/api\/hooks\/(\d+)$/);
    if (hookDel && method === "PATCH") {
      const hook = db.query("SELECT * FROM incoming_hooks WHERE id = ?").get(Number(hookDel[1])) as any;
      if (!hook) return json({ error: "not found" }, 404);
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: any[] = [];
      if (typeof b.name === "string" && b.name.trim()) {
        sets.push("name = ?");
        vals.push(b.name.trim());
      }
      if (b.workspace_id !== undefined) {
        const target = allWorkspaces().find((x) => String(x.id) === String(b.workspace_id));
        if (!target) return json({ error: `unknown workspace "${b.workspace_id}"` }, 400);
        sets.push("workspace_id = ?");
        vals.push(target.id);
      }
      if (sets.length) {
        db.prepare(`UPDATE incoming_hooks SET ${sets.join(", ")} WHERE id = ?`).run(...vals, hook.id);
      }
      return json({ hook: db.query("SELECT * FROM incoming_hooks WHERE id = ?").get(hook.id) });
    }
    if (hookDel && method === "DELETE") {
      const w = needWs(req, url);
      if (w instanceof Response) return w;
      const hit = db.prepare("DELETE FROM incoming_hooks WHERE id = ? AND workspace_id = ?")
        .run(Number(hookDel[1]), w);
      if (!hit.changes) return json({ error: "not found" }, 404);
      return json({ ok: true });
    }
    const hookIn = path.match(/^\/api\/hooks\/in\/([A-Za-z0-9]+)$/);
    if (hookIn && method === "POST") {
      const hook = db.query("SELECT * FROM incoming_hooks WHERE key = ?").get(hookIn[1]) as any;
      if (!hook) return json({ error: "unknown hook key" }, 404);
      const b = await readBody(req);
      // normalize: accept {action, data} or flat fields with action
      const action = b.action || "create_deal";
      const data = b.data || b;
      // The hook owns its workspace: deliveries land there with no extra
      // params. An explicit ?workspace= may override it for one-off routing
      // (e.g. a shared intake hook fanning into several spaces).
      const target = url.searchParams.get("workspace");
      let w: number;
      if (target) {
        const found = allWorkspaces().find((x) => String(x.id) === String(target));
        if (!found) return json({ error: `unknown workspace "${target}"` }, 400);
        w = found.id;
      } else if (hook.workspace_id != null) {
        w = hook.workspace_id;
      } else {
        const dflt = needWs(req, url);
        if (dflt instanceof Response) return dflt;
        w = dflt;
      }
      let result: any = null;
      if (action === "create_deal") {
        const r = db.prepare(
          `INSERT INTO deals (title, company_id, value, stage, probability, expected_close, owner, workspace_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(data.title || "Inbound deal", data.company_id || null, Number(data.value || 0),
          validStage(w, data.stage),
          Number(data.probability ?? 10), data.expected_close || "", data.owner || "automation", w);
        result = dealJson(Number(r.lastInsertRowid), w);
        logActivity("deal", `${(result as any).title} created via ${hook.name}`, w);
        fireWebhooks("deal.created", result as any, w);
      } else if (action === "create_contact") {
        const r = db.prepare(
          "INSERT INTO contacts (company_id, name, title, email, phone, workspace_id) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(data.company_id || null, data.name || "Unnamed", data.title || "", data.email || "", data.phone || "", w);
        result = db.query("SELECT * FROM contacts WHERE id = ?").get(Number(r.lastInsertRowid));
        fireWebhooks("contact.created", result as any, w);
      } else if (action === "create_task") {
        const r = db.prepare(
          "INSERT INTO tasks (title, deal_id, due_date, owner, workspace_id) VALUES (?, ?, ?, ?, ?)"
        ).run(data.title || "Inbound task", data.deal_id || null, data.due_date || "", data.owner || "automation", w);
        result = db.query("SELECT * FROM tasks WHERE id = ?").get(Number(r.lastInsertRowid));
        fireWebhooks("task.created", result as any, w);
      } else {
        return json({ error: `unknown action: ${action}` }, 400);
      }
      return json({ ok: true, action, result }, 201);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`exec-crm listening on http://localhost:${server.port}`);
