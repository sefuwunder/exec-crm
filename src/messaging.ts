// src/messaging.ts — email/SMS campaign helpers for exec-crm.
// Pure, test-covered functions: merge-tag rendering, SMS segment counting.
// Transport code (SMTP lives in ./smtp.ts; Twilio is direct HTTPS, no SDK).

import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------- merge tags
// Supported tags: {{name}} {{first_name}} {{last_name}} {{company}} {{title}}
// {{email}}. Unknown tags are left untouched; known tags with missing values
// render as an empty string.
export interface MergeContact {
  name?: string;
  title?: string;
  email?: string;
  company_name?: string;
}

export function splitName(name: string): { first: string; last: string } {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export function renderMerge(template: string, contact: MergeContact): string {
  const c = contact || {};
  const { first, last } = splitName(c.name || "");
  const vals: Record<string, string> = {
    name: c.name || "",
    first_name: first,
    last_name: last,
    company: c.company_name || "",
    title: c.title || "",
    email: c.email || "",
  };
  return String(template ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key) =>
    key in vals ? vals[key] : m
  );
}

// ------------------------------------------------------------ SMS segments
// GSM-7 default alphabet (incl. common extension chars, counted as 2 septets
// because they need the escape prefix). Anything outside -> UCS-2 (unicode).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

function gsmSeptets(text: string): number | null {
  let n = 0;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) n += 1;
    else if (GSM_EXT.includes(ch)) n += 2;
    else return null; // not GSM-7 encodable
  }
  return n;
}

export interface SmsCount {
  chars: number;
  encoding: "gsm7" | "unicode";
  segments: number;
}

/** Character/segment count for the composer: GSM-7 160/153, unicode 70/67. */
export function smsSegments(text: string): SmsCount {
  const t = String(text ?? "");
  const septets = gsmSeptets(t);
  if (septets !== null) {
    const per = 160, concat = 153;
    return {
      chars: septets,
      encoding: "gsm7",
      segments: septets <= per ? 1 : Math.ceil(septets / concat),
    };
  }
  const chars = [...t].length;
  return {
    chars,
    encoding: "unicode",
    segments: chars <= 70 ? 1 : Math.ceil(chars / 67),
  };
}

// ------------------------------------------------------- per-workspace keys
// Messaging settings (SMTP, Twilio, gateway) live in workspace_settings so
// each workspace has its own credentials. Secrets are write-only: the API
// only ever reports whether they're set, never their values.
export const MSG_SETTING_KEYS = [
  "smtp_host",
  "smtp_port",
  "smtp_secure", // ssl | starttls | none
  "smtp_user",
  "smtp_pass", // secret
  "smtp_from_name",
  "smtp_from_email",
  "sms_provider", // twilio | gateway
  "twilio_sid",
  "twilio_token", // secret
  "twilio_from",
] as const;

export const SECRET_MSG_KEYS = new Set(["smtp_pass", "twilio_token"]);

export function getMsgSettings(db: Database, w: number): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = db
    .query("SELECT key, value FROM workspace_settings WHERE workspace_id = ?")
    .all(w) as { key: string; value: string }[];
  for (const r of rows) out[r.key] = r.value ?? "";
  return out;
}

/** Public shape: secret values are replaced by a boolean "is set" flag. */
export function maskedMsgSettings(
  db: Database,
  w: number
): { values: Record<string, string>; secrets_set: Record<string, boolean> } {
  const all = getMsgSettings(db, w);
  const values: Record<string, string> = {};
  const secrets_set: Record<string, boolean> = {};
  for (const k of MSG_SETTING_KEYS) {
    if (SECRET_MSG_KEYS.has(k)) secrets_set[k] = !!(all[k] || "").trim();
    else values[k] = all[k] || "";
  }
  return { values, secrets_set };
}

/** Write settings. For secret keys, an empty string keeps the stored value
    (the UI "unchanged" convention — values are never readable back). */
export function saveMsgSettings(
  db: Database,
  w: number,
  input: Record<string, unknown>
): void {
  const up = db.prepare(
    "INSERT INTO workspace_settings (workspace_id, key, value) VALUES (?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value"
  );
  for (const k of MSG_SETTING_KEYS) {
    if (input[k] === undefined) continue;
    const v = String(input[k] ?? "");
    if (SECRET_MSG_KEYS.has(k) && v === "") continue; // keep existing
    up.run(w, k, v);
  }
}

export function smtpConfigured(s: Record<string, string>): boolean {
  return !!(s.smtp_host || "").trim() && !!(s.smtp_from_email || "").trim();
}

export function twilioConfigured(s: Record<string, string>): boolean {
  return (
    !!(s.twilio_sid || "").trim() &&
    !!(s.twilio_token || "").trim() &&
    !!(s.twilio_from || "").trim()
  );
}

// ---------------------------------------------------------------- audiences
export type Audience = { mode: "all" } | { contact_ids: number[] };

export function parseAudience(raw: unknown): Audience {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    if (r.mode === "all") return { mode: "all" };
    if (Array.isArray(r.contact_ids)) {
      const ids = r.contact_ids.map(Number).filter((n) => n > 0);
      return { contact_ids: [...new Set(ids)] };
    }
  }
  return { mode: "all" };
}

export interface AudienceContact {
  id: number;
  name: string;
  title: string;
  email: string;
  phone: string;
  sms_gateway: string;
  company_name: string;
}

/** Email audience: contacts with an email, skipping email_opt_out=1. */
export function resolveEmailAudience(
  db: Database,
  w: number,
  audience: Audience
): AudienceContact[] {
  return resolveAudience(db, w, audience, "email");
}

/** SMS audience: contacts with a phone (twilio) or sms_gateway (gateway
    provider), skipping sms_opt_out=1. */
export function resolveSmsAudience(
  db: Database,
  w: number,
  audience: Audience,
  provider: string
): AudienceContact[] {
  return resolveAudience(db, w, audience, "sms", provider);
}

function resolveAudience(
  db: Database,
  w: number,
  audience: Audience,
  kind: "email" | "sms",
  provider = "twilio"
): AudienceContact[] {
  const optCol = kind === "email" ? "email_opt_out" : "sms_opt_out";
  let sql = `SELECT c.id, c.name, c.title, c.email, c.phone, c.sms_gateway,
                    co.name AS company_name
             FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
             WHERE c.workspace_id = ? AND COALESCE(c.${optCol}, 0) = 0`;
  const params: unknown[] = [w];
  if (audience.mode !== "all") {
    if (!audience.contact_ids.length) return [];
    sql += ` AND c.id IN (${audience.contact_ids.map(() => "?").join(",")})`;
    params.push(...audience.contact_ids);
  }
  const rows = db.query(sql + " ORDER BY c.name").all(...params) as AudienceContact[];
  return rows.filter((c) => {
    if (kind === "email") return !!(c.email || "").trim();
    if (provider === "gateway") return !!(c.sms_gateway || "").trim();
    return !!(c.phone || "").trim();
  });
}

// ----------------------------------------------------------------- Twilio
// TWILIO_API_BASE is overridable for tests (default: the real Twilio API).
const TWILIO_API_BASE = process.env.TWILIO_API_BASE || "https://api.twilio.com";
export async function sendTwilio(opts: {
  sid: string;
  token: string;
  from: string;
  to: string;
  body: string;
}): Promise<{ ok: true; sid: string }> {
  const url = `${TWILIO_API_BASE}/2010-04-01/Accounts/${encodeURIComponent(opts.sid)}/Messages.json`;
  const creds = Buffer.from(`${opts.sid}:${opts.token}`).toString("base64");
  const form = new URLSearchParams({ To: opts.to, From: opts.from, Body: opts.body });
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(30000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    throw new Error(`Twilio rejected the message (${res.status}): ${j.message || j.error || "unknown error"}`.slice(0, 300));
  }
  return { ok: true, sid: String(j.sid || "") };
}

/** Sanitize a transport error for storage in the delivery log. */
export function sendError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e ?? "send failed");
  return m.slice(0, 500);
}
