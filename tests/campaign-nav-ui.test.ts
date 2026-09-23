// tests/campaign-nav-ui.test.ts — contacts/companies live inside campaigns now:
// nav entries removed, quick-add from campaign detail, drafts in the new-campaign modal.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { readFileSync } from "fs";

const appSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "app.js"), "utf8");
const indexSrc = readFileSync(join(new URL(".", import.meta.url).pathname, "..", "public", "index.html"), "utf8");

// Extract a top-level `function name(...)` (optionally async) block from app.js.
// Brace counting skips strings/comments; valid for the small helpers tested here.
function extractFn(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error("fn not found: " + name);
  let i = m.index, depth = 0;
  let str: string | null = null;
  const tplStack: number[] = []; // depths where a ${ was opened
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

// Local mirrors of the tiny app.js helpers (only the behavior under test is mirrored).
const escT = (s: any) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const fieldT = (label: string, inner: string) => `<div class="field"><label>${label}</label>${inner}</div>`;
const inputT = (name: string, val: any = "") => `<input name="${name}" value="${val}">`;
const selectT = (name: string, options: [any, string][], val: any = "") =>
  `<select name="${name}">${options.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? "selected" : ""}>${l}</option>`).join("")}</select>`;

describe("nav: pipeline is no longer top-level", () => {
  test("sidebar nav has no pipeline entry, keeps the rest", () => {
    const nav = indexSrc.match(/<nav class="nav" id="nav">[\s\S]*?<\/nav>/)![0];
    expect(nav).not.toContain('data-r="pipeline"');
    for (const r of ["dashboard", "feed", "campaigns", "captures", "schema", "automations"]) {
      expect(nav).toContain(`data-r="${r}"`);
    }
  });

  test("Cmd+K 'Go to' list drops pipeline", () => {
    const navBlock = appSrc.match(/const NAV = \[[\s\S]*?\];/)![0];
    expect(navBlock).not.toContain('"#/pipeline"');
    expect(navBlock).toContain('"#/campaigns"');
  });

  test("no visible href points at the pipeline view", () => {
    expect(appSrc).not.toContain('href="#/pipeline"');
  });

  test("pipeline deal hits jump to the campaign detail when linked, campaigns otherwise", () => {
    expect(appSrc).toContain("location.hash = d.campaign_id ? `#/campaigns/${d.campaign_id}` : \"#/campaigns\";");
  });

  test("router no longer dispatches a pipeline view", () => {
    expect(appSrc).not.toContain("pipeline: vPipeline");
  });
});

// ---------------------------------------------------------------- contacts/companies nav (from the earlier move)
describe("nav: contacts/companies are no longer top-level", () => {
  test("sidebar nav has no contacts/companies entries, keeps the rest", () => {
    const nav = indexSrc.match(/<nav class="nav" id="nav">[\s\S]*?<\/nav>/)![0];
    expect(nav).not.toContain('data-r="contacts"');
    expect(nav).not.toContain('data-r="companies"');
    for (const r of ["dashboard", "feed", "campaigns", "captures", "schema", "automations"]) {
      expect(nav).toContain(`data-r="${r}"`);
    }
  });

  test("Cmd+K 'Go to' list drops contacts/companies, keeps campaigns", () => {
    const navBlock = appSrc.match(/const NAV = \[[\s\S]*?\];/)![0];
    expect(navBlock).not.toContain('"#/contacts"');
    expect(navBlock).not.toContain('"#/companies"');
    expect(navBlock).toContain('"#/campaigns"');
  });

  test("no visible href points at the contacts/companies views", () => {
    expect(appSrc).not.toContain('href="#/contacts"');
    expect(appSrc).not.toContain('href="#/companies"');
  });

  test("the views themselves still exist for direct navigation (no dead route)", () => {
    expect(appSrc).toContain("async function vContacts()");
    expect(appSrc).toContain("async function vCompanies()");
  });

  test("palette contact/company hits jump to the campaign detail when linked", () => {
    expect(appSrc).toContain("location.hash = c.campaign_id ? `#/campaigns/${c.campaign_id}`");
  });
});

// ---------------------------------------------------------------- campaign detail add actions
describe("campaign detail: add contact / add company", () => {
  test("contacts panel renders an Add contact button", () => {
    const fn = new Function("esc", extractFn(appSrc, "campaignContactsHtml") + "\nreturn campaignContactsHtml([]);");
    const html = fn(escT);
    expect(html).toContain('id="add-campaign-contact"');
    expect(html).toContain("+ Add contact");
  });

  test("companies panel renders an Add company button", () => {
    const fn = new Function("esc", extractFn(appSrc, "campaignCompaniesHtml") + "\nreturn campaignCompaniesHtml([]);");
    const html = fn(escT);
    expect(html).toContain('id="add-campaign-company"');
    expect(html).toContain("+ Add company");
  });

  test("newContactModal preselects the campaign passed from the detail view", async () => {
    let captured: any = null;
    const fn = new Function(
      "GET", "getSchemaFields", "cfFieldsHtml", "openModal", "field", "input", "select", "POST", "route", "esc",
      extractFn(appSrc, "newContactModal") + "\nreturn newContactModal(7);");
    await fn(
      async (p: string) => p.includes("campaigns") ? { campaigns: [{ id: 7, name: "Camp 7" }] } : { companies: [] },
      async () => [],
      (f: any) => { if (!Array.isArray(f)) throw new Error("cfFieldsHtml got non-array fields"); return ""; },
      (_t: string, body: string) => { captured = body; },
      fieldT, inputT, selectT,
      async () => ({}), () => {}, escT);
    expect(captured).toContain('name="campaign_id"');
    expect(captured).toContain('value="7" selected');
  });

  test("newCompanyModal preselects the campaign passed from the detail view", async () => {
    let captured: any = null;
    const fn = new Function(
      "GET", "getSchemaFields", "cfFieldsHtml", "openModal", "field", "input", "select", "POST", "route", "esc",
      extractFn(appSrc, "newCompanyModal") + "\nreturn newCompanyModal(9);");
    await fn(
      async (p: string) => p.includes("campaigns") ? { campaigns: [{ id: 9, name: "Camp 9" }] } : { companies: [] },
      async () => [],
      (f: any) => { if (!Array.isArray(f)) throw new Error("cfFieldsHtml got non-array fields"); return ""; },
      (_t: string, body: string) => { captured = body; },
      fieldT, inputT, selectT,
      async () => ({}), () => {}, escT);
    expect(captured).toContain('name="campaign_id"');
    expect(captured).toContain('value="9" selected');
  });
});

// ---------------------------------------------------------------- new-campaign drafts
describe("new-campaign modal: contact/company drafts", () => {
  test("draft rows carry no name attributes (openModal collector ignores them)", () => {
    for (const fnName of ["draftContactRowHtml", "draftCompanyRowHtml"]) {
      const fn = new Function(extractFn(appSrc, fnName) + `\nreturn ${fnName}();`);
      const html = fn() as string;
      expect(html).not.toContain("name=");
    }
    const contact = new Function(extractFn(appSrc, "draftContactRowHtml") + "\nreturn draftContactRowHtml();")() as string;
    const company = new Function(extractFn(appSrc, "draftCompanyRowHtml") + "\nreturn draftCompanyRowHtml();")() as string;
    expect(contact).toContain("data-draft-contact");
    expect(company).toContain("data-draft-company");
  });

  test("collectDrafts skips blank rows, keeps filled ones with kind + body", () => {
    const mkRow = (nameVal: string, extraVal: string) => ({
      querySelector: (sel: string) => ({ value: sel === ".draft-name" ? nameVal : extraVal }),
    });
    (globalThis as any).document = {
      querySelectorAll: (sel: string) =>
        sel.includes("contact")
          ? [mkRow("Ada Lovelace", "ada@example.com"), mkRow("   ", "blank@example.com")]
          : [mkRow("Acme", "acme.example"), mkRow("", "")],
    };
    try {
      const drafts = new Function(extractFn(appSrc, "collectDrafts") + "\nreturn collectDrafts();")() as any[];
      expect(drafts).toHaveLength(2);
      expect(drafts[0]).toEqual({ kind: "contact", name: "Ada Lovelace", body: { name: "Ada Lovelace", email: "ada@example.com" } });
      expect(drafts[1]).toEqual({ kind: "company", name: "Acme", body: { name: "Acme", website: "acme.example" } });
    } finally {
      delete (globalThis as any).document;
    }
  });
});

// ---------------------------------------------------------------- API: the UI-shaped create-with-drafts flow
describe("create-campaign-with-drafts flow (API)", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3463";
  const api = async (method: string, p: string, body?: any, ws?: number | string) => {
    let url = BASE + p;
    if (ws !== undefined) url += (p.includes("?") ? "&" : "?") + `workspace=${ws}`;
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() as any };
  };
  let mainId: number, betaId: number, companyId: number, campaignId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-camp-drafts-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3463", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(BASE + "/api/workspaces"); if (r.ok) break; } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const w = await api("GET", "/api/workspaces");
    mainId = w.data.workspaces[0].id;
    betaId = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
    const cos = await api("GET", "/api/companies", undefined, mainId);
    companyId = cos.data.companies[0].id;
  });
  afterAll(async () => {
    proc?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("campaign + draft contacts/companies land linked via the filters", async () => {
    const c = await api("POST", "/api/campaigns", { name: "Draft flow", company_id: companyId }, mainId);
    expect(c.status).toBe(201);
    campaignId = c.data.campaign.id;
    // what the modal does per non-blank draft row
    const drafts = [
      ["contacts", { name: "Draft Ada", email: "ada@draft.test", campaign_id: campaignId }],
      ["contacts", { name: "Draft Bob", campaign_id: campaignId }],
      ["companies", { name: "Draft Acme", website: "acme.test", campaign_id: campaignId }],
    ] as const;
    for (const [path, body] of drafts) {
      const r = await api("POST", `/api/${path}`, body, mainId);
      expect(r.status).toBe(201);
    }
    const ct = await api("GET", `/api/contacts?campaign_id=${campaignId}`, undefined, mainId);
    expect(ct.data.contacts.map((x: any) => x.name).sort()).toEqual(["Draft Ada", "Draft Bob"]);
    const co = await api("GET", `/api/companies?campaign_id=${campaignId}`, undefined, mainId);
    expect(co.data.companies.map((x: any) => x.name)).toEqual(["Draft Acme"]);
  });

  test("a failing draft does not block or roll back the campaign", async () => {
    const c = await api("POST", "/api/campaigns", { name: "Survivor", company_id: companyId }, mainId);
    expect(c.status).toBe(201);
    const bad = await api("POST", "/api/contacts", { name: "Ghost", campaign_id: 999999 }, mainId);
    expect(bad.status).toBe(400);
    const all = await api("GET", "/api/campaigns", undefined, mainId);
    expect(all.data.campaigns.map((x: any) => x.name)).toContain("Survivor");
  });

  test("workspace isolation holds for drafts", async () => {
    const f = await api("GET", `/api/contacts?campaign_id=${campaignId}`, undefined, betaId);
    expect(f.data.contacts).toHaveLength(0);
    const fco = await api("GET", `/api/companies?campaign_id=${campaignId}`, undefined, betaId);
    expect(fco.data.companies).toHaveLength(0);
  });
});
