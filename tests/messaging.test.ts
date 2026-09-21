// tests/messaging.test.ts — email/SMS template campaigns, call logging,
// messaging settings secrets, workspace isolation and cascades.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { renderMerge, smsSegments, parseAudience } from "../src/messaging";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// ---------------------------------------------------------------- pure fns
describe("merge tags", () => {
  const c = { name: "Amara Okafor", title: "COO", email: "a@x.com", company_name: "Meridian" };
  test("renders all tags", () => {
    expect(renderMerge("Hi {{first_name}} {{last_name}} ({{name}}) at {{company}} as {{title}} <{{email}}>", c))
      .toBe("Hi Amara Okafor (Amara Okafor) at Meridian as COO <a@x.com>");
  });
  test("missing fields render as empty string", () => {
    expect(renderMerge("{{name}}|{{company}}|{{title}}|{{email}}", { name: "Bo" })).toBe("Bo|||");
  });
  test("single-word name has no last name", () => {
    expect(renderMerge("{{first_name}}|{{last_name}}", { name: "Madonna" })).toBe("Madonna|");
  });
  test("unknown tags are left untouched", () => {
    expect(renderMerge("{{name}} {{deal_value}}", c)).toBe("Amara Okafor {{deal_value}}");
  });
  test("whitespace inside braces is tolerated", () => {
    expect(renderMerge("Hi {{ first_name }}", c)).toBe("Hi Amara");
  });
});

describe("sms segments", () => {
  test("short GSM-7 is one segment", () => {
    expect(smsSegments("hello")).toEqual({ chars: 5, encoding: "gsm7", segments: 1 });
  });
  test("160 GSM chars is one segment, 161 is two", () => {
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
  });
  test("GSM extension chars count double", () => {
    expect(smsSegments("€".repeat(80))).toEqual({ chars: 160, encoding: "gsm7", segments: 1 });
    expect(smsSegments("€".repeat(81)).segments).toBe(2);
  });
  test("non-GSM text is unicode 70/67", () => {
    const u = smsSegments("héllo → world");
    expect(u.encoding).toBe("unicode");
    expect(smsSegments("x".repeat(70)).encoding).toBe("gsm7");
    expect(smsSegments("→".repeat(70)).segments).toBe(1);
    expect(smsSegments("→".repeat(71)).segments).toBe(2);
  });
});

describe("parseAudience", () => {
  test("defaults to all", () => {
    expect(parseAudience(undefined)).toEqual({ mode: "all" });
    expect(parseAudience({})).toEqual({ mode: "all" });
  });
  test("dedupes contact ids", () => {
    expect(parseAudience({ contact_ids: [3, 1, 3, 0, -2] })).toEqual({ contact_ids: [3, 1] });
  });
});

// ---------------------------------------------------------------- migration
describe("contacts messaging migration", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "crm-msg-mig-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  test("legacy contacts gain opt-out/gateway columns with defaults", () => {
    const path = join(dir, "legacy.db");
    const db = new Database(path, { create: true });
    db.exec(`CREATE TABLE workspaces (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
      INSERT INTO workspaces (name) VALUES ('Main');
      CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER,
        name TEXT NOT NULL, title TEXT DEFAULT '', email TEXT DEFAULT '', phone TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now')));
      INSERT INTO contacts (name, email) VALUES ('Old One', 'old@x.com');`);
    db.close();
    const m = openDb(path);
    const cols = (m.query("PRAGMA table_info(contacts)").all() as any[]).map((c) => c.name);
    expect(cols).toContain("email_opt_out");
    expect(cols).toContain("sms_opt_out");
    expect(cols).toContain("sms_gateway");
    const row = m.query("SELECT email_opt_out, sms_opt_out, sms_gateway FROM contacts").get() as any;
    expect([row.email_opt_out, row.sms_opt_out]).toEqual([0, 0]);
    expect(row.sms_gateway).toBe("");
    m.close();
  });
});

// ---------------------------------------------------------------- live API
describe("messaging + calls API", () => {
  let dir: string;
  let proc: any;
  let smtpListener: any;
  let twilioServer: any;
  const BASE = "http://localhost:3481";
  const SMTP_PORT = 3482;
  const TWILIO_PORT = 3483;
  const SEEN_PORT = 3484;
  const SECRET = "smtp-secret-xyz";
  const TSECRET = "twilio-token-abc";
  const smtpSeen: string[] = [];
  const twilioSeen: { auth: string | null; form: Record<string, string> }[] = [];

  const api = async (method: string, p: string, body?: any, ws?: number) => {
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-msg-live-"));
    // stub SMTP: accepts everything, records DATA payloads
    const per = new Map<any, { buf: string; dataMode: boolean; msg: string; auth: number }>();
    smtpListener = Bun.listen({
      hostname: "127.0.0.1", port: SMTP_PORT,
      socket: {
        open(sock: any) { per.set(sock, { buf: "", dataMode: false, msg: "", auth: 0 }); sock.write("220 stub\r\n"); },
        data(sock: any, d: Buffer) {
          const s = per.get(sock)!;
          s.buf += d.toString("utf8");
          for (;;) {
            if (s.dataMode) {
              const i = s.buf.indexOf("\r\n.\r\n");
              if (i < 0) break;
              smtpSeen.push(s.buf.slice(0, i)); s.buf = s.buf.slice(i + 5);
              s.dataMode = false; sock.write("250 OK\r\n"); continue;
            }
            const i = s.buf.indexOf("\r\n");
            if (i < 0) break;
            const line = s.buf.slice(0, i); s.buf = s.buf.slice(i + 2);
            const up = line.toUpperCase(); const cmd = up.split(" ")[0];
            if (cmd === "EHLO" || cmd === "HELO") sock.write("250-s\r\n250 AUTH LOGIN\r\n");
            else if (up.startsWith("AUTH LOGIN")) { s.auth = 1; sock.write("334 dXNlcg==\r\n"); }
            else if (s.auth === 1) { s.auth = 2; sock.write("334 cGFzcw==\r\n"); }
            else if (s.auth === 2) { s.auth = 0; sock.write("235 ok\r\n"); }
            else if (cmd === "MAIL" || cmd === "RCPT" || cmd === "RSET") sock.write("250 ok\r\n");
            else if (cmd === "DATA") { s.dataMode = true; sock.write("354 go\r\n"); }
            else if (cmd === "QUIT") { sock.write("221 bye\r\n"); sock.end(); }
            else sock.write("250 ok\r\n");
          }
        },
        close(sock: any) { per.delete(sock); },
      },
    });
    Bun.serve({
      port: SEEN_PORT,
      fetch: (req) => {
        const u = new URL(req.url);
        if (u.pathname === "/smtp-seen") return Response.json({ msgs: smtpSeen });
        if (u.pathname === "/twilio-seen") return Response.json({ posts: twilioSeen });
        return new Response("nope", { status: 404 });
      },
    });
    // stub Twilio
    twilioServer = Bun.serve({
      port: TWILIO_PORT,
      fetch: async (req) => {
        const form: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(await req.text())) form[k] = v;
        twilioSeen.push({ auth: req.headers.get("authorization"), form });
        return Response.json({ sid: "SMstub123" }, { status: 201 });
      },
    });
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3481",
        CRM_UPLOADS: join(dir, "uploads"),
        TWILIO_API_BASE: `http://localhost:${TWILIO_PORT}`,
      },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  afterAll(async () => {
    proc?.kill(); smtpListener?.stop(); twilioServer?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let mainId: number, betaId: number;
  let c1: number, c2: number, c3: number, co1: number, deal1: number;

  test("workspaces + fixtures", async () => {
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta", color: "#ff8a5c" })).data.workspace.id;
    co1 = (await api("POST", "/api/companies", { name: "Acme" }, mainId)).data.company.id;
    c1 = (await api("POST", "/api/contacts", { name: "Ann Lee", title: "CEO", email: "ann@acme.com", phone: "+15550001111", company_id: co1 }, mainId)).data.contact.id;
    c2 = (await api("POST", "/api/contacts", { name: "Bob Kay", email: "bob@acme.com", phone: "+15550002222", company_id: co1 }, mainId)).data.contact.id;
    c3 = (await api("POST", "/api/contacts", { name: "No Email", phone: "+15550003333", company_id: co1 }, mainId)).data.contact.id;
    deal1 = (await api("POST", "/api/deals", { title: "Big deal", company_id: co1, contact_id: c1, value: 50000 }, mainId)).data.deal.id;
    expect(c1 && c2 && c3 && deal1).toBeTruthy();
  });

  test("email template CRUD", async () => {
    const t = (await api("POST", "/api/email-templates", { name: "Intro", subject: "Hi {{first_name}}", body: "Dear {{name}} at {{company}}" }, mainId)).data.template;
    expect(t.id).toBeGreaterThan(0);
    expect((await api("GET", "/api/email-templates", undefined, mainId)).data.templates.length).toBe(1);
    const p = await api("PATCH", `/api/email-templates/${t.id}`, { subject: "Hey {{first_name}}" }, mainId);
    expect(p.data.template.subject).toBe("Hey {{first_name}}");
    expect((await api("PATCH", `/api/email-templates/9999`, { subject: "x" }, mainId)).status).toBe(404);
    expect((await api("POST", "/api/email-templates", { subject: "no name" }, mainId)).status).toBe(400);
    await api("DELETE", `/api/email-templates/${t.id}`, undefined, mainId);
    expect((await api("GET", "/api/email-templates", undefined, mainId)).data.templates.length).toBe(0);
  });

  test("sms template CRUD", async () => {
    const t = (await api("POST", "/api/sms-templates", { name: "Nudge", body: "Hi {{first_name}}, quick check-in" }, mainId)).data.template;
    expect(t.body).toContain("{{first_name}}");
    await api("DELETE", `/api/sms-templates/${t.id}`, undefined, mainId);
  });

  test("msg settings: secrets never leak; blank keeps stored value", async () => {
    const r = await api("PATCH", "/api/msg-settings", {
      smtp_host: "127.0.0.1", smtp_port: String(SMTP_PORT), smtp_secure: "none",
      smtp_user: "u", smtp_pass: SECRET, smtp_from_email: "sales@acme.com", smtp_from_name: "Acme Sales",
    }, mainId);
    expect(r.status).toBe(200);
    expect(r.data.secrets_set.smtp_pass).toBe(true);
    expect(JSON.stringify(r.data).includes(SECRET)).toBe(false);
    const g = await api("GET", "/api/msg-settings", undefined, mainId);
    expect(JSON.stringify(g.data).includes(SECRET)).toBe(false);
    expect(g.data.values.smtp_host).toBe("127.0.0.1");
    // blank secret keeps the stored value — send still authenticates below
    await api("PATCH", "/api/msg-settings", { smtp_pass: "" }, mainId);
    expect((await api("GET", "/api/msg-settings", undefined, mainId)).data.secrets_set.smtp_pass).toBe(true);
    expect((await api("PATCH", "/api/msg-settings", { sms_provider: "pigeon" }, mainId)).status).toBe(400);
    expect((await api("PATCH", "/api/msg-settings", { smtp_secure: "tls1.3" }, mainId)).status).toBe(400);
  });

  let tplId: number;
  test("email campaign send via stub SMTP with merge rendering", async () => {
    tplId = (await api("POST", "/api/email-templates", { name: "Intro", subject: "Hi {{first_name}}", body: "Dear {{name}} of {{company}}" }, mainId)).data.template.id;
    const camp = (await api("POST", "/api/email-campaigns", { name: "Q4", template_id: tplId, audience: { contact_ids: [c1, c2, c3] } }, mainId)).data.campaign;
    expect(camp.status).toBe("draft");
    const before = smtpSeen.length;
    const send = await api("POST", `/api/email-campaigns/${camp.id}/send`, undefined, mainId);
    expect(send.data).toMatchObject({ sent: 2, failed: 0, total: 2 }); // c3 has no email
    expect(smtpSeen.length).toBe(before + 2);
    const first = smtpSeen[before];
    expect(first).toContain("To: ann@acme.com");
    expect(first).toContain("Subject: Hi Ann");
    expect(first).toContain("Dear Ann Lee of Acme");
    const detail = (await api("GET", `/api/email-campaigns/${camp.id}`, undefined, mainId)).data;
    expect(detail.campaign.status).toBe("sent");
    expect(detail.sends.length).toBe(2);
    expect(detail.sends.every((s: any) => s.status === "sent")).toBe(true);
    expect(detail.sends[0].contact_name).toBeTruthy();
    // double-send is rejected
    expect((await api("POST", `/api/email-campaigns/${camp.id}/send`, undefined, mainId)).status).toBe(400);
  });

  test("email opt-out + missing email are skipped", async () => {
    await api("PATCH", `/api/contacts/${c1}`, { email_opt_out: true }, mainId);
    const camp = (await api("POST", "/api/email-campaigns", { name: "Q4b", template_id: tplId, audience: { contact_ids: [c1, c2] } }, mainId)).data.campaign;
    const send = await api("POST", `/api/email-campaigns/${camp.id}/send`, undefined, mainId);
    expect(send.data).toMatchObject({ sent: 1, failed: 0, total: 1 });
    await api("PATCH", `/api/contacts/${c1}`, { email_opt_out: false }, mainId);
  });

  test("explicit contact_ids audience", async () => {
    const camp = (await api("POST", "/api/email-campaigns", { name: "Q4c", template_id: tplId, audience: { contact_ids: [c2] } }, mainId)).data.campaign;
    const send = await api("POST", `/api/email-campaigns/${camp.id}/send`, undefined, mainId);
    expect(send.data.total).toBe(1);
    const detail = (await api("GET", `/api/email-campaigns/${camp.id}`, undefined, mainId)).data;
    expect(detail.sends[0].contact_id).toBe(c2);
  });

  test("send without SMTP configured is a clean 400", async () => {
    const bt = (await api("POST", "/api/email-templates", { name: "B", subject: "s", body: "b" }, betaId)).data.template;
    const camp = (await api("POST", "/api/email-campaigns", { name: "Nope", template_id: bt.id, audience: { mode: "all" } }, betaId)).data.campaign;
    const send = await api("POST", `/api/email-campaigns/${camp.id}/send`, undefined, betaId);
    expect(send.status).toBe(400);
    expect((await api("GET", `/api/email-campaigns/${camp.id}`, undefined, betaId)).data.campaign.status).toBe("draft");
  });

  test("sms campaign via email-to-SMS gateway", async () => {
    await api("PATCH", `/api/contacts/${c1}`, { sms_gateway: "15550001111@vtext.com" }, mainId);
    await api("PATCH", `/api/contacts/${c2}`, { sms_gateway: "15550002222@vtext.com", sms_opt_out: true }, mainId);
    await api("PATCH", "/api/msg-settings", { sms_provider: "gateway" }, mainId);
    const tpl = (await api("POST", "/api/sms-templates", { name: "Nudge", body: "Hi {{first_name}} — Acme here" }, mainId)).data.template;
    const camp = (await api("POST", "/api/sms-campaigns", { name: "SMS1", template_id: tpl.id, audience: { mode: "all" } }, mainId)).data.campaign;
    const before = smtpSeen.length;
    const send = await api("POST", `/api/sms-campaigns/${camp.id}/send`, undefined, mainId);
    expect(send.data).toMatchObject({ sent: 1, failed: 0, total: 1 }); // c2 opted out, c3 has no gateway
    expect(smtpSeen.length).toBe(before + 1);
    expect(smtpSeen[before]).toContain("To: 15550001111@vtext.com");
    expect(smtpSeen[before]).toContain("Hi Ann — Acme here");
    const detail = (await api("GET", `/api/sms-campaigns/${camp.id}`, undefined, mainId)).data;
    expect(detail.sends[0].dest).toBe("15550001111@vtext.com");
    await api("PATCH", `/api/contacts/${c2}`, { sms_opt_out: false }, mainId);
  });

  test("sms campaign via Twilio stub", async () => {
    await api("PATCH", "/api/msg-settings", {
      sms_provider: "twilio", twilio_sid: "AC123", twilio_token: TSECRET, twilio_from: "+15558880000",
    }, mainId);
    const g = await api("GET", "/api/msg-settings", undefined, mainId);
    expect(JSON.stringify(g.data).includes(TSECRET)).toBe(false);
    const tpl = (await api("POST", "/api/sms-templates", { name: "N2", body: "Hi {{first_name}}" }, mainId)).data.template;
    const camp = (await api("POST", "/api/sms-campaigns", { name: "SMS2", template_id: tpl.id, audience: { contact_ids: [c1, c2] } }, mainId)).data.campaign;
    const before = twilioSeen.length;
    const send = await api("POST", `/api/sms-campaigns/${camp.id}/send`, undefined, mainId);
    expect(send.data).toMatchObject({ sent: 2, failed: 0, total: 2 });
    expect(twilioSeen.length).toBe(before + 2);
    const p0 = twilioSeen[before];
    expect(p0.auth).toBe("Basic " + Buffer.from("AC123:" + TSECRET).toString("base64"));
    expect(p0.form.To).toBe("+15550001111");
    expect(p0.form.From).toBe("+15558880000");
    expect(p0.form.Body).toContain("Hi Ann");
  });

  test("call log CRUD + filters", async () => {
    const c = (await api("POST", "/api/calls", {
      contact_id: c1, company_id: co1, deal_id: deal1,
      direction: "out", duration_sec: 180, outcome: "connected", notes: "good chat",
    }, mainId)).data.call;
    expect(c.id).toBeGreaterThan(0);
    expect(c.called_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect((await api("POST", "/api/calls", { outcome: "connected" }, mainId)).status).toBe(400);
    expect((await api("POST", "/api/calls", { contact_id: 9999, outcome: "connected" }, mainId)).status).toBe(400);
    expect((await api("POST", "/api/calls", { contact_id: c1, outcome: "telepathy" }, mainId)).status).toBe(400);
    const all = (await api("GET", "/api/calls", undefined, mainId)).data;
    expect(all.outcomes).toContain("voicemail");
    expect(all.calls.length).toBe(1);
    expect(all.calls[0].contact_name).toBe("Ann Lee");
    expect((await api("GET", `/api/calls?outcome=voicemail`, undefined, mainId)).data.calls.length).toBe(0);
    expect((await api("GET", `/api/calls?contact_id=${c1}`, undefined, mainId)).data.calls.length).toBe(1);
    expect((await api("GET", `/api/calls?q=good`, undefined, mainId)).data.calls.length).toBe(1);
    const p = await api("PATCH", `/api/calls/${c.id}`, { outcome: "follow-up", notes: "call back" }, mainId);
    expect(p.data.call.outcome).toBe("follow-up");
    await api("DELETE", `/api/calls/${c.id}`, undefined, mainId);
    expect((await api("GET", "/api/calls", undefined, mainId)).data.calls.length).toBe(0);
  });

  test("deal delete deletes every call referring to the deal", async () => {
    const dealOnly = (await api("POST", "/api/calls", { deal_id: deal1, outcome: "busy" }, mainId)).data.call;
    const shared = (await api("POST", "/api/calls", { deal_id: deal1, contact_id: c2, outcome: "connected" }, mainId)).data.call;
    await api("DELETE", `/api/deals/${deal1}`, undefined, mainId);
    const calls = (await api("GET", "/api/calls", undefined, mainId)).data.calls;
    expect(calls.find((x: any) => x.id === dealOnly.id)).toBeUndefined();
    expect(calls.find((x: any) => x.id === shared.id)).toBeUndefined();
  });

  test("company delete deletes every call referring to the company", async () => {
    const coCall = (await api("POST", "/api/calls", { company_id: co1, outcome: "no answer" }, mainId)).data.call;
    const shared = (await api("POST", "/api/calls", { company_id: co1, contact_id: c1, outcome: "connected" }, mainId)).data.call;
    const r = await api("DELETE", `/api/companies/${co1}`, { confirm: true }, mainId);
    expect(r.status).toBe(200);
    const calls = (await api("GET", "/api/calls", undefined, mainId)).data.calls;
    expect(calls.find((x: any) => x.id === coCall.id)).toBeUndefined();
    expect(calls.find((x: any) => x.id === shared.id)).toBeUndefined();
    // contacts survive (orphaned)
    const list = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts;
    expect(list.find((x: any) => x.id === c2).company_id).toBeNull();
  });

  test("contact DELETE orphans linked records and deletes the contact's calls", async () => {
    const cc = (await api("POST", "/api/contacts", { name: "Doomed Dan", email: "dan@x.com" }, mainId)).data.contact;
    const dl = (await api("POST", "/api/deals", { title: "Dan deal", contact_id: cc.id, value: 100 }, mainId)).data.deal;
    const call = (await api("POST", "/api/calls", { contact_id: cc.id, outcome: "connected" }, mainId)).data.call;
    const r409 = await api("DELETE", `/api/contacts/${cc.id}`, undefined, mainId);
    expect(r409.status).toBe(409);
    expect(r409.data.deals).toBe(1);
    const ok = await api("DELETE", `/api/contacts/${cc.id}`, { confirm: true }, mainId);
    expect(ok.status).toBe(200);
    const deals = (await api("GET", "/api/deals", undefined, mainId)).data.deals;
    expect(deals.find((x: any) => x.id === dl.id).contact_id).toBeNull();
    const calls = (await api("GET", "/api/calls", undefined, mainId)).data.calls;
    expect(calls.find((x: any) => x.id === call.id)).toBeUndefined();
    // a contact with no links deletes without confirm
    const loner = (await api("POST", "/api/contacts", { name: "Loner" }, mainId)).data.contact;
    expect((await api("DELETE", `/api/contacts/${loner.id}`, undefined, mainId)).status).toBe(200);
  });

  test("contact POST/PATCH accept messaging fields", async () => {
    const c = (await api("POST", "/api/contacts",
      { name: "Msg Mia", sms_gateway: "15550004444@vtext.com", email_opt_out: true, sms_opt_out: false }, mainId)).data.contact;
    expect(c.sms_gateway).toBe("15550004444@vtext.com");
    expect(c.email_opt_out).toBe(1);
    const p = (await api("PATCH", `/api/contacts/${c.id}`, { sms_opt_out: true, sms_gateway: "" }, mainId)).data.contact;
    expect(p.sms_opt_out).toBe(1);
    expect(p.sms_gateway).toBe("");
  });

  test("GET /api/calls/:id returns the call", async () => {
    const c = (await api("POST", "/api/calls", { contact_id: c1, outcome: "voicemail", notes: "ring ring" }, mainId)).data.call;
    const one = (await api("GET", `/api/calls/${c.id}`, undefined, mainId)).data.call;
    expect(one.outcome).toBe("voicemail");
    expect(one.notes).toBe("ring ring");
    expect((await api("GET", `/api/calls/${c.id}`, undefined, betaId)).status).toBe(404);
    expect((await api("GET", "/api/calls/999999", undefined, mainId)).status).toBe(404);
  });

  test("duplicate merge reassigns calls to the winner", async () => {
    const w = (await api("POST", "/api/contacts", { name: "Winner", email: "w@x.com" }, mainId)).data.contact;
    const l = (await api("POST", "/api/contacts", { name: "Loser", email: "l@x.com" }, mainId)).data.contact;
    const call = (await api("POST", "/api/calls", { contact_id: l.id, outcome: "connected" }, mainId)).data.call;
    const m = await api("POST", "/api/duplicates/merge", { type: "contact", winner_id: w.id, loser_id: l.id, confirm: true }, mainId);
    expect(m.data.reassigned.calls).toBe(1);
    const kept = (await api("GET", `/api/calls?contact_id=${w.id}`, undefined, mainId)).data.calls;
    expect(kept.find((x: any) => x.id === call.id)).toBeTruthy();
  });

  test("workspace isolation for templates, campaigns, calls, settings", async () => {
    const btpls = (await api("GET", "/api/email-templates", undefined, betaId)).data.templates;
    expect(btpls.every((t: any) => t.workspace_id === betaId)).toBe(true);
    expect(btpls.find((t: any) => t.name === "Intro")).toBeUndefined(); // main's template stays hidden
    expect((await api("GET", "/api/calls", undefined, betaId)).data.calls.length).toBe(0);
    expect((await api("GET", "/api/msg-settings", undefined, betaId)).data.values.smtp_host).toBe("");
    const bc = (await api("POST", "/api/contacts", { name: "Beta Bob", email: "b@beta.com" }, betaId)).data.contact;
    const bcall = (await api("POST", "/api/calls", { contact_id: bc.id, outcome: "connected" }, betaId)).data.call;
    expect((await api("GET", "/api/calls", undefined, mainId)).data.calls.find((x: any) => x.id === bcall.id)).toBeUndefined();
    // workspace delete cascades the new tables
    const del = await api("DELETE", `/api/workspaces/${betaId}`, { confirm: "Beta" }, undefined);
    expect(del.data.ok).toBe(true);
    const db2 = new Database(join(dir, "test.db"), { create: false, readonly: true });
    for (const t of ["email_templates", "email_campaigns", "email_sends", "sms_templates", "sms_campaigns", "sms_sends", "calls", "workspace_settings"]) {
      const n = (db2.query(`SELECT COUNT(*) n FROM ${t} WHERE workspace_id = ?`).get(betaId) as any).n;
      expect(`${t}:${n}`).toBe(`${t}:0`);
    }
    db2.close();
  });
});
