/* exec-crm frontend — vanilla SPA */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const TITLES = {
  dashboard: "Dashboard", pipeline: "Pipeline", contacts: "Contacts",
  companies: "Companies", tasks: "Tasks", automations: "Automations",
};
$("#today").textContent = new Date(Date.now()).toLocaleDateString(undefined, {
  weekday: "long", year: "numeric", month: "long", day: "numeric",
});

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
const money = (n) =>
  "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const moneyShort = (n) => {
  n = Number(n) || 0;
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "k";
  return "$" + Math.round(n);
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);
const DEL = (p) => api("DELETE", p);

/* ---------- modal ---------- */
function openModal(title, bodyHtml, onSubmit, submitLabel = "Save") {
  const root = $("#modal-root");
  root.innerHTML = `
    <div class="overlay" id="ovl">
      <div class="modal">
        <h2>${esc(title)}</h2>
        <div>${bodyHtml}</div>
        <div class="actions">
          <button class="btn ghost" id="m-cancel">Cancel</button>
          <button class="btn" id="m-ok">${esc(submitLabel)}</button>
        </div>
      </div>
    </div>`;
  const close = () => (root.innerHTML = "");
  $("#m-cancel").onclick = close;
  $("#ovl").addEventListener("mousedown", (e) => {
    if (e.target.id === "ovl") close();
  });
  $("#m-ok").onclick = async () => {
    const data = {};
    root.querySelectorAll("[name]").forEach((el) => {
      if (el.type === "checkbox") {
        if (el.checked) {
          (data[el.name] = data[el.name] || []).push(el.value);
        }
      } else data[el.name] = el.value;
    });
    await onSubmit(data);
    close();
  };
  return close;
}
const field = (label, inner) =>
  `<div class="field"><label>${esc(label)}</label>${inner}</div>`;
const input = (name, val = "", type = "text", extra = "") =>
  `<input name="${name}" type="${type}" value="${esc(val)}" ${extra}>`;
const select = (name, options, val = "") =>
  `<select name="${name}">${options
    .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`)
    .join("")}</select>`;

/* ---------- views ---------- */
const state = { stages: [], labels: {}, colors: {} };

async function loadMeta() {
  const { stages, labels } = await GET("/api/deals");
  state.stages = stages;
  state.labels = labels;
  const res = await fetch("/api/meta-colors").then((r) => r.ok ? r.json() : null).catch(() => null);
  state.colors = res?.colors || {};
}
const stageColor = (s) =>
  state.colors[s] || { prospecting: "#4c8dff", qualification: "#8b9cf0", proposal: "#8b7cf6", negotiation: "#f5b83d", closed_won: "#22c07a", closed_lost: "#f06a7a" }[s] || "#999";

async function vDashboard() {
  const k = await GET("/api/kpis");
  const acts = (await GET("/api/activities")).activities;
  const deals = (await GET("/api/deals")).deals;
  const maxV = Math.max(1, ...k.by_stage.map((s) => s.v));
  const closing = deals
    .filter((d) => !["closed_won", "closed_lost"].includes(d.stage) && d.expected_close)
    .sort((a, b) => (a.expected_close < b.expected_close ? -1 : 1))
    .slice(0, 6);
  view.innerHTML = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-top"><span class="kpi-dot" style="background:#4c8dff"></span><div class="label">Open pipeline</div></div>
        <div class="value">${money(k.pipeline_value)}</div>
        <div class="sub">${k.open_deals} active deals</div></div>
      <div class="kpi"><div class="kpi-top"><span class="kpi-dot" style="background:#8b7cf6"></span><div class="label">Weighted pipeline</div></div>
        <div class="value">${money(k.weighted_value)}</div>
        <div class="sub">probability-adjusted</div></div>
      <div class="kpi"><div class="kpi-top"><span class="kpi-dot" style="background:#22c07a"></span><div class="label">Won this quarter</div></div>
        <div class="value">${money(k.won_this_quarter)}</div>
        <div class="sub">closed won since Jul 1</div></div>
      <div class="kpi"><div class="kpi-top"><span class="kpi-dot" style="background:#f5b83d"></span><div class="label">Open tasks</div></div>
        <div class="value">${k.tasks_open}</div>
        <div class="sub">need attention</div></div>
    </div>
    <div class="cols2">
      <div>
        <div class="panel"><h2>Pipeline by stage</h2>
          ${state.stages.map((s) => {
            const row = k.by_stage.find((x) => x.stage === s) || { n: 0, v: 0 };
            return `<div class="stagebar">
              <div class="name">${esc(state.labels[s])} (${row.n})</div>
              <div class="track"><div class="fill" style="width:${Math.round((row.v / maxV) * 100)}%;background:${stageColor(s)}"></div></div>
              <div class="amt">${moneyShort(row.v)}</div></div>`;
          }).join("")}
        </div>
        <div class="panel"><h2>Closing soon</h2>
          ${closing.length ? closing.map((d) => `
            <div class="activity"><div class="dot" style="background:${stageColor(d.stage)}"></div>
              <div class="text"><b>${esc(d.title)}</b> · ${esc(d.company_name || "")}<br>
              <span style="color:var(--text-3);font-size:12.5px">${money(d.value)} · ${d.probability}% · closes ${esc(d.expected_close)}</span></div>
            </div>`).join("") : `<div class="empty">Nothing on the near horizon.</div>`}
        </div>
      </div>
      <div class="panel"><h2>Recent activity</h2>
        ${acts.map((a) => `
          <div class="activity">
            <div class="dot" style="background:${a.kind === "deal" ? "#22c07a" : a.kind === "task" ? "#f5b83d" : "#4c8dff"}"></div>
            <div class="text">${esc(a.text)}<div class="time">${esc(a.created_at.slice(0, 16).replace("T", " "))}</div></div>
          </div>`).join("")}
      </div>
    </div>`;
}

async function vPipeline() {
  const { deals } = await GET("/api/deals");
  const open = deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage));
  const closedStages = ["closed_won", "closed_lost"];
  view.innerHTML = `
    <div class="toolbar">
      <button class="btn" id="new-deal">+ New deal</button>
      <div class="spacer"></div>
      <span style="color:var(--text-2)">${open.length} open deals · ${money(open.reduce((a, d) => a + d.value, 0))} pipeline</span>
    </div>
    <div class="board" id="board">
      ${[...state.stages.filter((s) => !closedStages.includes(s)), ...closedStages].map((s) => {
        const ds = deals.filter((d) => d.stage === s);
        const tot = ds.reduce((a, d) => a + d.value, 0);
        return `<div class="column" data-stage="${s}">
          <div class="chead"><div class="dot" style="background:${stageColor(s)}"></div>
            <div class="cname">${esc(state.labels[s])}</div>
            <div class="ctotal">${ds.length} · ${moneyShort(tot)}</div></div>
          ${ds.map((d) => `
            <div class="deal-card" data-id="${d.id}">
              <div class="trow"><span class="sdot" style="background:${stageColor(s)}"></span><div class="t">${esc(d.title)}</div></div>
              <div class="co">${esc(d.company_name || "—")}${d.contact_name ? " · " + esc(d.contact_name) : ""}</div>
              <div class="row"><div class="val">${money(d.value)}</div><div class="prob">${d.probability}%</div></div>
            </div>`).join("")}
        </div>`;
      }).join("")}
    </div>`;

  $("#new-deal").onclick = () => newDealModal();
  initDealDrag(deals);
}

/* Fluid pointer-based drag & drop for the pipeline board.
   Click (no drag) opens the edit window; drag lifts the card,
   shows a live placeholder, and FLIP-animates the settle. */
function initDealDrag(deals) {
  const board = $("#board");
  if (!board) return;
  let drag = null;

  const cleanup = (d) => {
    d.card.classList.remove("dragging");
    d.card.style.cssText = "";
    if (d.ph) d.ph.remove();
    board.querySelectorAll(".column").forEach((c) => c.classList.remove("dragover"));
  };

  const settle = (card, cancelled) => {
    const d = drag;
    if (!d || d.card !== card) return;
    drag = null;
    if (!d.active) { // plain click -> edit window
      const deal = deals.find((x) => x.id === Number(d.id));
      if (deal) editDealModal(deal);
      return;
    }
    const targetCol = !cancelled && d.ph.isConnected ? d.ph.closest(".column") : null;
    const dest = targetCol ? d.ph.getBoundingClientRect() : d.rect;
    const cur = card.getBoundingClientRect();
    card.style.transition = "transform 0.19s cubic-bezier(0.22, 1, 0.36, 1)";
    card.style.transform = `translate(${d.x + (dest.left - cur.left)}px, ${d.y + (dest.top - cur.top)}px)`;
    setTimeout(async () => {
      const newStage = targetCol ? targetCol.dataset.stage : d.oldStage;
      cleanup(d);
      if (targetCol && newStage !== d.oldStage) {
        await PATCH(`/api/deals/${d.id}`, { stage: newStage });
      }
      route();
    }, 200);
  };

  board.querySelectorAll(".deal-card").forEach((card) => {
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      drag = {
        card, id: card.dataset.id, sx: e.clientX, sy: e.clientY,
        x: 0, y: 0, active: false, ph: null,
        rect: card.getBoundingClientRect(),
        oldStage: card.closest(".column").dataset.stage,
      };
      try { card.setPointerCapture(e.pointerId); } catch {}
    });

    card.addEventListener("pointermove", (e) => {
      const d = drag;
      if (!d || d.card !== card) return;
      if (!d.active) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 7) return;
        // lift the card
        const r = d.rect;
        const ph = document.createElement("div");
        ph.className = "deal-placeholder";
        ph.style.height = r.height + "px";
        card.after(ph);
        Object.assign(card.style, {
          position: "fixed", left: r.left + "px", top: r.top + "px",
          width: r.width + "px", margin: "0", zIndex: 1000,
          pointerEvents: "none",
        });
        d.ph = ph;
        d.active = true;
        card.classList.add("dragging");
      }
      d.x = e.clientX - d.sx;
      d.y = e.clientY - d.sy;
      card.style.transform = `translate(${d.x}px, ${d.y}px) rotate(2deg) scale(1.03)`;
      // which column is under the cursor?
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under ? under.closest(".column") : null;
      board.querySelectorAll(".column").forEach((c) =>
        c.classList.toggle("dragover", c === col));
      if (col && d.ph) {
        const siblings = [...col.querySelectorAll(".deal-card:not(.dragging)")];
        const after = siblings.find((c) => {
          const cr = c.getBoundingClientRect();
          return e.clientY < cr.top + cr.height / 2;
        });
        if (after) col.insertBefore(d.ph, after);
        else col.appendChild(d.ph);
      }
    });

    card.addEventListener("pointerup", () => settle(card, false));
    card.addEventListener("pointercancel", () => settle(card, true));
  });
}

async function editDealModal(d) {
  const { companies } = await GET("/api/companies");
  const { contacts } = await GET("/api/contacts");
  const close = openModal("Edit deal", `
    <div class="formgrid">
      ${field("Title", input("title", d.title))}
      ${field("Value ($)", input("value", d.value, "number"))}
      ${field("Company", select("company_id", [["", "—"]].concat(companies.map((c) => [c.id, c.name])), d.company_id || ""))}
      ${field("Contact", select("contact_id", [["", "—"]].concat(contacts.map((c) => [c.id, c.name])), d.contact_id || ""))}
      ${field("Stage", select("stage", state.stages.map((s) => [s, state.labels[s]]), d.stage))}
      ${field("Probability %", input("probability", d.probability, "number"))}
      ${field("Expected close", input("expected_close", d.expected_close || "", "date"))}
      ${field("Owner", input("owner", d.owner || ""))}
    </div>`,
    async (data) => {
      if (data.company_id === "") data.company_id = null;
      if (data.contact_id === "") data.contact_id = null;
      await PATCH(`/api/deals/${d.id}`, data);
      route();
    }, "Save changes");
  const actions = document.querySelector("#modal-root .modal .actions");
  if (actions) {
    const del = document.createElement("button");
    del.className = "btn danger";
    del.textContent = "Delete";
    del.style.marginRight = "auto";
    del.onclick = async () => {
      if (confirm(`Delete "${d.title}"? This can't be undone.`)) {
        await DEL(`/api/deals/${d.id}`);
        close();
        route();
      }
    };
    actions.prepend(del);
  }
}

async function newDealModal() {
  const { companies } = await GET("/api/companies");
  const { contacts } = await GET("/api/contacts");
  openModal("New deal", `
    <div class="formgrid">
      ${field("Title", input("title", "", "text", "required"))}
      ${field("Value ($)", input("value", "50000", "number"))}
      ${field("Company", select("company_id", companies.map((c) => [c.id, c.name])))}
      ${field("Contact", select("contact_id", contacts.map((c) => [c.id, c.name])))}
      ${field("Stage", select("stage", state.stages.map((s) => [s, state.labels[s]])))}
      ${field("Probability %", input("probability", "20", "number"))}
      ${field("Expected close", input("expected_close", "", "date"))}
      ${field("Owner", input("owner", "You"))}
    </div>`,
    async (d) => { await POST("/api/deals", d); route(); }, "Create deal");
}

async function vContacts() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
  const { contacts } = await GET(`/api/contacts?q=${encodeURIComponent(q)}`);
  view.innerHTML = `
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search name or email…" value="${esc(q)}">
      <button class="btn ghost" id="go">Search</button>
      <div class="spacer"></div>
      <button class="btn" id="new-contact">+ New contact</button>
    </div>
    <div class="panel"><table>
      <tr><th>Name</th><th>Title</th><th>Company</th><th>Email</th><th>Phone</th></tr>
      ${contacts.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.title)}</td>
        <td>${esc(c.company_name || "—")}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td></tr>`).join("")}
    </table>${contacts.length ? "" : `<div class="empty">No contacts match.</div>`}</div>`;
  const go = () => location.hash = `#/contacts?q=${encodeURIComponent($("#q").value)}`;
  $("#go").onclick = go;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  document.querySelectorAll("#view tr.clickable").forEach((tr) => {
    tr.onclick = () => {
      const c = contacts.find((x) => x.id === Number(tr.dataset.id));
      if (c) editContactModal(c);
    };
  });
  $("#new-contact").onclick = async () => {
    const { companies } = await GET("/api/companies");
    openModal("New contact", `
      <div class="formgrid">
        ${field("Name", input("name"))}
        ${field("Title", input("title"))}
        ${field("Company", select("company_id", companies.map((c) => [c.id, c.name])))}
        ${field("Email", input("email", "", "email"))}
        ${field("Phone", input("phone"))}
        ${field("—", `<div></div>`)}
      </div>`,
      async (d) => { await POST("/api/contacts", d); route(); }, "Create contact");
  };
}

async function editContactModal(c) {
  const { companies } = await GET("/api/companies");
  openModal("Edit contact", `
    <div class="formgrid">
      ${field("Name", input("name", c.name))}
      ${field("Title", input("title", c.title))}
      ${field("Company", select("company_id", [["", "—"]].concat(companies.map((x) => [x.id, x.name])), c.company_id || ""))}
      ${field("Email", input("email", c.email, "email"))}
      ${field("Phone", input("phone", c.phone))}
      ${field("—", `<div></div>`)}
    </div>`,
    async (d) => { await PATCH(`/api/contacts/${c.id}`, d); route(); }, "Save changes");
}

async function vCompanies() {
  const { companies } = await GET("/api/companies");
  view.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      <button class="btn" id="new-company">+ New company</button></div>
    <div class="panel"><table>
      <tr><th>Company</th><th>Industry</th><th>Website</th><th>Deals</th><th>Open pipeline</th></tr>
      ${companies.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td><td>${esc(c.industry)}</td>
        <td>${esc(c.website)}</td><td>${c.deal_count}</td><td><b>${money(c.open_value)}</b></td></tr>`).join("")}
    </table></div>`;
  document.querySelectorAll("#view tr.clickable").forEach((tr) => {
    tr.onclick = () => {
      const c = companies.find((x) => x.id === Number(tr.dataset.id));
      if (c) editCompanyModal(c);
    };
  });
  $("#new-company").onclick = () =>
    openModal("New company", `
      ${field("Name", input("name"))}
      <div class="formgrid">${field("Industry", input("industry"))}${field("Website", input("website"))}</div>`,
      async (d) => { await POST("/api/companies", d); route(); }, "Create company");
}

function editCompanyModal(c) {
  openModal("Edit company", `
    ${field("Name", input("name", c.name))}
    <div class="formgrid">${field("Industry", input("industry", c.industry))}${field("Website", input("website", c.website))}</div>`,
    async (d) => { await PATCH(`/api/companies/${c.id}`, d); route(); }, "Save changes");
}

async function vTasks() {
  const { tasks } = await GET("/api/tasks");
  const { deals } = await GET("/api/deals");
  const open = tasks.filter((t) => !t.done);
  view.innerHTML = `
    <div class="toolbar">
      <span style="color:var(--text-2)">${open.length} open</span>
      <div class="spacer"></div>
      <button class="btn" id="new-task">+ New task</button>
    </div>
    <div class="panel">
      ${tasks.map((t) => `
        <div class="task ${t.done ? "done" : ""}">
          <input type="checkbox" data-id="${t.id}" ${t.done ? "checked" : ""}>
          <div><div class="tt">${esc(t.title)}</div>
            <div class="meta">${t.deal_title ? esc(t.deal_title) + " · " : ""}${t.due_date ? "due " + esc(t.due_date) + " · " : ""}${esc(t.owner)}</div></div>
          <div class="spacer"></div>
          <button class="btn ghost small" data-edit="${t.id}">Edit</button>
        </div>`).join("") || `<div class="empty">All clear.</div>`}
    </div>`;
  document.querySelectorAll('.task input[type="checkbox"]').forEach((cb) => {
    cb.onchange = async () => { await POST(`/api/tasks/${cb.dataset.id}/toggle`); route(); };
  });
  document.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const t = tasks.find((x) => x.id === Number(b.dataset.edit));
      if (t) editTaskModal(t, deals);
    };
  });
  $("#new-task").onclick = () =>
    openModal("New task", `
      ${field("Title", input("title"))}
      <div class="formgrid">
        ${field("Related deal", select("deal_id", [["", "—"]].concat(deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage)).map((d) => [d.id, d.title]))))}
        ${field("Due date", input("due_date", "", "date"))}
      </div>
      ${field("Owner", input("owner", "You"))}`,
      async (d) => { if (!d.deal_id) delete d.deal_id; await POST("/api/tasks", d); route(); }, "Create task");
}

function editTaskModal(t, deals) {
  openModal("Edit task", `
    ${field("Title", input("title", t.title))}
    <div class="formgrid">
      ${field("Related deal", select("deal_id", [["", "—"]].concat(deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage)).map((d) => [d.id, d.title])), t.deal_id || ""))}
      ${field("Due date", input("due_date", t.due_date || "", "date"))}
    </div>
    ${field("Owner", input("owner", t.owner))}`,
    async (d) => { await PATCH(`/api/tasks/${t.id}`, d); route(); }, "Save changes");
}

async function vAutomations() {
  const { webhooks, events } = await GET("/api/webhooks");
  const { deliveries } = await GET("/api/deliveries");
  const { hooks } = await GET("/api/hooks");
  const base = location.origin;
  view.innerHTML = `
    <div class="panel">
      <h2>Outgoing webhooks <span style="color:var(--text-3);font-weight:400;font-size:13px">— CRM → Zapier / Make / n8n</span></h2>
      <p style="color:var(--text-2);margin-top:-6px">POSTs JSON on deal, contact, and task events. Point it at a Zapier Catch Hook, Make webhook, or n8n Webhook node.</p>
      <div id="wh-list">
        ${webhooks.map((w) => {
          let ev = [];
          try { ev = JSON.parse(w.events); } catch {}
          return `<div class="hook">
            <div class="info"><div class="name">${esc(w.name)} ${w.active ? "" : '<span class="tag">paused</span>'}</div>
              <div class="url">${esc(w.url)}</div>
              <div class="events">${(ev.length ? ev : ["all"]).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}</div></div>
            <button class="btn ghost small" data-test="${w.id}">Test</button>
            <button class="btn danger small" data-del="${w.id}">Delete</button>
          </div>`;
        }).join("") || `<div class="empty">No outgoing webhooks yet.</div>`}
      </div>
      <button class="btn" id="add-wh">+ Add webhook</button>
      <h3>Recent deliveries</h3>
      <table><tr><th>Time</th><th>Webhook</th><th>Event</th><th>Status</th><th>Code</th></tr>
        ${deliveries.map((d) => `<tr><td>${esc(d.created_at.slice(0, 19).replace("T", " "))}</td>
          <td>${esc(d.webhook_name || d.webhook_id)}</td><td><span class="tag">${esc(d.event)}</span></td>
          <td class="status-${d.status}">${esc(d.status)}</td><td>${d.response_code || "—"}</td></tr>`).join("")}
      </table>
    </div>
    <div class="panel">
      <h2>Incoming hooks <span style="color:var(--text-3);font-weight:400;font-size:13px">— Zapier / Make / n8n → CRM</span></h2>
      <p style="color:var(--text-2);margin-top:-6px">POST JSON to the hook URL from any automation platform. Body: <span class="tag">{"action": "create_deal" | "create_contact" | "create_task", "data": {...}}</span></p>
      ${hooks.map((h) => `
        <div class="hook"><div class="info"><div class="name">${esc(h.name)}</div>
          <div class="url">${esc(base)}/api/hooks/in/${esc(h.key)}</div></div>
          <button class="btn ghost small" data-copy="${esc(base)}/api/hooks/in/${esc(h.key)}">Copy URL</button>
          <button class="btn danger small" data-hdel="${h.id}">Delete</button></div>`).join("") || `<div class="empty">No incoming hooks yet.</div>`}
      <button class="btn" id="add-hook">+ New incoming hook</button>
      <h3>Example — n8n / Make / Zapier HTTP step</h3>
      <div class="code">POST ${esc(base)}/api/hooks/in/YOUR_KEY
Content-Type: application/json

{
  "action": "create_deal",
  "data": {
    "title": "Acme renewal",
    "value": 120000,
    "stage": "proposal",
    "probability": 60,
    "expected_close": "2026-11-30"
  }
}</div>
    </div>
    <div class="panel">
      <h2>Import contacts <span style="color:var(--text-3);font-weight:400;font-size:13px">— CSV upload</span></h2>
      <p style="color:var(--text-2);margin-top:-6px">Columns: <span class="tag">name</span> <span class="tag">title</span> <span class="tag">company</span> <span class="tag">email</span> <span class="tag">phone</span> — only <span class="tag">name</span> is required. New companies are created automatically; rows with a duplicate email are skipped. Bulk imports don't fire outgoing webhooks.</p>
      <div class="toolbar">
        <label class="btn ghost" for="csv-file" id="csv-label" style="cursor:pointer">Choose CSV…</label>
        <input type="file" id="csv-file" accept=".csv,text/csv" hidden>
        <button class="btn" id="do-import">Import contacts</button>
        <a class="btn ghost" href="/api/contacts/import/template" download="contacts-template.csv" style="text-decoration:none">Download template</a>
      </div>
      <div id="import-result"></div>
    </div>`;

  $("#add-wh").onclick = () =>
    openModal("Add outgoing webhook", `
      ${field("Name", input("name", "Zapier catch hook"))}
      ${field("URL", input("url", "https://", "url"))}
      <div class="field"><label>Events (none checked = all)</label>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${events.map((e) => `<label style="font-weight:400"><input type="checkbox" name="events" value="${e}" style="width:auto"> ${e}</label>`).join("")}
        </div></div>`,
      async (d) => { await POST("/api/webhooks", d); route(); }, "Add webhook");

  document.querySelectorAll("[data-test]").forEach((b) =>
    (b.onclick = async () => { const r = await POST(`/api/webhooks/${b.dataset.test}/test`); alert(`Test ${r.status} (HTTP ${r.response_code || "—"})`); route(); }));
  document.querySelectorAll("[data-del]").forEach((b) =>
    (b.onclick = async () => { if (confirm("Delete this webhook?")) { await DEL(`/api/webhooks/${b.dataset.del}`); route(); } }));
  document.querySelectorAll("[data-copy]").forEach((b) =>
    (b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; }));
  document.querySelectorAll("[data-hdel]").forEach((b) =>
    (b.onclick = async () => { if (confirm("Delete this hook?")) { await DEL(`/api/hooks/${b.dataset.hdel}`); route(); } }));
  $("#add-hook").onclick = () =>
    openModal("New incoming hook", field("Name", input("name", "n8n deal intake")),
      async (d) => { const r = await POST("/api/hooks", d); alert("Hook URL:\n" + location.origin + "/api/hooks/in/" + r.hook.key); route(); }, "Create hook");

  const csvFile = $("#csv-file");
  csvFile.onchange = () => {
    $("#csv-label").textContent = csvFile.files[0] ? csvFile.files[0].name : "Choose CSV…";
  };
  $("#do-import").onclick = async () => {
    const f = csvFile.files[0];
    if (!f) { alert("Choose a CSV file first."); return; }
    const btn = $("#do-import");
    btn.disabled = true;
    btn.textContent = "Importing…";
    try {
      const r = await POST("/api/contacts/import", { csv: await f.text() });
      $("#import-result").innerHTML = `<div class="hook"><div class="info">
        <div class="name status-ok">Imported ${r.imported} contact${r.imported === 1 ? "" : "s"}</div>
        <div class="url">${r.skipped} skipped (blank name or duplicate email)${r.errors.length ? ` · ${r.errors.length} error(s)` : ""}</div>
        ${r.errors.length ? `<div class="events">${r.errors.map((e) => `<span class="tag">${esc(e)}</span>`).join("")}</div>` : ""}
      </div></div>`;
    } catch (e) {
      $("#import-result").innerHTML = `<div class="empty">Import failed: ${esc(e.message)}</div>`;
    }
    btn.disabled = false;
    btn.textContent = "Import contacts";
  };
}

/* ---------- command palette (⌘K quick find) ---------- */
function initPalette() {
  const root = $("#palette-root");
  let items = [];
  let sel = 0;
  let cache = null;

  async function buildItems() {
    if (cache) return cache;
    const NAV = [
      ["Dashboard", "#/dashboard"], ["Pipeline", "#/pipeline"], ["Contacts", "#/contacts"],
      ["Companies", "#/companies"], ["Tasks", "#/tasks"], ["Automations", "#/automations"],
    ];
    const out = NAV.map(([label, hash]) => ({
      group: "Go to", kind: "view", label,
      run: () => { location.hash = hash; },
    }));
    try {
      const [{ deals }, { contacts }, { companies }] = await Promise.all([
        GET("/api/deals"), GET("/api/contacts"), GET("/api/companies"),
      ]);
      deals.forEach((d) => out.push({
        group: "Deals", kind: "deal",
        label: d.title, sub: `${money(d.value)} · ${state.labels[d.stage] || d.stage}`,
        run: () => { location.hash = "#/pipeline"; },
      }));
      contacts.forEach((c) => out.push({
        group: "Contacts", kind: "person",
        label: c.name, sub: c.company_name || c.title || "",
        run: () => { location.hash = `#/contacts?q=${encodeURIComponent(c.name)}`; },
      }));
      companies.forEach((c) => out.push({
        group: "Companies", kind: "org",
        label: c.name, sub: c.industry || "",
        run: () => { location.hash = "#/companies"; },
      }));
    } catch {}
    cache = out;
    return out;
  }

  function render(filter) {
    const q = filter.trim().toLowerCase();
    const matched = items.filter((i) =>
      !q || i.label.toLowerCase().includes(q) || (i.sub || "").toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, matched.length - 1));
    let html = "";
    let lastGroup = null;
    matched.slice(0, 60).forEach((it, idx) => {
      if (it.group !== lastGroup) { html += `<div class="p-group">${esc(it.group)}</div>`; lastGroup = it.group; }
      html += `<div class="p-item ${idx === sel ? "sel" : ""}" data-idx="${idx}">
        <span class="p-kind">${esc(it.kind)}</span><span>${esc(it.label)}</span>
        ${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ""}</div>`;
    });
    root.querySelector(".p-list").innerHTML =
      html || `<div class="p-empty">No matches.</div>`;
    root.querySelectorAll(".p-item").forEach((el) => {
      el.onclick = () => { const it = matched[Number(el.dataset.idx)]; close(); it.run(); };
      el.onmousemove = () => {
        if (Number(el.dataset.idx) !== sel) { sel = Number(el.dataset.idx); render(filter); }
      };
    });
    return matched;
  }

  function close() { root.innerHTML = ""; document.removeEventListener("keydown", onKey, true); }
  let current = [];
  function onKey(e) {
    const input = root.querySelector("input");
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, current.length - 1); render(input.value); }
    else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(input.value); }
    else if (e.key === "Enter") { e.preventDefault(); const it = current[sel]; if (it) { close(); it.run(); } }
  }

  async function open() {
    if (root.innerHTML) { close(); return; }
    sel = 0;
    root.innerHTML = `<div class="p-overlay" id="p-ovl">
      <div class="palette">
        <input id="p-input" placeholder="Search deals, contacts, companies…" autocomplete="off">
        <div class="p-list"><div class="p-empty">Loading…</div></div>
      </div></div>`;
    $("#p-ovl").addEventListener("mousedown", (e) => { if (e.target.id === "p-ovl") close(); });
    document.addEventListener("keydown", onKey, true);
    const input = $("#p-input");
    input.addEventListener("input", () => { current = render(input.value); });
    input.focus();
    items = await buildItems();
    current = render("");
  }

  $("#cmdk-btn").onclick = open;
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
  });
}

/* ---------- router ---------- */
async function route() {
  const [hash] = location.hash.split("?");
  const r = (hash.replace("#/", "") || "dashboard").split("/")[0];
  const name = TITLES[r] ? r : "dashboard";
  document.querySelectorAll("#nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.r === name));
  $("#page-title").textContent = TITLES[name];
  view.innerHTML = `<div class="empty">Loading…</div>`;
  try {
    await { dashboard: vDashboard, pipeline: vPipeline, contacts: vContacts,
      companies: vCompanies, tasks: vTasks, automations: vAutomations }[name]();
  } catch (e) {
    view.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

(async () => {
  await loadMeta();
  initPalette();
  window.addEventListener("hashchange", route);
  if (!location.hash) location.hash = "#/dashboard";
  route();
})();
