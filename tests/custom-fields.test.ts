// tests/custom-fields.test.ts — /api/custom-fields CRUD, value upsert + validation,
// workspace isolation, detail-GET merge.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

describe("custom fields API", () => {
  let dir: string;
  let proc: any;
  const BASE = "http://localhost:3471";
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

  let mainWs: number, betaWs: number, contactId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "crm-cf-"));
    proc = Bun.spawn(["bun", "src/server.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, CRM_DB: join(dir, "test.db"), PORT: "3471", CRM_UPLOADS: join(dir, "uploads") },
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(BASE + "/api/workspaces");
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    const { data: wsData } = await api("GET", "/api/workspaces");
    mainWs = wsData.workspaces[0].id;
    betaWs = (await api("POST", "/api/workspaces", { name: "Beta" })).data.workspace.id;
    contactId = (await api("POST", "/api/contacts", { name: "CF Contact" }, mainWs)).data.contact.id;
  });

  afterAll(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  test("GET defs starts empty", async () => {
    const { status, data } = await api("GET", "/api/custom-fields?entity_type=contact", undefined, mainWs);
    expect(status).toBe(200);
    expect(data.fields).toEqual([]);
  });

  test("GET defs rejects missing/bad entity_type", async () => {
    expect((await api("GET", "/api/custom-fields", undefined, mainWs)).status).toBe(400);
    expect((await api("GET", "/api/custom-fields?entity_type=deal", undefined, mainWs)).status).toBe(400);
  });

  test("POST def → 201", async () => {
    const { status, data } = await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Renewal date", field_type: "date",
    }, mainWs);
    expect(status).toBe(201);
    expect(data.field.label).toBe("Renewal date");
    expect(data.field.type).toBe("date");
    expect(data.field.entity).toBe("contact");
  });

  test("POST def rejects duplicates case-insensitively", async () => {
    const { status, data } = await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "RENEWAL Date", field_type: "text",
    }, mainWs);
    expect(status).toBe(400);
    expect(data.error).toMatch(/already exists/);
  });

  test("POST def rejects blank name, bad type, bad entity", async () => {
    const b = (body: any) => api("POST", "/api/custom-fields", body, mainWs);
    expect((await b({ entity_type: "contact", name: "  ", field_type: "text" })).status).toBe(400);
    expect((await b({ entity_type: "contact", name: "X", field_type: "dropdown" })).status).toBe(400);
    expect((await b({ entity_type: "deal", name: "X", field_type: "text" })).status).toBe(400);
    expect((await b({ entity_type: "contact", name: "email", field_type: "text" })).status).toBe(400); // built-in
  });

  test("defs are workspace-isolated", async () => {
    const { status, data } = await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Renewal date", field_type: "date",
    }, betaWs);
    expect(status).toBe(201); // same name OK in another workspace
    const main = await api("GET", "/api/custom-fields?entity_type=contact", undefined, mainWs);
    expect(main.data.fields.map((f: any) => f.workspace_id)).toEqual([mainWs]);
  });

  test("PUT value upserts text", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Tier", field_type: "text",
    }, mainWs)).data.field;
    const { status, data } = await api("PUT", "/api/custom-fields/values", {
      field_id: def.id, entity_id: contactId, value: "Gold",
    }, mainWs);
    expect(status).toBe(200);
    expect(data.value).toBe("Gold");
    // overwrite
    const again = await api("PUT", "/api/custom-fields/values", {
      field_id: def.id, entity_id: contactId, value: "Platinum",
    }, mainWs);
    expect(again.data.value).toBe("Platinum");
  });

  test("PUT validates number", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Score", field_type: "number",
    }, mainWs)).data.field;
    const put = (value: any) => api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: contactId, value }, mainWs);
    expect((await put("42")).status).toBe(200);
    expect((await put("4.5")).status).toBe(200);
    expect((await put("abc")).status).toBe(400);
    expect((await put("12px")).status).toBe(400);
  });

  test("PUT validates date as a real YYYY-MM-DD", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Start day", field_type: "date",
    }, mainWs)).data.field;
    const put = (value: any) => api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: contactId, value }, mainWs);
    expect((await put("2026-10-01")).status).toBe(200);
    expect((await put("2026-02-30")).status).toBe(400); // not a real date
    expect((await put("10/01/2026")).status).toBe(400);
    expect((await put("tomorrow")).status).toBe(400);
  });

  test("PUT validates checkbox", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "VIP", field_type: "checkbox",
    }, mainWs)).data.field;
    const put = (value: any) => api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: contactId, value }, mainWs);
    expect((await put("yes")).data.value).toBe("1");
    expect((await put("no")).data.value).toBe("0");
    expect((await put("TRUE")).data.value).toBe("1");
    expect((await put("maybe")).status).toBe(400);
  });

  test("PUT empty string clears the value", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "contact", name: "Note2", field_type: "text",
    }, mainWs)).data.field;
    await api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: contactId, value: "x" }, mainWs);
    const { status, data } = await api("PUT", "/api/custom-fields/values", {
      field_id: def.id, entity_id: contactId, value: "",
    }, mainWs);
    expect(status).toBe(200);
    expect(data.cleared).toBe(true);
    const vals = await api("GET", `/api/custom-fields/values?entity_type=contact&entity_id=${contactId}`, undefined, mainWs);
    expect(vals.data.values.find((v: any) => v.field_id === def.id).value).toBe("");
  });

  test("PUT rejects unknown field / foreign entity", async () => {
    const put = (body: any, ws: number) => api("PUT", "/api/custom-fields/values", body, ws);
    expect((await put({ field_id: 99999, entity_id: contactId, value: "x" }, mainWs)).status).toBe(404);
    expect((await put({ field_id: 1, entity_id: 99999, value: "x" }, mainWs)).status).toBe(404);
    // beta workspace cannot write main's field
    expect((await put({ field_id: 1, entity_id: contactId, value: "x" }, betaWs)).status).toBe(404);
  });

  test("GET values merges defs with values", async () => {
    const { status, data } = await api(
      "GET", `/api/custom-fields/values?entity_type=contact&entity_id=${contactId}`, undefined, mainWs);
    expect(status).toBe(200);
    const names = data.values.map((v: any) => v.name);
    expect(names).toContain("Renewal date");
    expect(names).toContain("Tier");
    for (const v of data.values) {
      expect(v).toHaveProperty("field_id");
      expect(v).toHaveProperty("field_type");
      expect(typeof v.value).toBe("string");
    }
    expect((await api("GET", "/api/custom-fields/values?entity_type=contact&entity_id=99999", undefined, mainWs)).status).toBe(404);
  });

  test("detail GET includes custom_fields array", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "company", name: "Region", field_type: "text",
    }, mainWs)).data.field;
    const coId = (await api("POST", "/api/companies", { name: "CF Co" }, mainWs)).data.company.id;
    await api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: coId, value: "EMEA" }, mainWs);
    const { data } = await api("GET", "/api/companies", undefined, mainWs);
    const co = data.companies.find((c: any) => c.id === coId);
    expect(co.custom_fields).toEqual([{ id: def.id, name: "Region", field_type: "text", value: "EMEA" }]);
  });

  test("DELETE def cascades values; foreign def → 404", async () => {
    const def = (await api("POST", "/api/custom-fields", {
      entity_type: "task", name: "Gone", field_type: "text",
    }, mainWs)).data.field;
    const tId = (await api("POST", "/api/tasks", { title: "CF task" }, mainWs)).data.task.id;
    await api("PUT", "/api/custom-fields/values", { field_id: def.id, entity_id: tId, value: "v" }, mainWs);
    expect((await api("DELETE", `/api/custom-fields/${def.id}`, undefined, mainWs)).status).toBe(200);
    const vals = await api("GET", `/api/custom-fields/values?entity_type=task&entity_id=${tId}`, undefined, mainWs);
    expect(vals.data.values).toEqual([]);
    // other workspace's def is not deletable here
    const betaDef = (await api("GET", "/api/custom-fields?entity_type=contact", undefined, betaWs)).data.fields[0];
    expect((await api("DELETE", `/api/custom-fields/${betaDef.id}`, undefined, mainWs)).status).toBe(404);
  });
});
