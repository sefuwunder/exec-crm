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
  state.colors[s] || { prospecting: "#579bfc", qualification: "#a9bee8", proposal: "#784bd1", negotiation: "#ffcb00", closed_won: "#00ca72", closed_lost: "#d974b9" }[s] || "#999";

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
      <div class="kpi" style="border-color:#579bfc"><div class="label">Open pipeline</div>
        <div class="value">${money(k.pipeline_value)}</div>
        <div class="sub">${k.open_deals} active deals</div></div>
      <div class="kpi" style="border-color:#784bd1"><div class="label">Weighted pipeline</div>
        <div class="value">${money(k.weighted_value)}</div>
        <div class="sub">probability-adjusted</div></div>
      <div class="kpi" style="border-color:#00ca72"><div class="label">Won this quarter</div>
        <div class="value">${money(k.won_this_quarter)}</div>
        <div class="sub">closed won since Jul 1</div></div>
      <div class="kpi" style="border-color:#ffcb00"><div class="label">Open tasks</div>
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
              <span style="color:var(--ink-faint);font-size:12.5px">${money(d.value)} · ${d.probability}% · closes ${esc(d.expected_close)}</span></div>
            </div>`).join("") : `<div class="empty">Nothing on the near horizon.</div>`}
        </div>
      </div>
      <div class="panel"><h2>Recent activity</h2>
        ${acts.map((a) => `
          <div class="activity">
            <div class="dot" style="background:${a.kind === "deal" ? "#00ca72" : a.kind === "task" ? "#ffcb00" : "#579bfc"}"></div>
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
      <span style="color:var(--ink-soft)">${open.length} open deals · ${money(open.reduce((a, d) => a + d.value, 0))} pipeline</span>
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
            <div class="deal-card" draggable="true" data-id="${d.id}" style="border-color:${stageColor(s)}">
              <div class="t">${esc(d.title)}</div>
              <div class="co">${esc(d.company_name || "—")}${d.contact_name ? " · " + esc(d.contact_name) : ""}</div>
              <div class="row"><div class="val">${money(d.value)}</div><div class="prob">${d.probability}%</div></div>
            </div>`).join("")}
        </div>`;
      }).join("")}
    </div>`;

  $("#new-deal").onclick = () => newDealModal();
  document.querySelectorAll(".deal-card").forEach((card) => {
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", card.dataset.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  document.querySelectorAll(".column").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      col.classList.add("dragover");
    });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      const id = e.dataTransfer.getData("text/plain");
      await PATCH(`/api/deals/${id}`, { stage: col.dataset.stage });
      route();
    });
  });
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
      ${contacts.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.title)}</td>
        <td>${esc(c.company_name || "—")}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td></tr>`).join("")}
    </table>${contacts.length ? "" : `<div class="empty">No contacts match.</div>`}</div>`;
  const go = () => location.hash = `#/contacts?q=${encodeURIComponent($("#q").value)}`;
  $("#go").onclick = go;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
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

async function vCompanies() {
  const { companies } = await GET("/api/companies");
  view.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      <button class="btn" id="new-company">+ New company</button></div>
    <div class="panel"><table>
      <tr><th>Company</th><th>Industry</th><th>Website</th><th>Deals</th><th>Open pipeline</th></tr>
      ${companies.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.industry)}</td>
        <td>${esc(c.website)}</td><td>${c.deal_count}</td><td><b>${money(c.open_value)}</b></td></tr>`).join("")}
    </table></div>`;
  $("#new-company").onclick = () =>
    openModal("New company", `
      ${field("Name", input("name"))}
      <div class="formgrid">${field("Industry", input("industry"))}${field("Website", input("website"))}</div>`,
      async (d) => { await POST("/api/companies", d); route(); }, "Create company");
}

async function vTasks() {
  const { tasks } = await GET("/api/tasks");
  const { deals } = await GET("/api/deals");
  const open = tasks.filter((t) => !t.done);
  view.innerHTML = `
    <div class="toolbar">
      <span style="color:var(--ink-soft)">${open.length} open</span>
      <div class="spacer"></div>
      <button class="btn" id="new-task">+ New task</button>
    </div>
    <div class="panel">
      ${tasks.map((t) => `
        <div class="task ${t.done ? "done" : ""}">
          <input type="checkbox" data-id="${t.id}" ${t.done ? "checked" : ""}>
          <div><div class="tt">${esc(t.title)}</div>
            <div class="meta">${t.deal_title ? esc(t.deal_title) + " · " : ""}${t.due_date ? "due " + esc(t.due_date) + " · " : ""}${esc(t.owner)}</div></div>
        </div>`).join("") || `<div class="empty">All clear.</div>`}
    </div>`;
  document.querySelectorAll('.task input[type="checkbox"]').forEach((cb) => {
    cb.onchange = async () => { await POST(`/api/tasks/${cb.dataset.id}/toggle`); route(); };
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

async function vAutomations() {
  const { webhooks, events } = await GET("/api/webhooks");
  const { deliveries } = await GET("/api/deliveries");
  const { hooks } = await GET("/api/hooks");
  const base = location.origin;
  view.innerHTML = `
    <div class="panel">
      <h2>⚡ Outgoing webhooks <span style="color:var(--ink-faint);font-weight:400;font-size:13px">— CRM → Zapier / Make / n8n</span></h2>
      <p style="color:var(--ink-soft);margin-top:-6px">POSTs JSON on deal, contact, and task events. Point it at a Zapier Catch Hook, Make webhook, or n8n Webhook node.</p>
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
      <h2>📥 Incoming hooks <span style="color:var(--ink-faint);font-weight:400;font-size:13px">— Zapier / Make / n8n → CRM</span></h2>
      <p style="color:var(--ink-soft);margin-top:-6px">POST JSON to the hook URL from any automation platform. Body: <span class="tag">{"action": "create_deal" | "create_contact" | "create_task", "data": {...}}</span></p>
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
  window.addEventListener("hashchange", route);
  if (!location.hash) location.hash = "#/dashboard";
  route();
})();
