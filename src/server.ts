import { openDb, seedIfEmpty, STAGES, STAGE_LABELS } from "./db";

const PORT = Number(process.env.PORT || 3001);
const db = openDb(process.env.CRM_DB || "./crm.db");
seedIfEmpty(db);

// ---------------------------------------------------------------- webhooks
const ALL_EVENTS = [
  "deal.created",
  "deal.stage_changed",
  "deal.updated",
  "contact.created",
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

// ---------------------------------------------------------------- server
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

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
      const rows = db
        .query(
          `SELECT ct.*, c.name AS company_name FROM contacts ct
           LEFT JOIN companies c ON c.id = ct.company_id
           WHERE ct.name LIKE ? OR ct.email LIKE ?
           ORDER BY ct.name`
        )
        .all(`%${q}%`, `%${q}%`);
      return json({ contacts: rows });
    }
    if (path === "/api/contacts" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare(
          "INSERT INTO contacts (company_id, name, title, email, phone) VALUES (?, ?, ?, ?, ?)"
        )
        .run(b.company_id || null, b.name || "Unnamed", b.title || "", b.email || "", b.phone || "");
      const contact = db.query("SELECT * FROM contacts WHERE id = ?").get(Number(r.lastInsertRowid));
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
      return json({ contact: db.query("SELECT * FROM contacts WHERE id = ?").get(Number(contactId[1])) });
    }

    // ---- companies
    if (path === "/api/companies" && method === "GET") {
      const rows = db
        .query(
          `SELECT c.*, COUNT(d.id) AS deal_count,
                  COALESCE(SUM(CASE WHEN d.stage NOT IN ('closed_won','closed_lost') THEN d.value ELSE 0 END),0) AS open_value
           FROM companies c LEFT JOIN deals d ON d.company_id = c.id
           GROUP BY c.id ORDER BY open_value DESC`
        )
        .all();
      return json({ companies: rows });
    }
    if (path === "/api/companies" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO companies (name, industry, website) VALUES (?, ?, ?)")
        .run(b.name || "Unnamed", b.industry || "", b.website || "");
      return json(
        { company: db.query("SELECT * FROM companies WHERE id = ?").get(Number(r.lastInsertRowid)) },
        201
      );
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
      return json({ company: db.query("SELECT * FROM companies WHERE id = ?").get(Number(companyId[1])) });
    }

    // ---- tasks
    if (path === "/api/tasks" && method === "GET") {
      const rows = db
        .query(
          `SELECT t.*, d.title AS deal_title FROM tasks t
           LEFT JOIN deals d ON d.id = t.deal_id
           ORDER BY t.done, t.due_date`
        )
        .all();
      return json({ tasks: rows });
    }
    if (path === "/api/tasks" && method === "POST") {
      const b = await readBody(req);
      const r = db
        .prepare("INSERT INTO tasks (title, deal_id, due_date, owner) VALUES (?, ?, ?, ?)")
        .run(b.title || "Untitled task", b.deal_id || null, b.due_date || "", b.owner || "");
      const task = db.query("SELECT * FROM tasks WHERE id = ?").get(Number(r.lastInsertRowid));
      fireWebhooks("task.created", task as any);
      return json({ task }, 201);
    }
    const taskId = path.match(/^\/api\/tasks\/(\d+)$/);
    if (taskId && method === "PATCH") {
      const b = await readBody(req);
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const k of ["title", "deal_id", "due_date", "owner"]) {
        if (b[k] !== undefined) {
          sets.push(`${k} = ?`);
          vals.push(k === "deal_id" && b[k] === "" ? null : b[k]);
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
          .run(...vals, Number(taskId[1]));
      }
      return json({ task: db.query("SELECT * FROM tasks WHERE id = ?").get(Number(taskId[1])) });
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
