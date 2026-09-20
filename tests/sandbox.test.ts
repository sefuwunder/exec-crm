// tests/sandbox.test.ts — data sandbox: staged mass contact imports.
// Dedup (exact/fuzzy/within-batch/existing), flag rules, commit-only-approved,
// batch delete safety, workspace scoping, plus a DOM-stubbed sandbox tab render.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");

const NASTY = [
  "name,email,phone,company,title,notes,extra",
  "Amara Okafor,amara@meridianlog.com,555-0100,Meridian Logistics,COO,,x",
  "David A. Reyes,d.reyes2@meridianlog.com,,Meridian Logistics,VP Ops,,x",
  "Zara Quinn,zara@quinn.com,555-0200,Quinn Co,Founder,,x",
  "Zara Q. Quinn,zara.quinn@quinn.com,555-0201,Quinn Co,Founder,,x",
  "Yuki Tanaka,yuki@tanaka.com,555-0202,,,,x",
  "Yuki Tanaka,yuki@tanaka.com,555-0203,,,,x",
  "Jane Doe,not-an-email,555-0100,Acme,VP,,x",
  ",noname@example.com,555-0101,,,,x",
  "asdf,asdf@example.com,555-0102,,,,x",
  "JOHN SMITH,john@smith.com,555-0103,,,,x",
  "marie curie,marie@curie.com,555-0104,,,,x",
  "Bob Badphone,bob@bad.com,abc123,,,,x",
  `${"a".repeat(130)},long@name.com,555-0105,,,,x`,
  "Clean Person,clean@example.com,555-0199,Acme Inc,Engineer,Met at conference,x",
].join("\n");

describe("sandbox API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3474";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json() };
  };
  let mainId: number, betaId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-sandbox-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3474", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore", stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const { data } = await api("GET", "/api/workspaces");
    mainId = data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
  });
  afterAll(async () => { proc?.kill(); await rm(dir, { recursive: true, force: true }); });

  test("upload: statuses and summary across exact, fuzzy, within-batch dups and flags", async () => {
    const { status, data } = await api("POST", "/api/sandbox/batches", { name: "Nasty", filename: "nasty.csv", csv: NASTY }, mainId);
    expect(status).toBe(201);
    expect(data.summary.total).toBe(14);
    expect(data.summary.clean).toBe(3);
    expect(data.summary.duplicates).toBe(4);
    expect(data.summary.flagged).toBe(7);

    const detail = (await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId)).data;
    const byNum = new Map(detail.rows.map((r: any) => [r.row_num, r]));
    // 1: exact email dup of the seeded Amara Okafor
    expect(byNum.get(1).status).toBe("duplicate");
    expect(byNum.get(1).dup_contact.name).toBe("Amara Okafor");
    // 2: fuzzy name dup of the seeded David Reyes ("David A. Reyes")
    expect(byNum.get(2).status).toBe("duplicate");
    expect(byNum.get(2).dup_contact.name).toBe("David Reyes");
    // 4: within-batch dup of row 3 (same first+last name token)
    expect(byNum.get(4).status).toBe("duplicate");
    expect(byNum.get(4).dup_contact).toBeNull();
    expect(byNum.get(4).dup_row.row_num).toBe(3);
    // 6: within-batch dup of row 5 (exact email)
    expect(byNum.get(6).status).toBe("duplicate");
    expect(byNum.get(6).dup_row.row_num).toBe(5);
    // flags
    const codes = (n: number) => byNum.get(n).flags.map((f: any) => f.code);
    expect(byNum.get(7).status).toBe("flagged");
    expect(codes(7)).toContain("bad-email");
    expect(codes(8)).toContain("missing-name");
    expect(codes(9)).toContain("junk");
    expect(codes(10)).toContain("all-caps");
    expect(codes(11)).toContain("no-caps");
    expect(codes(12)).toContain("bad-phone");
    expect(codes(13)).toContain("too-long");
    // clean rows carry no flags
    expect(byNum.get(14).status).toBe("clean");
    expect(byNum.get(14).flags).toEqual([]);
    // every flag has a human reason
    for (const r of detail.rows) for (const f of r.flags) {
      expect(typeof f.reason).toBe("string");
      expect(f.reason.length).toBeGreaterThan(5);
    }
  });

  test("upload: semicolon-delimited files are rejected plainly; missing columns tolerated", async () => {
    const semi = await api("POST", "/api/sandbox/batches", { csv: "name;email\nJane;jane@x.com" }, mainId);
    expect(semi.status).toBe(400);
    expect(semi.data.error).toMatch(/semicolon/i);
    const { status, data } = await api("POST", "/api/sandbox/batches", { name: "EmailOnly", csv: "email\nsolo@example.com" }, mainId);
    expect(status).toBe(201);
    expect(data.summary.flagged).toBe(1); // missing-name flag, no crash
    const detail = (await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId)).data;
    expect(detail.rows[0].name).toBe("");
  });

  test("commit: only approved rows land in contacts; duplicates skipped even when approved", async () => {
    const before = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts.length;
    const { data } = await api("POST", "/api/sandbox/batches", { name: "CommitMe", csv: NASTY }, mainId);
    const id = data.batch.id;
    const detail = (await api("GET", `/api/sandbox/batches/${id}`, undefined, mainId)).data;
    const rowId = (n: number) => detail.rows.find((r: any) => r.row_num === n).id;
    // approve the 3 clean rows + deliberately approve a duplicate row
    for (const n of [3, 5, 14]) await api("PATCH", `/api/sandbox/rows/${rowId(n)}`, { decision: "approved" }, mainId);
    await api("PATCH", `/api/sandbox/rows/${rowId(1)}`, { decision: "approved" }, mainId);
    const commit = await api("POST", `/api/sandbox/batches/${id}/commit`, {}, mainId);
    expect(commit.status).toBe(200);
    expect(commit.data.imported).toBe(3);
    expect(commit.data.skipped).toBe(1);
    const contacts = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts;
    expect(contacts.length).toBe(before + 3);
    expect(contacts.some((c: any) => c.name === "Clean Person")).toBe(true);
    expect(contacts.filter((c: any) => c.email === "amara@meridianlog.com")).toHaveLength(1);
    // second commit is refused
    const again = await api("POST", `/api/sandbox/batches/${id}/commit`, {}, mainId);
    expect(again.status).toBe(400);
    // completed batch rows are locked
    const locked = await api("PATCH", `/api/sandbox/rows/${rowId(3)}`, { decision: "rejected" }, mainId);
    expect(locked.status).toBe(400);
  });

  test("bulk: approve-clean and reject-duplicates", async () => {
    const csv = [
      "name,email",
      "Bulk Clean One,bulkclean1@unique-test.dev",
      "Bulk Clean Two,bulkclean2@unique-test.dev",
      "Amara Okafor,amara@meridianlog.com",
      "Bulk Clean One,bulkclean1@unique-test.dev",
    ].join("\n");
    const { data } = await api("POST", "/api/sandbox/batches", { name: "Bulk", csv }, mainId);
    const id = data.batch.id;
    expect(data.summary.clean).toBe(2);
    expect(data.summary.duplicates).toBe(2);
    const a = await api("POST", `/api/sandbox/batches/${id}/decision`, { action: "approve-clean" }, mainId);
    expect(a.data.changed).toBe(2);
    const r = await api("POST", `/api/sandbox/batches/${id}/decision`, { action: "reject-duplicates" }, mainId);
    expect(r.data.changed).toBe(2);
    expect(r.data.summary.approved).toBe(2);
    expect(r.data.summary.rejected).toBe(2);
    const bad = await api("POST", `/api/sandbox/batches/${id}/decision`, { action: "explode" }, mainId);
    expect(bad.status).toBe(400);
  });

  test("row edit re-analyzes: fixing a bad email clears the flag", async () => {
    const { data } = await api("POST", "/api/sandbox/batches", { name: "FixMe", csv: NASTY }, mainId);
    const detail = (await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId)).data;
    const row7 = detail.rows.find((r: any) => r.row_num === 7);
    const upd = await api("PATCH", `/api/sandbox/rows/${row7.id}`, { email: "jane@acme.com" }, mainId);
    expect(upd.status).toBe(200);
    expect(upd.data.row.email).toBe("jane@acme.com");
    const detail2 = (await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId)).data;
    const fixed = detail2.rows.find((r: any) => r.row_num === 7);
    expect(fixed.status).toBe("clean");
    expect(fixed.flags).toEqual([]);
  });

  test("batch delete removes staged rows only — live contacts untouched", async () => {
    const before = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts.length;
    const { data } = await api("POST", "/api/sandbox/batches", { name: "Doomed", csv: NASTY }, mainId);
    const del = await api("DELETE", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId);
    expect(del.data.deleted_rows).toBe(14);
    const after = (await api("GET", "/api/contacts", undefined, mainId)).data.contacts.length;
    expect(after).toBe(before);
    const gone = await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId);
    expect(gone.status).toBe(404);
  });

  test("workspace scoping: batches isolated, dedup never crosses workspaces", async () => {
    // Amara's email is a duplicate in Main, but clean in Beta
    const csv = "name,email\nAmara Okafor,amara@meridianlog.com";
    const { data } = await api("POST", "/api/sandbox/batches", { name: "BetaBatch", csv }, betaId);
    expect(data.summary.duplicates).toBe(0);
    expect(data.summary.clean).toBe(1);
    // Main cannot see Beta's batch
    const peek = await api("GET", `/api/sandbox/batches/${data.batch.id}`, undefined, mainId);
    expect(peek.status).toBe(404);
    const mainList = (await api("GET", "/api/sandbox/batches", undefined, mainId)).data.batches;
    expect(mainList.some((b: any) => b.id === data.batch.id)).toBe(false);
  });
});

// ---- function extractor (same brace-counting approach as the other UI suites)
function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index + m[0].length - 1, pdepth = 0;
  let str: string | null = null;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (ch === "\\") { i++; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") { str = ch; continue; }
    if (ch === "(") pdepth++;
    else if (ch === ")") { if (--pdepth === 0) break; }
  }
  let depth = 0;
  str = null;
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

describe("sandbox tab (DOM-stubbed)", () => {
  const esc = (s: any) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const mkEl = (extra: any = {}) => ({
    addEventListener: () => {},
    set onchange(f: any) {},
    classList: { add: () => {}, remove: () => {} },
    dataset: {},
    ...extra,
  });
  test("WORKSHOP_TABS has the sandbox tab and vWorkshop dispatches vSandbox", () => {
    expect(appSrc).toContain('["sandbox", "Sandbox"]');
    expect(appSrc).toContain('else if (tab === "sandbox") await vSandbox(root);');
  });
  test("list view renders drop zone, batch cards with counts, and upload wiring", async () => {
    let html = "";
    const batches = [{
      id: 7, name: "Q3 list", filename: "q3.csv", status: "open", created_at: "2026-09-20 10:00",
      summary: { total: 14, clean: 3, duplicates: 4, flagged: 7 },
    }];
    const fileInput = mkEl();
    const drop = mkEl();
    let fileReaderCb: any = null;
    const scope: any = {
      esc,
      view: { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } },
      sbOpenBatch: null,
      GET: async (p: string) => ({ batches }),
      POST: async () => { throw new Error("not expected"); },
      DEL: async () => ({}),
      route: () => {},
      confirm: () => true,
      $: (sel: string) => (sel === "#sb-file" ? fileInput : sel === "#sb-drop" ? drop : sel === "#sb-status" ? mkEl() : mkEl()),
      document: { querySelectorAll: () => [] },
      location: { hash: "" },
      FileReader: function (this: any) { this.readAsText = (f: any) => {}; },
      SB_STATUS_PILL: {}, SB_DECISION_PILL: {},
    };
    const vSandbox = new Function(...Object.keys(scope), `${extractFn(appSrc, "vSandbox")}; return vSandbox;`)(...Object.values(scope));
    await vSandbox(undefined);
    expect(html).toContain('id="sb-drop"');
    expect(html).toContain("Q3 list");
    expect(html).toContain("q3.csv");
    expect(html).toContain("14</b> rows");
    expect(html).toContain("4 duplicates");
    expect(html).toContain("3 clean");
    expect(html).toContain('data-sb-open="7"');
    expect(html).toContain("CSV template");
  });
  test("detail view renders summary, status pills, flag reasons and decision controls", async () => {
    let html = "";
    const batch = { id: 7, name: "Q3 list", filename: "q3.csv", status: "open", created_at: "2026-09-20 10:00", summary: { total: 2, clean: 1, duplicates: 1, flagged: 0, approved: 0, rejected: 0 } };
    const rows = [
      { id: 1, row_num: 1, name: "Amara Okafor", title: "COO", email: "amara@meridianlog.com", phone: "", company: "Meridian", status: "duplicate", decision: "pending", dup_contact: { id: 3, name: "Amara Okafor" }, dup_row: null, flags: [] },
      { id: 2, row_num: 2, name: "Jane Doe", title: "", email: "not-an-email", phone: "", company: "", status: "flagged", decision: "pending", dup_contact: null, dup_row: null, flags: [{ code: "bad-email", reason: '"not-an-email" is not a valid email address.' }] },
    ];
    const els: Record<string, any> = {};
    const el = (sel: string) => (els[sel] = els[sel] || mkEl());
    const scope: any = {
      esc,
      view: {},
      sbOpenBatch: 7,
      GET: async () => ({ batch, rows }),
      PATCH: async () => ({}),
      POST: async () => ({}),
      DEL: async () => ({}),
      route: () => {},
      confirm: () => true,
      openModal: () => {},
      field: (l: string, i: string) => l + i,
      input: (n: string, v: string) => n + v,
      $: el,
      document: { querySelectorAll: () => [] },
      SB_STATUS_PILL: { clean: ["Clean", "var(--ok)"], duplicate: ["Duplicate", "var(--urgent)"], flagged: ["Flagged", "var(--ctp-yellow)"] },
      SB_DECISION_PILL: { approved: ["Approved", "var(--ok)"], rejected: ["Rejected", "var(--ctp-red)"], pending: ["Pending", "var(--text-3)"] },
    };
    const host = { set innerHTML(v: string) { html = v; }, get innerHTML() { return html; } };
    const vSandboxDetail = new Function(...Object.keys(scope), `${extractFn(appSrc, "vSandboxDetail")}; return vSandboxDetail;`)(...Object.values(scope));
    await vSandboxDetail(host, 7);
    expect(html).toContain("Q3 list");
    expect(html).toContain("Import approved (0)");
    expect(html).toContain("Duplicate");
    expect(html).toContain("matches <b>Amara Okafor</b>");
    expect(html).toContain("⚠ 1 flag");
    expect(html).toContain("not a valid email address");
    expect(html).toContain('data-sb-approve="1"');
    expect(html).toContain('data-sb-edit="2"');
    expect(html).toContain("Approve all clean");
    expect(html).toContain("Reject all duplicates");
  });
});
