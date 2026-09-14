import { openDb, seedIfEmpty, STAGES, STAGE_LABELS } from "./db";

const PORT = Number(process.env.PORT || 3001);
const db = openDb(process.env.CRM_DB || "./crm.db");
seedIfEmpty(db);

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

function getCustomFields(entity: string) {
  return db
    .query("SELECT * FROM custom_fields WHERE entity = ? ORDER BY position, id")
    .all(entity) as any[];
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
function saveCustomValues(entity: string, recordId: number, custom: unknown) {
  if (!custom || typeof custom !== "object") return;
  const byId = new Map(getCustomFields(entity).map((f: any) => [String(f.id), f]));
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

function logActivity(kind: string, text: string) {
  db.prepare("INSERT INTO activities (kind, text) VALUES (?, ?)").run(kind, text);
}

async function fireWebhooks(event: string, payload: Record<string, unknown>) {
  const hooks = db
    .query("SELECT * FROM webhooks WHERE active = 1")
    .all() as any[];
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
        headers: { "Content-Type": "application/json", "X-CRM-Event": event },
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

function dealJson(id: number) {
  return db
    .query(
      `SELECT d.*, c.name AS company_name, ct.name AS contact_name
       FROM deals d
       LEFT JOIN companies c ON c.id = d.company_id
       LEFT JOIN contacts ct ON ct.id = d.contact_id
       WHERE d.id = ?`
    )
    .get(id);
}

// ---------------------------------------------------------------- helpers
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
            : "text/html";
        return new Response(f, { headers: { "Content-Type": type } });
      }
      return new Response("not found", { status: 404 });
    }

    // ---- KPIs
    if (path === "/api/kpis" && method === "GET") {
      const open = db
        .query(
          `SELECT COUNT(*) n, COALESCE(SUM(value),0) v,
                  COALESCE(SUM(value * probability / 100.0),0) w
           FROM deals WHERE stage NOT IN ('closed_won','closed_lost')`
        )
        .get() as any;
      const wonQ = db
        .query(
          `SELECT COALESCE(SUM(value),0) v FROM deals
           WHERE stage = 'closed_won' AND expected_close >= '2026-07-01'`
        )
        .get() as any;
      const byStage = db
        .query(
          `SELECT stage, COUNT(*) n, COALESCE(SUM(value),0) v FROM deals
           GROUP BY stage`
        )
        .all() as any[];
      const tasksOpen = (
        db.query("SELECT COUNT(*) n FROM tasks WHERE done = 0").get() as any
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
      const rows = db
        .query(
          `SELECT d.*, c.name AS company_name, ct.name AS contact_name
           FROM deals d
           LEFT JOIN companies c ON c.id = d.company_id
           LEFT JOIN contacts ct ON ct.id = d.contact_id
           ORDER BY d.updated_at DESC`
        )
        .all();
      return json({ deals: rows, stages: STAGES, labels: STAGE_LABELS });
    }
    if (path === "/api/deals" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare(
          `INSERT INTO deals (title, company_id, contact_id, value, stage,
           probability, expected_close, owner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          b.title || "Untitled deal",
          b.company_id || null,
          b.contact_id || null,
          Number(b.value || 0),
          b.stage && STAGES.includes(b.stage) ? b.stage : "prospecting",
          Number(b.probability ?? 10),
          b.expected_close || "",
          b.owner || ""
        );
      const deal = dealJson(Number(r.lastInsertRowid));
      logActivity("deal", `${(deal as any).title} created`);
      fireWebhooks("deal.created", deal as any);
      return json({ deal }, 201);
    }
    const dealId = path.match(/^\/api\/deals\/(\d+)$/);
    if (dealId && method === "PATCH") {
      const b = await readBody(req);
      const before = dealJson(Number(dealId[1])) as any;
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["title", "value", "stage", "probability", "expected_close", "owner", "company_id", "contact_id"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(b[k]);
        }
      }
      if (sets.length) {
        sets.push("updated_at = datetime('now')");
        db.prepare(`UPDATE deals SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(dealId[1]));
      }
      const after = dealJson(Number(dealId[1])) as any;
      if (before && after && before.stage !== after.stage) {
        logActivity("deal", `${after.title} moved to ${STAGE_LABELS[after.stage]}`);
        fireWebhooks("deal.stage_changed", {
          ...after,
          previous_stage: before.stage,
        });
      } else if (after) {
        fireWebhooks("deal.updated", after);
      }
      return json({ deal: after });
    }
    if (dealId && method === "DELETE") {
      db.prepare("DELETE FROM deals WHERE id = ?").run(Number(dealId[1]));
      return json({ ok: true });
    }

    // ---- contacts
    if (path === "/api/contacts" && method === "GET") {
      const q = url.searchParams.get("q") || "";
      const rows = attachCustom(
        "contact",
        db
          .query(
            `SELECT ct.*, c.name AS company_name FROM contacts ct
             LEFT JOIN companies c ON c.id = ct.company_id
             WHERE ct.name LIKE ? OR ct.email LIKE ?
             ORDER BY ct.name`
          )
          .all(`%${q}%`, `%${q}%`) as any[]
      );
      return json({ contacts: rows });
    }
    if (path === "/api/contacts" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare(
          "INSERT INTO contacts (company_id, name, title, email, phone) VALUES (?, ?, ?, ?, ?)"
        )
        .run(b.company_id || null, b.name || "Unnamed", b.title || "", b.email || "", b.phone || "");
      const id = Number(r.lastInsertRowid);
      saveCustomValues("contact", id, b.custom);
      const contact = attachCustom("contact", [
        db.query("SELECT * FROM contacts WHERE id = ?").get(id) as any,
      ])[0];
      fireWebhooks("contact.created", contact as any);
      return json({ contact }, 201);
    }

    const contactId = path.match(/^\/api\/contacts\/(\d+)$/);
    if (contactId && method === "PATCH") {
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["company_id", "name", "title", "email", "phone"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(k === "company_id" && b[k] === "" ? null : b[k]);
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE contacts SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(contactId[1]));
      }
      saveCustomValues("contact", Number(contactId[1]), b.custom);
      const updatedContact = attachCustom("contact", [
        db.query("SELECT * FROM contacts WHERE id = ?").get(Number(contactId[1])) as any,
      ])[0];
      return json({ contact: updatedContact });
    }

    // ---- CSV import: POST { csv: "..." } with header row
    // columns: name, title, company, email, phone (case-insensitive)
    if (path === "/api/contacts/import" && method === "POST") {
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
          .query("SELECT id FROM companies WHERE lower(name) = ?")
          .get(key) as any;
        const id = existing
          ? existing.id
          : Number(db.prepare("INSERT INTO companies (name) VALUES (?)").run(name.trim()).lastInsertRowid);
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
            .query("SELECT id FROM contacts WHERE lower(email) = ?")
            .get(email.toLowerCase()) as any;
          if (dup) { skipped++; return; }
        }
        try {
          db.prepare(
            "INSERT INTO contacts (company_id, name, title, email, phone) VALUES (?, ?, ?, ?, ?)"
          ).run(
            iCompany >= 0 ? companyIdFor(r[iCompany] || "") : null,
            name,
            iTitle >= 0 ? (r[iTitle] || "").trim() : "",
            email,
            iPhone >= 0 ? (r[iPhone] || "").trim() : ""
          );
          imported++;
        } catch (e) {
          errors.push(`Row ${line}: ${(e as Error).message}`);
        }
      });
      // bulk imports intentionally don't fire outgoing webhooks
      logActivity("contact", `Imported ${imported} contact${imported === 1 ? "" : "s"} from CSV`);
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

    // ---- companies
    if (path === "/api/companies" && method === "GET") {
      const rows = attachCustom(
        "company",
        db
          .query(
            `SELECT c.*, COUNT(d.id) AS deal_count,
                    COALESCE(SUM(CASE WHEN d.stage NOT IN ('closed_won','closed_lost') THEN d.value ELSE 0 END),0) AS open_value
             FROM companies c LEFT JOIN deals d ON d.company_id = c.id
             GROUP BY c.id ORDER BY open_value DESC`
          )
          .all() as any[]
      );
      return json({ companies: rows });
    }
    if (path === "/api/companies" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO companies (name, industry, website) VALUES (?, ?, ?)")
        .run(b.name || "Unnamed", b.industry || "", b.website || "");
      const id = Number(r.lastInsertRowid);
      saveCustomValues("company", id, b.custom);
      const company = attachCustom("company", [
        db.query("SELECT * FROM companies WHERE id = ?").get(id) as any,
      ])[0];
      return json({ company }, 201);
    }

    const companyId = path.match(/^\/api\/companies\/(\d+)$/);
    if (companyId && method === "PATCH") {
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["name", "industry", "website"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(b[k]);
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(companyId[1]));
      }
      saveCustomValues("company", Number(companyId[1]), b.custom);
      const updatedCompany = attachCustom("company", [
        db.query("SELECT * FROM companies WHERE id = ?").get(Number(companyId[1])) as any,
      ])[0];
      return json({ company: updatedCompany });
    }

    // ---- tasks
    if (path === "/api/tasks" && method === "GET") {
      const cid = url.searchParams.get("campaign_id");
      let q = `SELECT t.*, d.title AS deal_title FROM tasks t
             LEFT JOIN deals d ON d.id = t.deal_id`;
      const params: unknown[] = [];
      if (cid) {
        q += ` WHERE t.campaign_id = ?`;
        params.push(Number(cid));
      }
      q += ` ORDER BY t.done, t.due_date`;
      const rows = attachCustom("task", db.query(q).all(...params) as any[]);
      return json({ tasks: rows });
    }
    if (path === "/api/tasks" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO tasks (title, deal_id, campaign_id, due_date, owner) VALUES (?, ?, ?, ?, ?)")
        .run(b.title || "Untitled task", b.deal_id || null, b.campaign_id || null, b.due_date || "", b.owner || "");
      const id = Number(r.lastInsertRowid);
      saveCustomValues("task", id, b.custom);
      const task = attachCustom("task", [
        db.query("SELECT * FROM tasks WHERE id = ?").get(id) as any,
      ])[0];
      fireWebhooks("task.created", task as any);
      return json({ task }, 201);
    }
    const taskId = path.match(/^\/api\/tasks\/(\d+)$/);
    if (taskId && method === "PATCH") {
      const b = await readBody(req);
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
      saveCustomValues("task", Number(taskId[1]), b.custom);
      const updatedTask = attachCustom("task", [
        db.query("SELECT * FROM tasks WHERE id = ?").get(Number(taskId[1])) as any,
      ])[0];
      return json({ task: updatedTask });
    }
    if (taskId && method === "DELETE") {
      const t = db.query("SELECT * FROM tasks WHERE id = ?").get(Number(taskId[1])) as any;
      if (t) {
        db.prepare("DELETE FROM custom_values WHERE entity = 'task' AND record_id = ?").run(t.id);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(t.id);
        fireWebhooks("task.deleted", { id: t.id, title: t.title });
      }
      return json({ ok: true });
    }
    const taskToggle = path.match(/^\/api\/tasks\/(\d+)\/toggle$/);
    if (taskToggle && method === "POST") {
      const t = db.query("SELECT * FROM tasks WHERE id = ?").get(Number(taskToggle[1])) as any;
      db.prepare("UPDATE tasks SET done = ? WHERE id = ?").run(t.done ? 0 : 1, t.id);
      const updated = db.query("SELECT * FROM tasks WHERE id = ?").get(t.id);
      if (!t.done) {
        logActivity("task", `Completed: ${t.title}`);
        fireWebhooks("task.completed", updated as any);
      }
      return json({ task: updated });
    }

    // ---- captures: business-card / client-note photos
    if (path === "/api/captures" && method === "GET") {
      const rows = db
        .query(
          `SELECT c.*, ct.name AS contact_name FROM captures c
           LEFT JOIN contacts ct ON ct.id = c.contact_id
           ORDER BY c.id DESC`
        )
        .all();
      return json({ captures: rows });
    }
    if (path === "/api/captures" && method === "POST") {
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
            "INSERT INTO captures (filename, original_name, mime, size) VALUES (?, ?, ?, ?)"
          )
          .run(filename, file.name || "", file.type, file.size);
        saved.push(
          db.query("SELECT * FROM captures WHERE id = ?").get(Number(r.lastInsertRowid))
        );
      }
      if (saved.length) {
        logActivity(
          "note",
          `Captured ${saved.length} photo${saved.length === 1 ? "" : "s"} (business card / notes)`
        );
      }
      return json({ captures: saved, errors }, 201);
    }
    const captureId = path.match(/^\/api\/captures\/(\d+)$/);
    if (captureId && method === "PATCH") {
      const b = await readBody(req);
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
      const row = db
        .query("SELECT * FROM captures WHERE id = ?")
        .get(Number(captureId[1])) as any;
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
      return json({ fields: getCustomFields(schemaEntity[1]) });
    }
    if (schemaEntity && CUSTOM_ENTITIES.includes(schemaEntity[1]) && method === "POST") {
      const b = await readBody(req);
      const entity = schemaEntity[1];
      const label = String(b.label || "").trim();
      const type = FIELD_TYPES.includes(b.type) ? b.type : "text";
      if (!label) return json({ error: "label is required" }, 400);
      let name = slugify(label);
      if (CORE_COLUMNS[entity].includes(name)) return json({ error: `"${name}" is a built-in field` }, 400);
      let n = 2;
      while (db.query("SELECT id FROM custom_fields WHERE entity = ? AND name = ?").get(entity, name)) {
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
          "INSERT INTO custom_fields (entity, name, label, type, options, required, position) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(entity, name, label, type, options, b.required ? 1 : 0, pos);
      logActivity("note", `Added custom field "${label}" to ${entity}s`);
      return json({ field: db.query("SELECT * FROM custom_fields WHERE id = ?").get(Number(r.lastInsertRowid)) }, 201);
    }
    const schemaFieldId = path.match(/^\/api\/schema\/fields\/(\d+)$/);
    if (schemaFieldId && method === "PATCH") {
      const b = await readBody(req);
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
      const f = db.query("SELECT * FROM custom_fields WHERE id = ?").get(Number(schemaFieldId[1])) as any;
      if (f) {
        db.prepare("DELETE FROM custom_values WHERE field_id = ?").run(f.id);
        db.prepare("DELETE FROM custom_fields WHERE id = ?").run(f.id);
        logActivity("note", `Removed custom field "${f.label}" from ${f.entity}s`);
      }
      return json({ ok: true });
    }

    // ---- campaigns
    if (path === "/api/campaigns" && method === "GET") {
      const rows = attachCustom("campaign", db.query("SELECT * FROM campaigns ORDER BY created_at DESC").all() as any[]);
      return json({ campaigns: rows });
    }
    if (path === "/api/campaigns" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO campaigns (name, status, start_date, end_date, budget, notes) VALUES (?, ?, ?, ?, ?, ?)")
        .run(b.name || "Untitled campaign", b.status || "draft", b.start_date || "", b.end_date || "",
          Number(b.budget) || 0, b.notes || "");
      const id = Number(r.lastInsertRowid);
      saveCustomValues("campaign", id, b.custom);
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
        "INSERT INTO tasks (title, campaign_id, due_date, owner) VALUES (?, ?, ?, ?)"
      );
      for (const [title, offset] of WORKFLOW) {
        insTask.run(title, id, dueFor(offset), "");
      }
      logActivity("note", `Autopopulated ${WORKFLOW.length} workflow tasks for campaign "${b.name || "Untitled campaign"}"`);
      const campaign = attachCustom("campaign", [db.query("SELECT * FROM campaigns WHERE id = ?").get(id) as any])[0];
      logActivity("note", `Created campaign "${campaign.name}"`);
      fireWebhooks("campaign.created", campaign);
      return json({ campaign }, 201);
    }
    const campaignId = path.match(/^\/api\/campaigns\/(\d+)$/);
    if (campaignId && method === "PATCH") {
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["name", "status", "start_date", "end_date", "notes"]) {
        if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
      }
      if (b.budget !== undefined) { sets.push("budget = ?"); vals.push(Number(b.budget) || 0); }
      if (sets.length) {
        db.prepare(`UPDATE campaigns SET ${sets.join(", ")} WHERE id = ?`).run(...vals, Number(campaignId[1]));
      }
      saveCustomValues("campaign", Number(campaignId[1]), b.custom);
      const campaign = attachCustom("campaign", [db.query("SELECT * FROM campaigns WHERE id = ?").get(Number(campaignId[1])) as any])[0];
      fireWebhooks("campaign.updated", campaign);
      return json({ campaign });
    }
    if (campaignId && method === "DELETE") {
      const c = db.query("SELECT * FROM campaigns WHERE id = ?").get(Number(campaignId[1])) as any;
      if (c) {
        db.prepare("DELETE FROM custom_values WHERE entity = 'campaign' AND record_id = ?").run(c.id);
        db.prepare("UPDATE tasks SET campaign_id = NULL WHERE campaign_id = ?").run(c.id);
        db.prepare("DELETE FROM campaigns WHERE id = ?").run(c.id);
        fireWebhooks("campaign.deleted", { id: c.id, name: c.name });
      }
      return json({ ok: true });
    }

    // ---- stage colors for the frontend
    if (path === "/api/meta-colors" && method === "GET") {
      const { STAGE_COLORS } = await import("./db");
      return json({ colors: STAGE_COLORS });
    }

    // ---- activities
    if (path === "/api/activities" && method === "GET") {      const rows = db
        .query("SELECT * FROM activities ORDER BY id DESC LIMIT 30")
        .all();
      return json({ activities: rows });
    }

    // ---- outgoing webhooks (automation platforms)
    if (path === "/api/webhooks" && method === "GET") {
      const rows = db.query("SELECT * FROM webhooks ORDER BY id DESC").all();
      return json({ webhooks: rows, events: ALL_EVENTS });
    }
    if (path === "/api/webhooks" && method === "POST") {
      const b = await readBody(req);
      if (!b.url) return json({ error: "url required" }, 400);
      const r = db
        .prepare("INSERT INTO webhooks (name, url, events, active) VALUES (?, ?, ?, ?)")
        .run(b.name || b.url, b.url, JSON.stringify(b.events || []), b.active === false ? 0 : 1);
      return json(
        { webhook: db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(r.lastInsertRowid)) },
        201
      );
    }
    const whId = path.match(/^\/api\/webhooks\/(\d+)$/);
    if (whId && method === "DELETE") {
      db.prepare("DELETE FROM webhooks WHERE id = ?").run(Number(whId[1]));
      db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(Number(whId[1]));
      return json({ ok: true });
    }
    const whTest = path.match(/^\/api\/webhooks\/(\d+)\/test$/);
    if (whTest && method === "POST") {
      const h = db.query("SELECT * FROM webhooks WHERE id = ?").get(Number(whTest[1])) as any;
      if (!h) return json({ error: "not found" }, 404);
      const payload = { event: "test", sent_at: new Date().toISOString(), data: { hello: "from exec-crm" } };
      let status = "ok", code = 0;
      try {
        const res = await fetch(h.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-CRM-Event": "test" },
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
      const rows = db
        .query(
          `SELECT d.*, w.name AS webhook_name FROM webhook_deliveries d
           LEFT JOIN webhooks w ON w.id = d.webhook_id
           ORDER BY d.id DESC LIMIT 50`
        )
        .all();
      return json({ deliveries: rows });
    }

    // ---- incoming hooks (Zapier / Make / n8n -> CRM)
    if (path === "/api/hooks" && method === "GET") {
      return json({ hooks: db.query("SELECT id, name, key, created_at FROM incoming_hooks").all() });
    }
    if (path === "/api/hooks" && method === "POST") {
      const b = await readBody(req);
      const key = b.key || crypto.randomUUID().replace(/-/g, "").slice(0, 24);
      const r = db.prepare("INSERT INTO incoming_hooks (name, key) VALUES (?, ?)").run(b.name || "Untitled hook", key);
      return json(
        { hook: db.query("SELECT id, name, key, created_at FROM incoming_hooks WHERE id = ?").get(Number(r.lastInsertRowid)) },
        201
      );
    }
    const hookDel = path.match(/^\/api\/hooks\/(\d+)$/);
    if (hookDel && method === "DELETE") {
      db.prepare("DELETE FROM incoming_hooks WHERE id = ?").run(Number(hookDel[1]));
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
      let result: any = null;
      if (action === "create_deal") {
        const r = db.prepare(
          `INSERT INTO deals (title, company_id, value, stage, probability, expected_close, owner)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(data.title || "Inbound deal", data.company_id || null, Number(data.value || 0),
          data.stage && STAGES.includes(data.stage) ? data.stage : "prospecting",
          Number(data.probability ?? 10), data.expected_close || "", data.owner || "automation");
        result = dealJson(Number(r.lastInsertRowid));
        logActivity("deal", `${(result as any).title} created via ${hook.name}`);
        fireWebhooks("deal.created", result as any);
      } else if (action === "create_contact") {
        const r = db.prepare(
          "INSERT INTO contacts (company_id, name, title, email, phone) VALUES (?, ?, ?, ?, ?)"
        ).run(data.company_id || null, data.name || "Unnamed", data.title || "", data.email || "", data.phone || "");
        result = db.query("SELECT * FROM contacts WHERE id = ?").get(Number(r.lastInsertRowid));
        fireWebhooks("contact.created", result as any);
      } else if (action === "create_task") {
        const r = db.prepare(
          "INSERT INTO tasks (title, deal_id, due_date, owner) VALUES (?, ?, ?, ?)"
        ).run(data.title || "Inbound task", data.deal_id || null, data.due_date || "", data.owner || "automation");
        result = db.query("SELECT * FROM tasks WHERE id = ?").get(Number(r.lastInsertRowid));
        fireWebhooks("task.created", result as any);
      } else {
        return json({ error: `unknown action: ${action}` }, 400);
      }
      return json({ ok: true, action, result }, 201);
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`exec-crm listening on http://localhost:${server.port}`);
