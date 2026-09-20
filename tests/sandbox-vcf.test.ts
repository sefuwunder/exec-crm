// tests/sandbox-vcf.test.ts — VCF (vCard) import in the data sandbox.
// Parser unit tests (folded lines, QP/base64, params, N assembly,
// multi-email/phone, malformed tolerance), the VCF upload/commit API flow,
// batch source badges, and a CSV regression check.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
const serverSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "src", "server.ts"), "utf8");

function extractFn(src: string, name: string): string {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index + m[0].length - 1, pdepth = 0;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "(") pdepth++; else if (ch === ")") { if (--pdepth === 0) break; } }
  let depth = 0;
  for (; i < src.length; i++) { const ch = src[i]; if (ch === "{") depth++; else if (ch === "}") { if (--depth === 0) return src.slice(m.index, i + 1); } }
  throw new Error("unbalanced braces in " + name);
}

// parseVcf and its helpers are written annotation-free, so they eval as-is.
const parseVcf: any = new Function(
  extractFn(serverSrc, "sbDecodeQP") + "\n" +
  extractFn(serverSrc, "sbB64decode") + "\n" +
  extractFn(serverSrc, "parseVcf") + "\nreturn parseVcf;"
)();

const card = (lines: string[]) => ["BEGIN:VCARD", "VERSION:3.0", ...lines, "END:VCARD"].join("\r\n");

describe("parseVcf unit", () => {
  test("FN, EMAIL/TEL with TYPE params, ORG/TITLE/NOTE", () => {
    const [c] = parseVcf(card([
      "FN:Ada Lovelace",
      "TITLE:Mathematician",
      "EMAIL;TYPE=WORK:ada@analytical.com",
      "TEL;TYPE=WORK,VOICE:+1-555-0100",
      "ORG:Analytical Engines Ltd",
      "NOTE:First programmer",
    ]));
    expect(c.name).toBe("Ada Lovelace");
    expect(c.title).toBe("Mathematician");
    expect(c.email).toBe("ada@analytical.com");
    expect(c.phone).toBe("+1-555-0100");
    expect(c.company).toBe("Analytical Engines Ltd");
    expect(c.notes).toContain("First programmer");
    expect(c.extraFlags).toEqual([]);
  });

  test("N assembles prefix/given/middle/family/suffix when FN is absent", () => {
    const [c] = parseVcf(card(["N:Reyes;David;A;Dr.;Jr.", "EMAIL:d@x.com"]));
    expect(c.name).toBe("Dr. David A Reyes Jr.");
  });

  test("folded (continued) lines are unfolded", () => {
    const [c] = parseVcf(card(["FN:Grace Hopper", "NOTE:long note that", " continues on the next", " line."]));
    expect(c.notes).toBe("long note thatcontinues on the nextline.");
  });

  test("quoted-printable UTF-8 decodes correctly", () => {
    const [c] = parseVcf(card(["FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller"]));
    expect(c.name).toBe("Jürgen Müller");
  });

  test("base64 PHOTO payload is skipped, not stored", () => {
    const [c] = parseVcf(card([
      "FN:Photo Guy",
      "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAgAAAQABAAD/",
      "EMAIL:photo@guy.com",
    ]));
    expect(c.email).toBe("photo@guy.com");
    expect(JSON.stringify(c)).not.toContain("/9j/4AAQ");
  });

  test("vCard 2.1 bare params (TEL;HOME;VOICE) are understood", () => {
    const [c] = parseVcf(card(["FN:Old Timer", "TEL;HOME;VOICE:555-0199"]));
    expect(c.phone).toBe("555-0199");
  });

  test("multiple emails: work preferred, extras noted and flagged", () => {
    const [c] = parseVcf(card([
      "FN:Multi Mail",
      "EMAIL;TYPE=home:multi@home.com",
      "EMAIL;TYPE=work:multi@work.com",
    ]));
    expect(c.email).toBe("multi@work.com");
    expect(c.notes).toContain("Other emails: multi@home.com (home)");
    expect(c.extraFlags.map((f: any) => f.code)).toContain("multi-email");
  });

  test("multiple phones: cell preferred, extras noted and flagged", () => {
    const [c] = parseVcf(card([
      "FN:Multi Phone",
      "TEL;TYPE=work:555-0201",
      "TEL;TYPE=cell:555-0200",
    ]));
    expect(c.phone).toBe("555-0200");
    expect(c.notes).toContain("Other phones: 555-0201 (work)");
    expect(c.extraFlags.map((f: any) => f.code)).toContain("multi-phone");
  });

  test("ADR and URL land in notes", () => {
    const [c] = parseVcf(card([
      "FN:Addr Ann",
      "ADR;TYPE=WORK:;;100 Main St;Springfield;IL;62701;USA",
      "URL:https://ann.example",
    ]));
    expect(c.notes).toContain("Address: 100 Main St, Springfield, IL, 62701, USA");
    expect(c.notes).toContain("Website: https://ann.example");
  });

  test("dangling card (missing END:VCARD) is parsed and flagged malformed, not dropped", () => {
    const cards = parseVcf(
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dangling Dan\r\nEMAIL:dan@d.com\r\n" +
      "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Fine Fiona\r\nEMAIL:fiona@d.com\r\nEND:VCARD\r\n"
    );
    expect(cards).toHaveLength(2);
    expect(cards[0].name).toBe("Dangling Dan");
    expect(cards[0].extraFlags.map((f: any) => f.code)).toContain("malformed");
    expect(cards[1].extraFlags).toEqual([]);
  });

  test("card with no name and no email is flagged unusable", () => {
    const [c] = parseVcf(card(["ORG:Acme Corp"]));
    expect(c.extraFlags.map((f: any) => f.code)).toContain("unusable");
  });

  test("garbage input never throws", () => {
    expect(() => parseVcf("this is not a vcard at all")).not.toThrow();
    expect(parseVcf("this is not a vcard at all")).toEqual([]);
    expect(() => parseVcf("BEGIN:VCARD\n:broken\nNOCOLONLINE\nEND:VCARD")).not.toThrow();
    expect(() => parseVcf("")).not.toThrow();
  });
});

const NASTY_VCF = [
  card(["FN:Amara Okafor", "EMAIL;TYPE=WORK:amara@meridianlog.com"]),          // dup of seeded contact
  card(["N:Reyes;David;A;;", "EMAIL:d.reyes2@example.com"]),                   // fuzzy name dup of seeded David Reyes
  card(["FN:Zara Quinn", "EMAIL:zara@quinn.com", "TEL:+1-555-0200"]),          // clean
  card(["FN:Zara Q Quinn", "EMAIL:zara2@quinn.com"]),                          // within-batch name dup of row 3
  card(["FN:Bad Email", "EMAIL:not-an-email"]),                               // flagged: bad email
  card(["ORG:Acme Corp"]),                                                    // flagged: unusable
  card(["FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen M=C3=BCller", "EMAIL:jurgen@example.com"]), // clean
].join("\r\n");

describe("sandbox VCF API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3475";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let mainId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-vcf-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3475", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    mainId = ((await api("GET", "/api/workspaces")).data.workspaces[0]).id;
  });
  afterAll(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

  test("VCF upload: source=vcf, dedup + flags across the batch", async () => {
    const { status, data } = await api("POST", "/api/sandbox/batches", { name: "Nasty VCF", filename: "nasty.vcf", vcf: NASTY_VCF }, mainId);
    expect(status).toBe(201);
    expect(data.batch.source).toBe("vcf");
    expect(data.summary.total).toBe(7);
    expect(data.summary.clean).toBe(2);
    expect(data.summary.duplicates).toBe(3);
    expect(data.summary.flagged).toBe(2);

    const detail = (await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId)).data;
    const byNum = new Map(detail.rows.map((r: any) => [r.row_num, r]));
    expect(byNum.get(1).status).toBe("duplicate");
    expect(byNum.get(1).dup_contact.name).toBe("Amara Okafor");
    expect(byNum.get(2).status).toBe("duplicate");
    expect(byNum.get(2).dup_contact.name).toBe("David Reyes");
    expect(byNum.get(2).name).toBe("David A Reyes");
    expect(byNum.get(4).status).toBe("duplicate");
    expect(byNum.get(4).dup_row.row_num).toBe(3);
    expect(byNum.get(5).status).toBe("flagged");
    expect(byNum.get(5).flags.map((f: any) => f.code)).toContain("bad-email");
    expect(byNum.get(6).status).toBe("flagged");
    expect(byNum.get(6).flags.map((f: any) => f.code)).toContain("unusable");
    expect(byNum.get(7).name).toBe("Jürgen Müller");
    expect(byNum.get(7).status).toBe("clean");
  });

  test("batch list carries the source field for badges", async () => {
    const { data } = await api("GET", "/api/sandbox/batches", undefined, mainId);
    const b = data.batches.find((x: any) => x.name === "Nasty VCF");
    expect(b.source).toBe("vcf");
  });

  test("filename-based detection: .vcf filename with payload in csv field", async () => {
    const { status, data } = await api("POST", "/api/sandbox/batches", {
      name: "Ext detect", filename: "cards.vcf", csv: card(["FN:Ext Eddy", "EMAIL:eddy@ext.dev"]),
    }, mainId);
    expect(status).toBe(201);
    expect(data.batch.source).toBe("vcf");
    expect(data.summary.total).toBe(1);
    expect(data.summary.clean).toBe(1);
  });

  test("file with no vCards is rejected with 400", async () => {
    const { status, data } = await api("POST", "/api/sandbox/batches", { name: "Empty", filename: "e.vcf", vcf: "hello world" }, mainId);
    expect(status).toBe(400);
    expect(data.error).toMatch(/no vCards/i);
  });

  test("reject-duplicates also rejects unusable rows", async () => {
    const { data } = await api("POST", "/api/sandbox/batches", { name: "BulkV", filename: "b.vcf", vcf: NASTY_VCF }, mainId);
    const id = data.batch.id;
    const r = await api("POST", `/api/sandbox/batches/${id}/decision`, { action: "reject-duplicates" }, mainId);
    // 3 duplicates + 1 unusable
    expect(r.data.changed).toBe(4);
    expect(r.data.summary.rejected).toBe(4);
  });

  test("commit: only approved VCF rows land in contacts", async () => {
    const before = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts.length;
    const { data } = await api("POST", "/api/sandbox/batches", { name: "CommitV", filename: "c.vcf", vcf: NASTY_VCF }, mainId);
    const id = data.batch.id;
    const detail = (await api("GET", `/api/sandbox/batches/${id}`, undefined, mainId)).data;
    const rowId = (n: number) => detail.rows.find((r: any) => r.row_num === n).id;
    for (const n of [3, 7]) await api("PATCH", `/api/sandbox/rows/${rowId(n)}`, { decision: "approved" }, mainId);
    const commit = await api("POST", `/api/sandbox/batches/${id}/commit`, {}, mainId);
    expect(commit.status).toBe(200);
    expect(commit.data.imported).toBe(2);
    const contacts = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts;
    expect(contacts.length).toBe(before + 2);
    expect(contacts.some((c: any) => c.name === "Jürgen Müller")).toBe(true);
  });

  test("CSV regression: CSV upload still works with source csv", async () => {
    const { status, data } = await api("POST", "/api/sandbox/batches", {
      name: "Still CSV", filename: "s.csv", csv: "name,email\nCSV Person,csvperson@example.com",
    }, mainId);
    expect(status).toBe(201);
    expect(data.batch.source).toBe("csv");
    expect(data.summary.total).toBe(1);
    expect(data.summary.clean).toBe(1);
  });
});

describe("sandbox tab VCF copy (DOM-stubbed)", () => {
  const esc = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const mkEl = (extra: any = {}) => ({
    addEventListener: () => {},
    set onchange(f: any) {},
    classList: { add: () => {}, remove: () => {} },
    dataset: {},
    ...extra,
  });
  function extractUiFn(name: string): string {
    const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(appSrc);
    if (!m) throw new Error("fn not found: " + name);
    let i = m.index + m[0].length - 1, pdepth = 0;
    for (; i < appSrc.length; i++) { const ch = appSrc[i]; if (ch === "(") pdepth++; else if (ch === ")") { if (--pdepth === 0) break; } }
    let depth = 0, str: string | null = null;
    const tplStack: number[] = [];
    for (; i < appSrc.length; i++) {
      const ch = appSrc[i], nx = appSrc[i + 1];
      if (str) {
        if (ch === "\\") { i++; continue; }
        if (str === "`" && ch === "$" && nx === "{") { tplStack.push(depth + 1); str = null; depth++; i++; continue; }
        if (ch === str) str = null;
        continue;
      }
      if (ch === "/" && nx === "/") { while (i < appSrc.length && appSrc[i] !== "\n") i++; continue; }
      if (ch === "/" && nx === "*") { i += 2; while (!(appSrc[i] === "*" && appSrc[i + 1] === "/")) i++; i++; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (tplStack.length && depth === tplStack[tplStack.length - 1] - 1) { tplStack.pop(); str = "`"; continue; }
        if (depth === 0 && !tplStack.length) return appSrc.slice(m.index, i + 1);
      }
    }
    throw new Error("unbalanced braces in " + name);
  }

  test("list view: drop zone accepts .vcf, batch cards show CSV/VCF source badges", async () => {
    let html = "";
    const batches = [
      { id: 7, name: "Q3 list", filename: "q3.csv", source: "csv", status: "open", created_at: "2026-09-20 10:00", summary: { total: 14, clean: 3, duplicates: 4, flagged: 7 } },
      { id: 8, name: "Phone exports", filename: "exports.vcf", source: "vcf", status: "open", created_at: "2026-09-20 11:00", summary: { total: 5, clean: 4, duplicates: 1, flagged: 0 } },
    ];
    const scope: any = {
      esc,
      view: { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } },
      sbOpenBatch: null,
      GET: async () => ({ batches }),
      POST: async () => { throw new Error("not expected"); },
      DEL: async () => ({}),
      route: () => {},
      confirm: () => true,
      $: (sel: string) => mkEl(),
      document: { querySelectorAll: () => [] },
      location: { hash: "" },
      FileReader: function (this: any) { this.readAsText = (f: any) => {}; },
      SB_STATUS_PILL: {}, SB_DECISION_PILL: {},
    };
    const vSandbox = new Function(...Object.keys(scope), `${extractUiFn("vSandbox")}; return vSandbox;`)(...Object.values(scope));
    await vSandbox(undefined);
    expect(html).toContain('accept=".csv,.vcf');
    expect(html).toContain("CSV or VCF");
    expect(html).toContain(">CSV<");
    expect(html).toContain(">VCF<");
    expect(html).toContain("exports.vcf");
  });

  test("detail view: source badge appears in the header", async () => {
    let html = "";
    const batch = { id: 8, name: "Phone exports", filename: "exports.vcf", source: "vcf", status: "open", created_at: "2026-09-20 11:00", summary: { total: 1, clean: 1, duplicates: 0, flagged: 0, approved: 0, rejected: 0 } };
    const rows = [
      { id: 1, row_num: 1, name: "Jürgen Müller", title: "", email: "jurgen@example.com", phone: "", company: "", status: "clean", decision: "pending", dup_contact: null, dup_row: null, flags: [] },
    ];
    const els: Record<string, any> = {};
    const scope: any = {
      esc,
      view: {},
      sbOpenBatch: 8,
      GET: async () => ({ batch, rows }),
      PATCH: async () => ({}),
      POST: async () => ({}),
      DEL: async () => ({}),
      route: () => {},
      confirm: () => true,
      openModal: () => {},
      field: (l: string, i: string) => l + i,
      input: (n: string, v: string) => n + v,
      $: (sel: string) => (els[sel] = els[sel] || mkEl()),
      document: { querySelectorAll: () => [] },
      SB_STATUS_PILL: { clean: ["Clean", "var(--ok)"] },
      SB_DECISION_PILL: { pending: ["Pending", "var(--text-3)"], approved: ["Approved", "var(--ok)"], rejected: ["Rejected", "var(--ctp-red)"] },
    };
    const host = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } };
    const vSandboxDetail = new Function(...Object.keys(scope), `${extractUiFn("vSandboxDetail")}; return vSandboxDetail;`)(...Object.values(scope));
    await vSandboxDetail(host, 8);
    expect(html).toContain("Phone exports");
    expect(html).toContain(">VCF<");
    expect(html).toContain("Jürgen Müller");
  });
});
