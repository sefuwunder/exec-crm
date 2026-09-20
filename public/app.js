/* exec-crm frontend — vanilla SPA */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");

/* ---------- workspaces ---------- */
const WS_KEY = "exec-crm-workspace";
let workspaces = [];
let wsId = null;
let paletteBust = () => {}; // reassigned by initPalette to clear the Cmd+K index
let showAllHooks = false; // incoming-hooks manager filter ("show all workspaces" toggle)
// append the active workspace to every API call, except the global ones
const wsParam = (p) => {
  if (wsId == null) return p;
  // /api/hooks/in/:key is called by external platforms — the hook itself
  // determines the workspace, never the query string.
  if (p.startsWith("/api/workspaces") || p.startsWith("/api/hooks/in/")) return p;
  if (p === "/api/meta-colors" || p === "/api/contacts/import/template") return p;
  return p + (p.includes("?") ? "&" : "?") + "workspace=" + encodeURIComponent(wsId);
};
const TITLES = {
  dashboard: "Dashboard", feed: "Daily Feed", calendar: "Calendar",
  companies: "Companies", campaigns: "Campaigns", captures: "Captures",
  automations: "Automations", schema: "Schema",
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
  const res = await fetch(wsParam(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `${method} ${path} -> ${res.status}`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
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
    // custom schema fields (data-cf="<field id>")
    root.querySelectorAll("[data-cf]").forEach((el) => {
      (data.custom = data.custom || {})[el.dataset.cf] =
        el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value;
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

/* ---------- webhook custom headers editor ----------
   Standalone helpers (depend only on esc); covered by tests/webhook-headers.test.ts.
   Header inputs carry no `name` attribute so openModal's generic collector
   ignores them — collectHeaders() gathers them explicitly on submit. */
function headerRowHtml(name, existing) {
  return `<div class="hdr-row" style="display:flex;gap:8px;margin-bottom:6px">` +
    `<input class="hdr-name" placeholder="Header-Name" value="${esc(name || "")}" style="flex:1;min-width:0" autocomplete="off" spellcheck="false">` +
    `<input class="hdr-value" placeholder="${existing ? "•••••• (unchanged — type to replace)" : "value"}" value="" style="flex:1;min-width:0" autocomplete="off" spellcheck="false">` +
    `<button type="button" class="btn ghost small" data-hdr-del title="Remove header">×</button></div>`;
}
function headersEditorHtml(names) {
  const rows = (names || []).map((n) => headerRowHtml(n, true)).join("");
  return `<div class="field"><label>Custom headers</label>` +
    `<div id="hdr-rows">${rows}${headerRowHtml("", false)}</div>` +
    `<button type="button" class="btn ghost small" id="hdr-add">+ Add header</button>` +
    `<div style="color:var(--text-3);font-size:12px;margin-top:6px">Sent with every delivery, e.g. <span class="tag">X-Milton-Secret</span>. ` +
    `Values are secrets — stored server-side and never shown again. Remove a row to delete that header.</div></div>`;
}
function bindHeadersEditor(root) {
  const add = root.querySelector("#hdr-add");
  if (add) add.onclick = () =>
    root.querySelector("#hdr-rows").insertAdjacentHTML("beforeend", headerRowHtml("", false));
  const rows = root.querySelector("#hdr-rows");
  if (rows) rows.addEventListener("click", (e) => {
    const btn = e.target && e.target.closest ? e.target.closest("[data-hdr-del]") : null;
    const row = btn && btn.closest ? btn.closest(".hdr-row") : null;
    if (row) row.remove();
  });
}
function collectHeaders(root) {
  const out = {};
  root.querySelectorAll(".hdr-row").forEach((row) => {
    const n = row.querySelector(".hdr-name").value.trim();
    if (n) out[n] = row.querySelector(".hdr-value").value;
  });
  return out;
}
const select = (name, options, val = "") =>
  `<select name="${name}">${options
    .map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`)
    .join("")}</select>`;

/* ---------- custom schema fields ---------- */
const FIELD_TYPES = [
  ["text", "Text"], ["textarea", "Long text"], ["number", "Number"],
  ["date", "Date"], ["select", "Dropdown"], ["checkbox", "Checkbox"], ["url", "URL"],
];
const cfInput = (f, val = "") => {
  const attr = `data-cf="${f.id}"`;
  const v = val ?? "";
  if (f.type === "textarea") return `<textarea ${attr} rows="2">${esc(v)}</textarea>`;
  if (f.type === "select") {
    let opts = [];
    try { opts = JSON.parse(f.options || "[]"); } catch {}
    return `<select ${attr}>${opts
      .map((o) => `<option value="${esc(o)}" ${o === v ? "selected" : ""}>${esc(o)}</option>`)
      .join("")}</select>`;
  }
  if (f.type === "checkbox")
    return `<input type="checkbox" ${attr} ${v === "1" ? "checked" : ""} style="width:18px;height:18px;margin-top:4px">`;
  const t = f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "url" ? "url" : "text";
  return `<input type="${t}" ${attr} value="${esc(v)}"${f.required ? " required" : ""}>`;
};
const cfFieldsHtml = (fields, values = {}) => {
  if (!fields.length) return "";
  return `<div class="cf-section"><div class="cf-title">Custom fields</div><div class="formgrid">` +
    fields.map((f) => field(f.label + (f.required ? " *" : ""), cfInput(f, values[f.id]))).join("") +
    `</div></div>`;
};
const getSchemaFields = async (entity) => (await GET(`/api/schema/${entity}`)).fields;
const statusPill = (s) => {
  const colors = { draft: "#9aa1b3", active: "#18a058", paused: "#e6a23c", completed: "#2f62f0" };
  return `<span class="pill" style="background:${colors[s] || "#9aa1b3"}22;color:${colors[s] || "#9aa1b3"}">${esc(s)}</span>`;
};

/* ---------- workspace switcher ---------- */
const WS_COLORS = ["#579bfc", "#00ca72", "#ffcb00", "#d974b9", "#784bd1", "#ff8a5c", "#20c5d2", "#8b9cf0"];

async function initWorkspaces() {
  const { workspaces: list } = await GET("/api/workspaces");
  workspaces = list;
  const stored = localStorage.getItem(WS_KEY);
  const found = list.find((x) => String(x.id) === String(stored));
  wsId = (found || list[0] || {}).id ?? null;
  renderWsSwitcher();
  $("#ws-btn").onclick = (e) => {
    e.stopPropagation();
    $("#ws-menu").hidden = !$("#ws-menu").hidden;
  };
  document.addEventListener("click", (e) => {
    const m = $("#ws-menu");
    if (m && !m.hidden && !e.target.closest(".ws-wrap")) m.hidden = true;
  });
}

function setWorkspace(id) {
  wsId = id;
  localStorage.setItem(WS_KEY, String(id));
  paletteBust();
  renderWsSwitcher();
  route();
}

function renderWsSwitcher() {
  const w = workspaces.find((x) => x.id === wsId);
  $("#ws-dot").style.background = (w && w.color) || "#999";
  $("#ws-name").textContent = (w && w.name) || "—";
  const menu = $("#ws-menu");
  menu.innerHTML =
    workspaces.map((x) => `
      <button class="ws-item${x.id === wsId ? " on" : ""}" data-ws="${x.id}">
        <span class="ws-dot" style="background:${esc(x.color)}"></span>
        <span class="ws-iname">${esc(x.name)}</span>
        ${x.id === wsId ? `<span class="ws-check">✓</span>` : ""}
      </button>`).join("") +
    `<div class="ws-sep"></div>
     <button class="ws-item ws-action" data-ws-new="1">＋ New workspace</button>
     <button class="ws-item ws-action" data-ws-manage="1">⚙ Manage workspaces</button>`;
  menu.querySelectorAll("[data-ws]").forEach((b) => {
    b.onclick = () => {
      menu.hidden = true;
      if (Number(b.dataset.ws) !== wsId) setWorkspace(Number(b.dataset.ws));
    };
  });
  menu.querySelector("[data-ws-new]").onclick = () => { menu.hidden = true; newWorkspaceModal(); };
  menu.querySelector("[data-ws-manage]").onclick = () => { menu.hidden = true; manageWorkspacesModal(); };
}

const wsSwatches = (current) => `
  <div class="ws-colors">${WS_COLORS.map((c) =>
    `<button type="button" class="ws-swatch${c === current ? " on" : ""}" data-c="${c}" style="background:${c}" aria-label="color ${c}"></button>`
  ).join("")}</div>
  <input type="hidden" name="color" value="${esc(current || WS_COLORS[0])}">`;
const wireSwatches = () => {
  document.querySelectorAll("#modal-root .ws-swatch").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#modal-root .ws-swatch").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      document.querySelector('#modal-root input[name="color"]').value = b.dataset.c;
    };
  });
};

function newWorkspaceModal() {
  openModal("New workspace", `
    ${field("Name", input("name", "", "text", "required"))}
    ${field("Color", wsSwatches(WS_COLORS[0]))}`,
    async (d) => {
      if (!d.name.trim()) { alert("Give the workspace a name."); return; }
      const { workspace } = await POST("/api/workspaces", d);
      workspaces = (await GET("/api/workspaces")).workspaces;
      setWorkspace(workspace.id);
    }, "Create workspace");
  wireSwatches();
}

function editWorkspaceModal(w) {
  openModal("Edit workspace", `
    ${field("Name", input("name", w.name))}
    ${field("Color", wsSwatches(w.color))}`,
    async (d) => {
      if (!d.name.trim()) { alert("Give the workspace a name."); return; }
      await PATCH(`/api/workspaces/${w.id}`, { name: d.name.trim(), color: d.color });
      workspaces = (await GET("/api/workspaces")).workspaces;
      renderWsSwitcher();
    }, "Save");
  wireSwatches();
}

const wsRecordCount = (w) =>
  (w.companies || 0) + (w.contacts || 0) + (w.deals || 0) + (w.tasks || 0) + (w.campaigns || 0);

function deleteWorkspaceModal(w) {
  const n = wsRecordCount(w);
  openModal(`Delete "${w.name}"?`, `
    ${n > 0
      ? `<p style="color:var(--text-2)">This workspace holds <b>${n}</b> record${n === 1 ? "" : "s"}.
         Deleting it removes them <b>permanently</b>. To confirm, type the workspace name below.</p>
         ${field(`Type "${w.name}" to confirm`, input("confirm", "", "text", "required"))}`
      : `<p style="color:var(--text-2)">This workspace is empty — deleting it is safe.</p>`}`,
    async (d) => {
      try {
        await api("DELETE", `/api/workspaces/${w.id}`, n > 0 ? { confirm: d.confirm } : {});
      } catch (e) {
        alert("Delete failed: " + (e.message || e));
        return;
      }
      workspaces = (await GET("/api/workspaces")).workspaces;
      if (w.id === wsId) wsId = workspaces[0].id;
      localStorage.setItem(WS_KEY, String(wsId));
      paletteBust();
      renderWsSwitcher();
      route();
    }, "Delete workspace");
}

function manageWorkspacesModal() {
  openModal("Manage workspaces", `
    <div>${workspaces.map((w) => `
      <div class="ws-row">
        <span class="ws-dot" style="background:${esc(w.color)}"></span>
        <div class="ws-row-main">
          <div class="ws-row-name">${esc(w.name)}${w.id === wsId ? ` <span class="tag">active</span>` : ""}</div>
          <div class="ws-row-sub">${wsRecordCount(w)} records · ${w.deals || 0} deals</div>
        </div>
        <button class="btn ghost small" data-ws-edit="${w.id}">Edit</button>
        <button class="btn danger small" data-ws-del="${w.id}" ${workspaces.length <= 1 ? "disabled" : ""}>Delete</button>
      </div>`).join("")}</div>`,
    async () => {}, "Done");
  document.querySelectorAll("#modal-root [data-ws-edit]").forEach((b) => {
    b.onclick = () => {
      const w = workspaces.find((x) => x.id === Number(b.dataset.wsEdit));
      if (w) editWorkspaceModal(w);
    };
  });
  document.querySelectorAll("#modal-root [data-ws-del]").forEach((b) => {
    b.onclick = () => {
      const w = workspaces.find((x) => x.id === Number(b.dataset.wsDel));
      if (w) deleteWorkspaceModal(w);
    };
  });
}

/* ---------- click-to-edit table cells ----------
   makeEditable(td, kind, opts, onSave)
   kind: "text" | "email" | "select"; opts: { value, options? }
   onSave(newValue) -> PATCHes; returns display HTML string, or false to reject. */
function makeEditable(td, kind, opts, onSave) {
  td.classList.add("editable");
  td.title = "Click to edit";
  td.onclick = () => {
    if (td.dataset.editing) return;
    td.dataset.editing = "1";
    const orig = td.innerHTML;
    let el;
    if (kind === "select") {
      el = document.createElement("select");
      for (const [v, l] of opts.options) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = l;
        if (String(v) === String(opts.value)) o.selected = true;
        el.appendChild(o);
      }
    } else {
      el = document.createElement("input");
      el.type = kind;
      el.value = opts.value || "";
    }
    el.className = "cell-edit";
    td.innerHTML = "";
    td.appendChild(el);
    el.focus();
    if ((kind === "text" || kind === "email") && el.select) el.select();
    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      td.innerHTML = orig;
      delete td.dataset.editing;
    };
    const commit = async () => {
      if (done) return;
      done = true;
      const val = kind === "select" ? el.value : el.value.trim();
      td.innerHTML = orig;
      delete td.dataset.editing;
      if (String(val) === String(opts.value ?? "")) return;
      td.classList.add("saving");
      try {
        const html = await onSave(val);
        if (typeof html === "string") td.innerHTML = html;
        td.classList.add("flash");
        setTimeout(() => td.classList.remove("flash"), 650);
      } catch (e) {
        alert("Save failed: " + (e.message || e));
      } finally {
        td.classList.remove("saving");
      }
    };
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    el.addEventListener("blur", () => commit());
    if (kind === "select" || kind === "date") el.addEventListener("change", () => commit());
  };
}

function wireEditButtons(onEdit) {
  document.querySelectorAll("#view [data-edit]").forEach((b) => {
    b.onclick = () => onEdit(Number(b.dataset.edit));
  });
}

function wireContactCells(contacts, companies) {
  document.querySelectorAll("#view td[data-f]").forEach((td) => {
    const id = Number(td.dataset.cid);
    const c = contacts.find((x) => x.id === id);
    const f = td.dataset.f;
    if (!c) return;
    if (f === "company_id") {
      makeEditable(td, "select",
        { value: c.company_id || "", options: [["", "—"]].concat(companies.map((x) => [x.id, x.name])) },
        async (v) => {
          await PATCH(`/api/contacts/${id}`, { company_id: v });
          const found = companies.find((x) => String(x.id) === String(v));
          const label = v ? (found ? found.name : "?") : "—";
          c.company_id = v || null;
          c.company_name = v ? label : null;
          return esc(label);
        });
    } else {
      makeEditable(td, f === "email" ? "email" : "text", { value: c[f] || "" }, async (v) => {
        if (f === "name" && !v) return false;
        await PATCH(`/api/contacts/${id}`, { [f]: v });
        c[f] = v;
        return f === "name" ? `<b>${esc(v)}</b>` : (esc(v) || "—");
      });
    }
  });
  wireEditButtons((id) => {
    const c = contacts.find((x) => x.id === id);
    if (c) editContactModal(c);
  });
}

function wireCompanyCells(companies) {
  document.querySelectorAll("#view td[data-f]").forEach((td) => {
    const id = Number(td.dataset.cid);
    const c = companies.find((x) => x.id === id);
    const f = td.dataset.f;
    if (!c) return;
    makeEditable(td, "text", { value: c[f] || "" }, async (v) => {
      if (f === "name" && !v) return false;
      await PATCH(`/api/companies/${id}`, { [f]: v });
      c[f] = v;
      return f === "name" ? `<b>${esc(v)}</b>` : (esc(v) || "—");
    });
  });
  wireEditButtons((id) => {
    const c = companies.find((x) => x.id === id);
    if (c) editCompanyModal(c);
  });
}

/* ---------- views ---------- */
const state = { stages: [], labels: {}, colors: {} };
let pipeView = "board"; // pipeline tab: "board" | "timeline"
let ganttZoom = "fit";  // timeline range: "fit" | "3m" | "6m" | "1y"
let campBoardFilter = "all"; // campaigns-overview pipeline board: "all" | campaign id | "none"

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

/* Shared drag-and-drop pipeline kanban board: every deal grouped into a column
   per stage (workspace stage order, closed stages last). When campNameById (a
   Map of campaign id -> name) is passed, each deal card carries a campaign
   badge so the board reads as the cross-campaign pipeline. Deal cards are
   wired by initDealDrag (drag between columns persists via PATCH /api/deals/:id;
   plain click opens the deal editor). */
function boardHtml(deals, campNameById) {
  const closedStages = ["closed_won", "closed_lost"];
  // stages not in the workspace order still get their own column so their
  // deals never vanish from the board (same convention as the strip)
  const extra = [...new Set(deals.map((d) => d.stage))].filter((s) => !state.stages.includes(s));
  const order = [...state.stages.filter((s) => !closedStages.includes(s)), ...extra, ...closedStages];
  return `<div class="board" id="board">
    ${order.map((s) => {
      const ds = deals.filter((d) => d.stage === s);
      const tot = ds.reduce((a, d) => a + (Number(d.value) || 0), 0);
      return `<div class="column" data-stage="${s}">
        <div class="chead"><div class="dot" style="background:${stageColor(s)}"></div>
          <div class="cname">${esc(state.labels[s] || s)}</div>
          <div class="ctotal">${ds.length} · ${moneyShort(tot)}</div></div>
        ${ds.map((d) => `
          <div class="deal-card" data-id="${d.id}">
            <div class="trow"><span class="sdot" style="background:${stageColor(s)}"></span><div class="t">${esc(d.title)}</div></div>
            <div class="co">${esc(d.company_name || "—")}${d.contact_name ? " · " + esc(d.contact_name) : ""}</div>
            ${campNameById ? `<div style="margin-top:6px"><span class="pill" style="background:var(--border-soft);color:var(--text-2)">${esc(campNameById.get(d.campaign_id) || "No campaign")}</span></div>` : ""}
            <div class="row"><div class="val">${money(d.value)}</div><div class="prob">${d.probability}%</div></div>
          </div>`).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

async function vPipeline() {
  const { deals } = await GET("/api/deals");
  const open = deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage));
  const closedStages = ["closed_won", "closed_lost"];
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg">
        <button data-pv="board" class="${pipeView === "board" ? "on" : ""}">Board</button>
        <button data-pv="timeline" class="${pipeView === "timeline" ? "on" : ""}">Timeline</button>
      </div>
      <div class="spacer"></div>
      ${pipeView === "timeline" ? `
      <div class="seg small">
        <button data-gz="fit" class="${ganttZoom === "fit" ? "on" : ""}">Fit</button>
        <button data-gz="3m" class="${ganttZoom === "3m" ? "on" : ""}">3M</button>
        <button data-gz="6m" class="${ganttZoom === "6m" ? "on" : ""}">6M</button>
        <button data-gz="1y" class="${ganttZoom === "1y" ? "on" : ""}">1Y</button>
      </div>` : `
      <span style="color:var(--text-2)">${open.length} open deals · ${money(open.reduce((a, d) => a + d.value, 0))} pipeline</span>`}
      <button class="btn" id="new-deal">+ New deal</button>
    </div>
    ${pipeView === "board" ? boardHtml(deals) : ganttHtml(open)}
`;

  document.querySelectorAll("[data-pv]").forEach((b) =>
    (b.onclick = () => { pipeView = b.dataset.pv; route(); }));
  document.querySelectorAll("[data-gz]").forEach((b) =>
    (b.onclick = () => { ganttZoom = b.dataset.gz; route(); }));
  $("#new-deal").onclick = () => newDealModal();
  if (pipeView === "board") initDealDrag(deals);
  else wireGantt(open);
}

/* Per-deal Gantt: bar runs from created_at to expected_close.
   Deals with no close date render as striped bars ending today. */
function ganttHtml(deals) {
  const DAY = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const t = today.getTime();
  const dp = (s) => {
    if (!s) return null;
    const str = String(s);
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(str) ? str + "T12:00:00" : str.replace(" ", "T");
    const ms = new Date(iso).getTime();
    return isNaN(ms) ? null : ms;
  };
  const rows = deals
    .map((d) => {
      const s = dp(d.created_at) ?? t;
      const e = dp(d.expected_close);
      return { d, s, e: e ?? t, tbd: !e };
    })
    .sort((a, b) => (a.tbd ? 1 : 0) - (b.tbd ? 1 : 0) || a.e - b.e || b.d.value - a.d.value);

  if (!rows.length) return `<div class="empty">No open deals to chart.</div>`;

  let start, end;
  if (ganttZoom === "fit") {
    start = Math.min(t, ...rows.map((r) => r.s)) - 7 * DAY;
    end = Math.max(t, ...rows.map((r) => r.e)) + 14 * DAY;
  } else {
    start = t - 30 * DAY;
    end = t + { "3m": 90, "6m": 180, "1y": 365 }[ganttZoom] * DAY;
  }
  const ws = new Date(start);
  ws.setHours(0, 0, 0, 0);
  ws.setDate(ws.getDate() - ((ws.getDay() + 6) % 7)); // align to Monday
  const w0 = ws.getTime();
  const W = Math.max(4, Math.ceil((end - w0) / (7 * DAY)));
  const range = W * 7 * DAY;
  const pct = (ms) => Math.max(0, Math.min(100, ((ms - w0) / range) * 100));

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let head = "";
  for (let i = 0; i < W; i++) {
    const wd = new Date(w0 + i * 7 * DAY);
    head += `<div class="g-th">${wd.getDate() <= 7 ? MON[wd.getMonth()] : ""}</div>`;
  }
  const body = rows
    .map(({ d, s, e, tbd }) => {
      const l = pct(Math.max(s, w0));
      const wPct = Math.max(pct(Math.min(Math.max(e, s), w0 + range)) - l, 1.2);
      return `<div class="g-label" data-id="${d.id}">
          <div class="gl-t">${esc(d.title)}</div>
          <div class="gl-s">${esc(d.company_name || "—")} · ${moneyShort(d.value)}</div>
        </div>
        <div class="g-lane">
          <div class="g-bar${tbd ? " tentative" : ""}" data-id="${d.id}"
            title="${esc(d.title)} · ${money(d.value)}${d.expected_close ? " · closes " + esc(d.expected_close) : " · no close date set"}"
            style="left:${l.toFixed(2)}%;width:${wPct.toFixed(2)}%;background:${stageColor(d.stage)}">${wPct > 14 ? `<span>${moneyShort(d.value)}</span>` : ""}</div>
        </div>`;
    })
    .join("");

  const todayX = 280 + ((t - w0) / DAY) * (34 / 7);
  const showToday = t >= w0 && t <= w0 + range;
  return `<div class="g-scroll"><div class="g-wrap">
    <div class="g-grid" style="grid-template-columns:280px repeat(${W},34px)">
      <div class="g-corner">Deal</div>${head}${body}
    </div>
    ${showToday ? `<div class="g-today" style="left:${todayX.toFixed(1)}px"><span>Today</span></div>` : ""}
  </div></div>`;
}

function wireGantt(deals) {
  document.querySelectorAll(".g-bar, .g-label").forEach((el) => {
    el.onclick = () => {
      const d = deals.find((x) => x.id === Number(el.dataset.id));
      if (d) editDealModal(d);
    };
  });
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
    const newStage = targetCol ? targetCol.dataset.stage : d.oldStage;
    const moved = !!targetCol && newStage !== d.oldStage;
    const dest = targetCol ? d.ph.getBoundingClientRect() : d.rect;
    const cur = card.getBoundingClientRect();
    // phase 1: glide the floating card into the placeholder
    card.style.transition = "transform 0.19s cubic-bezier(0.22, 1, 0.36, 1)";
    card.style.transform = `translate(${d.x + (dest.left - cur.left)}px, ${d.y + (dest.top - cur.top)}px)`;
    setTimeout(async () => {
      if (!moved) {
        // same column (or cancelled): glide back to origin and restore in place, no re-render
        const back = d.rect;
        const c2 = card.getBoundingClientRect();
        card.style.transform = `translate(${d.x + (back.left - c2.left)}px, ${d.y + (back.top - c2.top)}px)`;
        setTimeout(() => cleanup(d), 200);
        return;
      }
      try {
        await PATCH(`/api/deals/${d.id}`, { stage: newStage });
      } catch {}
      // phase 2: keep the floating card alive as an overlay while the board
      // re-renders underneath, then crossfade onto the fresh card (no snap)
      if (d.ph) d.ph.remove();
      board.querySelectorAll(".column").forEach((c) => c.classList.remove("dragover"));
      document.body.appendChild(card); // survive the innerHTML wipe in route()
      card.style.transition = "none";
      await route();
      const freshBoard = $("#board");
      const fresh = freshBoard && freshBoard.querySelector(`.deal-card[data-id="${d.id}"]`);
      if (!fresh) { card.remove(); return; }
      fresh.style.visibility = "hidden";
      const fr = fresh.getBoundingClientRect();
      card.style.transition = "transform 0.16s cubic-bezier(0.22, 1, 0.36, 1)";
      card.style.transform = `translate(${fr.left - d.rect.left}px, ${fr.top - d.rect.top}px)`;
      setTimeout(() => {
        card.remove();
        fresh.style.removeProperty("visibility");
      }, 170);
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
  const { campaigns } = await GET("/api/campaigns");
  const close = openModal("Edit deal", `
    <div class="formgrid">
      ${field("Title", input("title", d.title))}
      ${field("Value ($)", input("value", d.value, "number"))}
      ${field("Company", select("company_id", [["", "—"]].concat(companies.map((c) => [c.id, c.name])), d.company_id || ""))}
      ${field("Contact", select("contact_id", [["", "—"]].concat(contacts.map((c) => [c.id, c.name])), d.contact_id || ""))}
      ${field("Stage", select("stage", state.stages.map((s) => [s, state.labels[s]]), d.stage))}
      ${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((c) => [c.id, c.name])), d.campaign_id || ""))}
      ${field("Probability %", input("probability", d.probability, "number"))}
      ${field("Expected close", input("expected_close", d.expected_close || "", "date"))}
      ${field("Owner", input("owner", d.owner || ""))}
    </div>
    <div class="field"><label>Calendar</label><div id="deal-cal"><div class="empty">Loading…</div></div></div>`,
    async (data) => {
      if (data.company_id === "") data.company_id = null;
      if (data.contact_id === "") data.contact_id = null;
      if (data.campaign_id === "") data.campaign_id = null;
      await PATCH(`/api/deals/${d.id}`, data);
      route();
    }, "Save changes");
  // mini read-only calendar: this deal's expected close + its tasks' due dates
  (async () => {
    try {
      const now = new Date();
      const anchor = /^\d{4}-\d{2}-\d{2}$/.test(d.expected_close || "")
        ? d.expected_close.split("-").map(Number)
        : [now.getFullYear(), now.getMonth() + 1];
      const { from, to } = calVisibleRange(anchor[0], anchor[1] - 1);
      const { items } = await GET(`/api/calendar?scope=deal&id=${d.id}&from=${from}&to=${to}`);
      const byDate = {};
      for (const it of items) (byDate[it.date] = byDate[it.date] || []).push(it);
      const host = document.querySelector("#deal-cal");
      if (host) host.innerHTML =
        monthGridHtml(anchor[0], anchor[1] - 1, byDate, { mini: true, today: toISODate(new Date()) }) +
        (items.length ? "" : `<div class="empty" style="margin-top:6px">No dates set — add an expected close date or task due dates.</div>`);
    } catch { /* calendar is decorative; never block the editor */ }
  })();
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
  const { campaigns } = await GET("/api/campaigns");
  openModal("New deal", `
    <div class="formgrid">
      ${field("Title", input("title", "", "text", "required"))}
      ${field("Value ($)", input("value", "50000", "number"))}
      ${field("Company", select("company_id", companies.map((c) => [c.id, c.name])))}
      ${field("Contact", select("contact_id", contacts.map((c) => [c.id, c.name])))}
      ${field("Stage", select("stage", state.stages.map((s) => [s, state.labels[s]])))}
      ${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((c) => [c.id, c.name]))))}
      ${field("Probability %", input("probability", "20", "number"))}
      ${field("Expected close", input("expected_close", "", "date"))}
      ${field("Owner", input("owner", "You"))}
    </div>`,
    async (d) => { await POST("/api/deals", d); route(); }, "Create deal");
}

async function newContactModal(presetCampaignId) {
  const [{ companies }, fields, { campaigns }] = await Promise.all([GET("/api/companies"), getSchemaFields("contact"), GET("/api/campaigns")]);
  openModal("New contact", `
    <div class="formgrid">
      ${field("Name", input("name"))}
      ${field("Title", input("title"))}
      ${field("Company", select("company_id", companies.map((c) => [c.id, c.name])))}
      ${field("Email", input("email", "", "email"))}
      ${field("Phone", input("phone"))}
      ${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((c) => [c.id, c.name])), presetCampaignId || ""))}
    </div>
    ${cfFieldsHtml(fields)}`,
    async (d) => { await POST("/api/contacts", d); route(); }, "Create contact");
}

async function vContacts() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
  const [{ contacts }, { companies }] = await Promise.all([
    GET(`/api/contacts?q=${encodeURIComponent(q)}`),
    GET("/api/companies"),
  ]);
  view.innerHTML = `
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search name or email…" value="${esc(q)}">
      <button class="btn ghost" id="go">Search</button>
      <div class="spacer"></div>
      <button class="btn" id="new-contact">+ New contact</button>
    </div>
    <p class="hint">Tip: click any cell to edit it in place — Enter saves, Esc cancels.</p>
    <div class="panel"><table>
      <tr><th>Name</th><th>Title</th><th>Company</th><th>Email</th><th>Phone</th><th></th></tr>
      ${contacts.map((c) => `<tr>
        <td data-cid="${c.id}" data-f="name"><b>${esc(c.name)}</b></td>
        <td data-cid="${c.id}" data-f="title">${esc(c.title) || "—"}</td>
        <td data-cid="${c.id}" data-f="company_id">${esc(c.company_name || "—")}</td>
        <td data-cid="${c.id}" data-f="email">${esc(c.email) || "—"}</td>
        <td data-cid="${c.id}" data-f="phone">${esc(c.phone) || "—"}</td>
        <td class="rowact"><button class="btn ghost small" data-edit="${c.id}">Edit</button></td>
      </tr>`).join("")}
    </table>${contacts.length ? "" : `<div class="empty">No contacts match.</div>`}</div>`;
  const go = () => location.hash = `#/contacts?q=${encodeURIComponent($("#q").value)}`;
  $("#go").onclick = go;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  wireContactCells(contacts, companies);
  $("#new-contact").onclick = () => newContactModal();
}

async function editContactModal(c) {
  const [{ companies }, fields, { campaigns }] = await Promise.all([GET("/api/companies"), getSchemaFields("contact"), GET("/api/campaigns")]);
  openModal("Edit contact", `
    <div class="formgrid">
      ${field("Name", input("name", c.name))}
      ${field("Title", input("title", c.title))}
      ${field("Company", select("company_id", [["", "—"]].concat(companies.map((x) => [x.id, x.name])), c.company_id || ""))}
      ${field("Email", input("email", c.email, "email"))}
      ${field("Phone", input("phone", c.phone))}
      ${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((x) => [x.id, x.name])), c.campaign_id || ""))}
    </div>
    ${cfFieldsHtml(fields, c.custom)}`,
    async (d) => {
      if (d.company_id === "") d.company_id = null;
      if (d.campaign_id === "") d.campaign_id = null;
      await PATCH(`/api/contacts/${c.id}`, d); route();
    }, "Save changes");
}

async function newCompanyModal(presetCampaignId) {
  const [fields, { campaigns }] = await Promise.all([getSchemaFields("company"), GET("/api/campaigns")]);
  openModal("New company", `
    ${field("Name", input("name"))}
    <div class="formgrid">${field("Industry", input("industry"))}${field("Website", input("website"))}${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((c) => [c.id, c.name])), presetCampaignId || ""))}</div>
    ${cfFieldsHtml(fields)}`,
    async (d) => { await POST("/api/companies", d); route(); }, "Create company");
}

async function vCompanies() {
  const { companies } = await GET("/api/companies");
  view.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      <button class="btn" id="new-company">+ New company</button></div>
    <p class="hint">Tip: click any cell to edit it in place — Enter saves, Esc cancels.</p>
    <div class="panel"><table>
      <tr><th>Company</th><th>Industry</th><th>Website</th><th>Deals</th><th>Open pipeline</th><th></th></tr>
      ${companies.map((c) => `<tr>
        <td data-cid="${c.id}" data-f="name"><b>${esc(c.name)}</b></td>
        <td data-cid="${c.id}" data-f="industry">${esc(c.industry) || "—"}</td>
        <td data-cid="${c.id}" data-f="website">${esc(c.website) || "—"}</td>
        <td>${c.deal_count}</td><td><b>${money(c.open_value)}</b></td>
        <td class="rowact"><button class="btn ghost small" data-edit="${c.id}">Edit</button></td>
      </tr>`).join("")}
    </table></div>`;
  wireCompanyCells(companies);
  $("#new-company").onclick = () => newCompanyModal();
}

async function editCompanyModal(c) {
  const [fields, { campaigns }] = await Promise.all([getSchemaFields("company"), GET("/api/campaigns")]);
  openModal("Edit company", `
    ${field("Name", input("name", c.name))}
    <div class="formgrid">${field("Industry", input("industry", c.industry))}${field("Website", input("website", c.website))}${field("Campaign", select("campaign_id", [["", "—"]].concat(campaigns.map((x) => [x.id, x.name])), c.campaign_id || ""))}</div>
    ${cfFieldsHtml(fields, c.custom)}`,
    async (d) => {
      if (d.campaign_id === "") d.campaign_id = null;
      await PATCH(`/api/companies/${c.id}`, d); route();
    }, "Save changes");
}

/* ---------- campaigns ---------- */
const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"];

/* New-campaign draft rows: quick-add contacts & companies inline.
   Draft inputs carry no `name` attribute so openModal's generic collector
   ignores them — collectDrafts() gathers them explicitly on submit. */
function draftContactRowHtml() {
  return `<div class="draft-row" data-draft-contact>
    <input class="draft-name" placeholder="Name" autocomplete="off">
    <input class="draft-email" type="email" placeholder="Email (optional)" autocomplete="off">
    <button type="button" class="btn ghost small draft-rm" aria-label="Remove row">✕</button></div>`;
}
function draftCompanyRowHtml() {
  return `<div class="draft-row" data-draft-company>
    <input class="draft-name" placeholder="Name" autocomplete="off">
    <input class="draft-website" placeholder="Website (optional)" autocomplete="off">
    <button type="button" class="btn ghost small draft-rm" aria-label="Remove row">✕</button></div>`;
}
function wireDraftRows(addBtnId, listId, rowHtml) {
  $(`#${addBtnId}`).onclick = () => {
    const list = $(`#${listId}`);
    list.insertAdjacentHTML("beforeend", rowHtml());
    list.lastElementChild.querySelector(".draft-rm").onclick = (e) =>
      e.target.closest(".draft-row").remove();
  };
}
function collectDrafts() {
  const drafts = [];
  document.querySelectorAll("#modal-root [data-draft-contact]").forEach((row) => {
    const name = row.querySelector(".draft-name").value.trim();
    if (!name) return; // blank rows skipped silently
    drafts.push({ kind: "contact", name, body: { name, email: row.querySelector(".draft-email").value.trim() } });
  });
  document.querySelectorAll("#modal-root [data-draft-company]").forEach((row) => {
    const name = row.querySelector(".draft-name").value.trim();
    if (!name) return;
    drafts.push({ kind: "company", name, body: { name, website: row.querySelector(".draft-website").value.trim() } });
  });
  return drafts;
}

/* compact per-campaign pipeline summary for the campaigns overview */
function campaignPipelineStrip(deals) {
  if (!deals.length) return `<span style="color:var(--text-3);font-size:12.5px">No deals</span>`;
  const totals = new Map();
  for (const d of deals) totals.set(d.stage, (totals.get(d.stage) || 0) + (Number(d.value) || 0));
  const ordered = state.stages
    .filter((s) => totals.has(s))
    .concat([...totals.keys()].filter((s) => !state.stages.includes(s)));
  const total = [...totals.values()].reduce((a, v) => a + v, 0);
  const segs = ordered.map((s) => {
    const v = totals.get(s) || 0;
    return `<span title="${esc(state.labels[s] || s)}: ${money(v)}" style="display:block;height:100%;width:${total ? ((v / total) * 100).toFixed(1) : 0}%;background:${stageColor(s)}"></span>`;
  }).join("");
  return `<div style="display:flex;align-items:center;gap:8px;min-width:170px;max-width:260px">
    <div style="display:flex;height:8px;flex:1;border-radius:99px;overflow:hidden;background:var(--border-soft)">${segs}</div>
    <span style="font-size:12.5px;color:var(--text-2);white-space:nowrap">${deals.length} · <b>${moneyShort(total)}</b></span></div>`;
}

/* client-side campaign filter for the campaigns-overview pipeline board:
   "all" | a campaign id | "none" (deals not linked to any campaign) */
function filterBoardDeals(deals, filter) {
  if (filter === "all") return deals;
  if (filter === "none") return deals.filter((d) => d.campaign_id == null);
  return deals.filter((d) => String(d.campaign_id) === String(filter));
}

async function vCampaigns() {
  const [{ campaigns }, { companies }, { deals }] = await Promise.all([
    GET("/api/campaigns"), GET("/api/companies"), GET("/api/deals"),
  ]);
  const dealsByCamp = new Map();
  for (const d of deals || []) {
    if (d.campaign_id == null) continue;
    if (!dealsByCamp.has(d.campaign_id)) dealsByCamp.set(d.campaign_id, []);
    dealsByCamp.get(d.campaign_id).push(d);
  }
  /* Pipeline board below the list: all workspace deals as a cross-campaign
     kanban, filtered client-side by campaign. */
  const campNameById = new Map(campaigns.map((c) => [c.id, c.name]));
  const allDeals = deals || [];
  const boardDeals = filterBoardDeals(allDeals, campBoardFilter);
  const boardOpen = boardDeals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage));
  const boardValue = boardOpen.reduce((a, d) => a + (Number(d.value) || 0), 0);
  view.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      <button class="btn" id="new-campaign">+ New campaign</button></div>
    <div class="panel"><table>
      <tr><th>Campaign</th><th>Company</th><th>Status</th><th>Start</th><th>End</th><th>Budget</th><th>Pipeline</th></tr>
      ${campaigns.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td>
        <td>${esc(c.company_name) || "—"}</td>
        <td>${statusPill(c.status)}</td><td>${esc(c.start_date) || "—"}</td><td>${esc(c.end_date) || "—"}</td>
        <td><b>${money(c.budget)}</b></td>
        <td>${campaignPipelineStrip(dealsByCamp.get(c.id) || [])}</td></tr>`).join("")}
    </table>${campaigns.length ? "" : `<div class="empty">No campaigns yet — launch your first one.</div>`}</div>
    <div class="panel">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <h2 style="margin:0">Pipeline</h2>
        <select id="board-camp-filter" style="max-width:230px;width:auto">
          <option value="all" ${campBoardFilter === "all" ? "selected" : ""}>All campaigns</option>
          ${campaigns.map((c) => `<option value="${c.id}" ${String(campBoardFilter) === String(c.id) ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          <option value="none" ${campBoardFilter === "none" ? "selected" : ""}>No campaign</option>
        </select>
        <span style="color:var(--text-2);font-size:12.5px">${boardOpen.length} open deals · ${money(boardValue)} pipeline</span>
        <div class="spacer"></div>
        <button class="btn" id="new-deal">+ New deal</button>
      </div>
      ${boardHtml(boardDeals, campNameById)}
    </div>`;
  document.querySelectorAll("#view tr.clickable").forEach((tr) => {
    tr.onclick = () => { location.hash = `#/campaigns/${tr.dataset.id}`; };
  });
  $("#board-camp-filter").onchange = (e) => { campBoardFilter = e.target.value; route(); };
  $("#new-deal").onclick = () => newDealModal();
  if ($("#board")) initDealDrag(allDeals);
  $("#new-campaign").onclick = async () => {
    const fields = await getSchemaFields("campaign");
    openModal("New campaign", `
      ${field("Name", input("name"))}
      ${field("Company *", select("company_id", [["", "— Select company —"]].concat(companies.map((x) => [x.id, x.name]))))}
      <div class="formgrid">
        ${field("Status", select("status", CAMPAIGN_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), "draft"))}
        ${field("Budget ($)", input("budget", "0", "number"))}
        ${field("Start date", input("start_date", "", "date"))}
        ${field("End date", input("end_date", "", "date"))}
      </div>
      ${field("Notes", `<textarea name="notes" rows="3"></textarea>`)}
      <div class="field"><label>Contacts <span style="color:var(--text-3);font-weight:normal">optional</span></label>
        <div id="draft-contacts"></div>
        <button type="button" class="btn ghost small" id="draft-add-contact" style="margin-top:6px">+ Add contact</button></div>
      <div class="field"><label>Companies <span style="color:var(--text-3);font-weight:normal">optional</span></label>
        <div id="draft-companies"></div>
        <button type="button" class="btn ghost small" id="draft-add-company" style="margin-top:6px">+ Add company</button></div>
      ${cfFieldsHtml(fields)}`,
      async (d) => {
        if (!d.company_id) { alert("Please choose a company for this campaign."); return; }
        const { campaign } = await POST("/api/campaigns", d);
        // Create draft contacts/companies against the new campaign. Drafts are
        // best-effort: a failure surfaces but never rolls back the campaign.
        const failed = [];
        for (const dr of collectDrafts()) {
          try {
            await POST(`/api/${dr.kind === "contact" ? "contacts" : "companies"}`,
              { ...dr.body, campaign_id: campaign.id });
          } catch (e) { failed.push(`${dr.kind} "${dr.name}": ${e.message}`); }
        }
        if (failed.length) {
          alert(`Campaign created, but ${failed.length} draft${failed.length === 1 ? "" : "s"} failed:\n- ${failed.join("\n- ")}`);
        }
        location.hash = `#/campaigns/${campaign.id}`;
      }, "Create campaign");
    wireDraftRows("draft-add-contact", "draft-contacts", draftContactRowHtml);
    wireDraftRows("draft-add-company", "draft-companies", draftCompanyRowHtml);
  };
}

async function editCampaignModal(c) {
  const [fields, { companies }] = await Promise.all([getSchemaFields("campaign"), GET("/api/companies")]);
  openModal("Edit campaign", `
    ${field("Name", input("name", c.name))}
    ${field("Company *", select("company_id", [["", "— Select company —"]].concat(companies.map((x) => [x.id, x.name])), c.company_id || ""))}
    <div class="formgrid">
      ${field("Status", select("status", CAMPAIGN_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), c.status || "draft"))}
      ${field("Budget ($)", input("budget", c.budget || 0, "number"))}
      ${field("Start date", input("start_date", c.start_date || "", "date"))}
      ${field("End date", input("end_date", c.end_date || "", "date"))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="3">${esc(c.notes || "")}</textarea>`)}
    ${cfFieldsHtml(fields, c.custom)}
    <div style="margin-top:14px"><button class="btn danger small" id="m-delete">Delete campaign</button></div>`,
    async (d) => {
      if (!d.company_id) { alert("Please choose a company for this campaign."); return; }
      await PATCH(`/api/campaigns/${c.id}`, d);
      route();
    }, "Save changes");
  $("#m-delete").onclick = async () => {
    if (confirm(`Delete campaign "${c.name}"?`)) {
      await DEL(`/api/campaigns/${c.id}`);
      $("#modal-root").innerHTML = "";
      location.hash = "#/campaigns";
    }
  };
}

/* ---------- campaign detail: workflow task spreadsheet + widgets ---------- */
async function campaignEntities(id) {
  const [{ deals }, { contacts }, { companies }] = await Promise.all([
    GET(`/api/deals?campaign_id=${id}`),
    GET(`/api/contacts?campaign_id=${id}`),
    GET(`/api/companies?campaign_id=${id}`),
  ]);
  return { deals, contacts, companies };
}

async function vCampaignDetail(id) {
  const [{ campaigns }, { tasks }, { deals }, camp] = await Promise.all([
    GET("/api/campaigns"),
    GET(`/api/tasks?campaign_id=${id}`),
    GET("/api/deals"),
    campaignEntities(id),
  ]);
  const c = campaigns.find((x) => x.id === id);
  if (!c) {
    view.innerHTML = `<div class="empty">Campaign not found. <a href="#/campaigns">Back to campaigns</a>.</div>`;
    return;
  }
  renderCampaignDetail(c, tasks, deals, camp);
}

async function refreshCampaignDetail(c, deals) {
  const [{ tasks }, camp] = await Promise.all([
    GET(`/api/tasks?campaign_id=${c.id}`),
    campaignEntities(c.id),
  ]);
  renderCampaignDetail(c, tasks, deals, camp);
}

function campaignContactsHtml(contacts) {
  let body = `<div class="panel"><div class="sheet-head"><div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Contacts</h3>
    <span style="color:var(--text-3)">${contacts.length}</span></div>
    <button class="btn small" id="add-campaign-contact">+ Add contact</button></div>`;
  body += contacts.length
    ? `<table><tr><th>Name</th><th>Title</th><th>Company</th><th>Email</th></tr>
      ${contacts.map((ct) => `<tr><td><b>${esc(ct.name)}</b></td><td>${esc(ct.title) || "—"}</td>
        <td>${esc(ct.company_name) || "—"}</td><td>${esc(ct.email) || "—"}</td></tr>`).join("")}</table>`
    : `<div class="empty">No contacts linked — assign contacts from the contact editor.</div>`;
  return body + `</div>`;
}

function campaignCompaniesHtml(companies) {
  let body = `<div class="panel"><div class="sheet-head"><div style="display:flex;align-items:center;gap:8px"><h3 style="margin:0">Companies</h3>
    <span style="color:var(--text-3)">${companies.length}</span></div>
    <button class="btn small" id="add-campaign-company">+ Add company</button></div>`;
  body += companies.length
    ? `<table><tr><th>Company</th><th>Industry</th><th>Website</th></tr>
      ${companies.map((co) => `<tr><td><b>${esc(co.name)}</b></td><td>${esc(co.industry) || "—"}</td>
        <td>${esc(co.website) || "—"}</td></tr>`).join("")}</table>`
    : `<div class="empty">No companies linked — assign companies from the company editor.</div>`;
  return body + `</div>`;
}

function renderCampaignDetail(c, tasks, deals, camp) {
  const today = toISODate(new Date());
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const overdue = open.filter((t) => t.due_date && t.due_date < today);
  const pct = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;
  const next = open.filter((t) => t.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
  const sorted = [...tasks].sort((a, b) =>
    (a.done - b.done) || (a.due_date || "9999").localeCompare(b.due_date || "9999") || (a.id - b.id));
  const R = 26, CIRC = 2 * Math.PI * R;
  view.innerHTML = `
    <div class="toolbar">
      <a href="#/campaigns" class="btn ghost small">← Campaigns</a>
      <div class="spacer"></div>
      <button class="btn ghost" id="edit-campaign">Edit campaign</button>
    </div>
    <div class="panel camp-head">
      <div>
        <h2 style="margin:0 0 8px">${esc(c.name)}</h2>
        <div class="camp-meta">${statusPill(c.status)}
          <span>🏢 ${esc(c.company_name) || "—"}</span>
          <span>📅 ${esc(c.start_date) || "—"} → ${esc(c.end_date) || "—"}</span>
          <span>💰 <b>${money(c.budget)}</b></span>
        </div>
        ${c.notes ? `<p class="camp-notes">${esc(c.notes)}</p>` : ""}
      </div>
    </div>
    <div class="widgets">
      <div class="widget">
        <svg viewBox="0 0 64 64" class="ring" aria-label="${pct}% complete">
          <circle cx="32" cy="32" r="${R}" class="ring-bg"></circle>
          <circle cx="32" cy="32" r="${R}" class="ring-fg"
            stroke-dasharray="${(pct / 100 * CIRC).toFixed(1)} ${CIRC.toFixed(1)}"></circle>
        </svg>
        <div><div class="w-num">${pct}%</div><div class="w-label">complete</div></div>
      </div>
      <div class="widget"><div><div class="w-num">${open.length}</div><div class="w-label">open</div></div></div>
      <div class="widget"><div><div class="w-num" style="color:#e5484d">${overdue.length}</div><div class="w-label">overdue</div></div></div>
      <div class="widget"><div><div class="w-num" style="color:#18a058">${done.length}</div><div class="w-label">done</div></div></div>
      ${next ? `<div class="widget wide"><div><div class="w-label">next up</div>
        <div class="w-next">${esc(next.title)}</div><div class="w-due">due ${esc(next.due_date)}</div></div></div>` : ""}
    </div>
    <div class="cols2">
      ${campaignContactsHtml(camp.contacts)}
      ${campaignCompaniesHtml(camp.companies)}
    </div>
    <div class="panel sheet-wrap">
      <div class="sheet-head">
        <h3 style="margin:0">Workflow tasks</h3>
        <button class="btn small" id="add-task">+ Add task</button>
      </div>
      <table class="sheet">
        <thead><tr>
          <th class="c-done"></th><th>Task</th><th>Owner</th><th>Due</th><th></th><th></th>
        </tr></thead>
        <tbody>
          ${sorted.map((t) => `<tr class="${t.done ? "is-done" : ""}">
            <td class="c-done"><input type="checkbox" data-toggle="${t.id}" ${t.done ? "checked" : ""} aria-label="Done"></td>
            <td data-tid="${t.id}" data-f="title">${esc(t.title)}</td>
            <td data-tid="${t.id}" data-f="owner">${esc(t.owner) || "—"}</td>
            <td data-tid="${t.id}" data-f="due_date">${esc(t.due_date) || "—"}</td>
            <td class="rowact"><button class="btn ghost small" data-edit="${t.id}">Edit</button></td>
            <td class="rowact"><button class="btn ghost small danger-text" data-del="${t.id}" aria-label="Delete task">✕</button></td>
          </tr>`).join("")}
        </tbody>
      </table>
      ${tasks.length ? "" : `<div class="empty">No tasks yet — add the first step.</div>`}
    </div>
    <div class="panel">
      <h2 style="margin-top:0">Calendar</h2>
      <div id="camp-cal"></div>
    </div>`;
  $("#edit-campaign").onclick = () => editCampaignModal(c);
  $("#add-campaign-contact").onclick = () => newContactModal(c.id);
  $("#add-campaign-company").onclick = () => newCompanyModal(c.id);
  // inline cell editing
  document.querySelectorAll("#view td[data-f]").forEach((td) => {
    const t = tasks.find((x) => x.id === Number(td.dataset.tid));
    const f = td.dataset.f;
    if (!t) return;
    makeEditable(td, f === "due_date" ? "date" : "text", { value: t[f] || "" }, async (v) => {
      if (f === "title" && !v) return false;
      await PATCH(`/api/tasks/${t.id}`, { [f]: v });
      t[f] = v;
      return esc(v) || "—";
    });
  });
  // done toggles
  document.querySelectorAll('#view input[data-toggle]').forEach((cb) => {
    cb.onchange = async () => {
      await POST(`/api/tasks/${cb.dataset.toggle}/toggle`);
      refreshCampaignDetail(c, deals);
    };
  });
  // full edit (custom fields)
  document.querySelectorAll("#view [data-edit]").forEach((b) => {
    b.onclick = () => {
      const t = tasks.find((x) => x.id === Number(b.dataset.edit));
      if (t) editTaskModal(t, deals);
    };
  });
  // delete row
  document.querySelectorAll("#view [data-del]").forEach((b) => {
    b.onclick = async () => {
      const t = tasks.find((x) => x.id === Number(b.dataset.del));
      if (t && confirm(`Delete task "${t.title}"?`)) {
        await DEL(`/api/tasks/${t.id}`);
        refreshCampaignDetail(c, deals);
      }
    };
  });
  // add row
  $("#add-task").onclick = async () => {
    const { task } = await POST("/api/tasks", { title: "New task", campaign_id: c.id });
    await refreshCampaignDetail(c, deals);
    const td = document.querySelector(`#view td[data-tid="${task.id}"][data-f="title"]`);
    if (td) td.click();
  };
  // per-campaign calendar: deal close dates + campaign/deal task due dates
  const campCal = $("#camp-cal");
  if (campCal) mountCalendar(campCal, "campaign", c.id, { onItem: openCalItem });
}

/* shared task row + wiring (used by Daily Feed and campaign detail) */
function taskRow(t) {
  return `<div class="task ${t.done ? "done" : ""}">
    <input type="checkbox" data-id="${t.id}" ${t.done ? "checked" : ""}>
    <div><div class="tt">${esc(t.title)}</div>
      <div class="meta">${t.deal_title ? esc(t.deal_title) + " · " : ""}${t.due_date ? "due " + esc(t.due_date) + " · " : ""}${esc(t.owner)}</div></div>
    <div class="spacer"></div>
    <button class="btn ghost small" data-edit="${t.id}">Edit</button>
  </div>`;
}
function wireTaskRows(tasks, deals) {
  document.querySelectorAll('#view .task input[type="checkbox"]').forEach((cb) => {
    cb.onchange = async () => { await POST(`/api/tasks/${cb.dataset.id}/toggle`); route(); };
  });
  document.querySelectorAll("#view [data-edit]").forEach((b) => {
    b.onclick = () => {
      const t = tasks.find((x) => x.id === Number(b.dataset.edit));
      if (t) editTaskModal(t, deals);
    };
  });
}

const toISODate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/* ---------- calendar views (global, per-campaign, per-deal) ----------
   Read-only month grids over existing dated data: deal expected_close dates
   and task due dates. All arithmetic is local calendar days (toISODate);
   weeks start Monday. No event creation or drag-reschedule here. */
const CAL_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* 42 cells (6 full weeks) covering the month; each { date: "YYYY-MM-DD", inMonth }. */
function calCells(year, month) {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7; // Monday-first offset
  const start = new Date(year, month, 1 - lead);
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: toISODate(d), inMonth: d.getMonth() === month });
  }
  return cells;
}
function calVisibleRange(year, month) {
  const cells = calCells(year, month);
  return { from: cells[0].date, to: cells[cells.length - 1].date };
}
function calMonthLabel(year, month) {
  return new Date(year, month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
function calDayLabel(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}
/* byDate: { "YYYY-MM-DD": [ { type:"deal"|"task", id, title, date, done?, stage? } ] }.
   Pure HTML — no DOM access, so it is unit-testable. */
function monthGridHtml(year, month, byDate, opts = {}) {
  const today = opts.today || toISODate(new Date());
  const maxChips = opts.mini ? 2 : 3;
  const days = calCells(year, month).map((c) => {
    const items = (byDate[c.date] || []).slice().sort((a, b) =>
      a.type.localeCompare(b.type) || a.id - b.id);
    const shown = items.slice(0, maxChips);
    const extra = items.length - shown.length;
    const chips = shown.map((it) => {
      const doneish = it.type === "task" ? !!it.done : ["closed_won", "closed_lost"].includes(it.stage);
      const cls = `cal-chip ${it.type}${doneish ? " is-dim" : ""}${!doneish && c.date < today ? " is-overdue" : ""}`;
      const inner = esc(it.title);
      return opts.mini
        ? `<span class="${cls}" title="${inner}">${inner}</span>`
        : `<button type="button" class="${cls}" data-cal-item="${it.type}:${it.id}" title="${inner}">${inner}</button>`;
    }).join("");
    const cls = ["cal-day"];
    if (!c.inMonth) cls.push("is-out");
    if (c.date === today) cls.push("is-today");
    if (opts.selected === c.date) cls.push("is-selected");
    return `<div class="${cls.join(" ")}" data-cal-day="${c.date}" role="button" tabindex="0" aria-label="${c.date}">` +
      `<span class="cal-num">${Number(c.date.slice(8, 10))}</span>` +
      `<div class="cal-chips">${chips}${extra > 0 ? `<span class="cal-more">+${extra}</span>` : ""}</div></div>`;
  }).join("");
  return `<div class="cal-grid${opts.mini ? " cal-mini" : ""}" role="grid" aria-label="${esc(calMonthLabel(year, month))}">` +
    CAL_DOW.map((d) => `<div class="cal-dow">${d}</div>`).join("") + days + `</div>`;
}
/* One row in a calendar day-detail list. Carries data-cal-item for the shared binder. */
function calDayRowHtml(it, today) {
  const doneish = it.type === "task" ? !!it.done : ["closed_won", "closed_lost"].includes(it.stage);
  const od = !doneish && it.date < today;
  const meta = it.type === "deal"
    ? `${money(it.value)} · ${esc(it.stage_name || it.stage || "")}${it.company_name ? ` · ${esc(it.company_name)}` : ""}`
    : `${it.done ? "done" : `due ${esc(it.date)}`}${it.deal_title ? ` · ${esc(it.deal_title)}` : ""}`;
  return `<div class="cal-row${od ? " is-overdue" : ""}" data-cal-item="${it.type}:${it.id}" role="button" tabindex="0">` +
    `<span class="cal-dot ${it.type}"></span>` +
    `<div class="cal-row-text"><b>${esc(it.title)}</b><span>${meta}</span></div></div>`;
}
/* Click + keyboard delegation for grids and day lists. onDay(iso), onItem(type, id). */
function bindCalendarGrid(root, onDay, onItem) {
  root.addEventListener("click", (e) => {
    const item = e.target.closest("[data-cal-item]");
    if (item && onItem) {
      e.stopPropagation();
      const [type, id] = item.dataset.calItem.split(":");
      onItem(type, Number(id));
      return;
    }
    const day = e.target.closest("[data-cal-day]");
    if (day && onDay) onDay(day.dataset.calDay);
  });
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const t = e.target.closest("[data-cal-day],[data-cal-item]");
    if (!t) return;
    e.preventDefault();
    if (t.hasAttribute("data-cal-item") && onItem) {
      const [type, id] = t.dataset.calItem.split(":");
      onItem(type, Number(id));
    } else if (onDay) onDay(t.dataset.calDay);
  });
}
/* Self-contained month calendar. scope: global|campaign|deal. opts: { mini }.
   Fetches its own data, renders nav + grid + day list, opens entities via onItem.
   Returns a redraw function. */
async function mountCalendar(el, scope, id, opts = {}) {
  const now = new Date();
  let y = now.getFullYear(), m = now.getMonth();
  let selected = toISODate(now);
  const q = scope === "global" ? "" : `&id=${id}`;
  async function draw() {
    const { from, to } = calVisibleRange(y, m);
    const { items } = await GET(`/api/calendar?scope=${scope}${q}&from=${from}&to=${to}`);
    const byDate = {};
    for (const it of items) (byDate[it.date] = byDate[it.date] || []).push(it);
    const today = toISODate(new Date());
    const selItems = (byDate[selected] || []).slice().sort((a, b) =>
      a.type.localeCompare(b.type) || a.id - b.id);
    const deals = items.filter((i) => i.type === "deal");
    el.innerHTML = `
      ${opts.mini ? "" : `<div class="cal-head">
        <div class="cal-nav">
          <button class="btn ghost small" data-cal-nav="-1" aria-label="Previous month">←</button>
          <button class="btn ghost small" data-cal-nav="0">Today</button>
          <button class="btn ghost small" data-cal-nav="1" aria-label="Next month">→</button>
        </div>
        <h2 style="margin:0">${esc(calMonthLabel(y, m))}</h2>
        <div class="cal-legend">
          <span class="cal-legend-item"><span class="cal-dot deal"></span>Deal closes</span>
          <span class="cal-legend-item"><span class="cal-dot task"></span>Task due</span>
        </div>
      </div>`}
      ${monthGridHtml(y, m, byDate, { mini: opts.mini, selected: opts.mini ? undefined : selected, today })}
      ${opts.mini ? "" : `<div class="cal-daypanel">
        <h3>${esc(calDayLabel(selected))} <span class="count">${selItems.length}</span></h3>
        ${selItems.length ? selItems.map((it) => calDayRowHtml(it, today)).join("")
          : `<div class="empty">${items.length ? "Nothing scheduled this day." : "No dated items this month — set expected close dates on deals or due dates on tasks."}</div>`}
      </div>`}`;
    el.querySelectorAll("[data-cal-nav]").forEach((b) => {
      b.onclick = () => {
        const step = Number(b.dataset.calNav);
        if (step === 0) { const n = new Date(); y = n.getFullYear(); m = n.getMonth(); selected = toISODate(n); }
        else { const d = new Date(y, m + step, 1); y = d.getFullYear(); m = d.getMonth(); }
        draw();
      };
    });
    bindCalendarGrid(el,
      (d) => { selected = d; draw(); },
      opts.onItem ? (type, itemId) => opts.onItem(type, itemId, items, deals) : undefined);
  }
  await draw();
  return draw;
}
/* Open a calendar item in its editor modal. items/deals come from the calendar payload. */
function openCalItem(type, id, items, deals) {
  const it = items.find((x) => x.type === type && x.id === id);
  if (!it) return;
  if (type === "deal") editDealModal(it);
  else editTaskModal(it, deals);
}
/* Global calendar view: nav-level month grid over the whole workspace. */
async function vCalendar() {
  view.innerHTML = `<div id="cal-root"></div>`;
  await mountCalendar($("#cal-root"), "global", null, { onItem: openCalItem });
}

/* ---------- daily feed: what needs you today ---------- */
async function vFeed() {
  const [{ tasks }, { deals }] = await Promise.all([GET("/api/tasks"), GET("/api/deals")]);
  const now = new Date();
  const today = toISODate(now);
  const plus7 = toISODate(new Date(now.getTime() + 7 * 86400000));
  const h = now.getHours();
  const greet = h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999");

  const open = tasks.filter((t) => !t.done);
  const overdue = open.filter((t) => t.due_date && t.due_date < today).sort(byDue);
  const todayTasks = open.filter((t) => !t.due_date || t.due_date === today).sort(byDue);
  const upcoming = open.filter((t) => t.due_date > today && t.due_date <= plus7).sort(byDue);
  const closing = deals
    .filter((d) => !["closed_won", "closed_lost"].includes(d.stage) && d.expected_close >= today && d.expected_close <= plus7)
    .sort((a, b) => a.expected_close.localeCompare(b.expected_close));
  const needYou = overdue.length + todayTasks.length;

  const section = (title, rows, emptyMsg) => `
    <div class="panel"><h2>${title} <span class="count">${rows.length}</span></h2>
      ${rows.length ? rows.map(taskRow).join("") : `<div class="empty">${emptyMsg}</div>`}
    </div>`;

  view.innerHTML = `
    <div class="feed-head">
      <div>
        <div class="feed-greet">${greet}</div>
        <div class="feed-sub">${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} ·
          ${needYou ? `<b>${needYou}</b> thing${needYou === 1 ? "" : "s"} need${needYou === 1 ? "s" : ""} you today` : "nothing due — clear runway"}</div>
      </div>
      <div class="feed-add">
        <input id="qa-title" placeholder="Quick add a task for today…" autocomplete="off">
        <button class="btn" id="qa-add">Add</button>
      </div>
    </div>
    <div class="cols2">
      <div>
        ${section("Overdue", overdue, "Nothing overdue. Nice.")}
        ${section("Today", todayTasks, "Nothing due today.")}
        ${section("Coming up", upcoming, "Nothing on the horizon.")}
      </div>
      <div class="panel"><h2>Closing this week <span class="count">${closing.length}</span></h2>
        ${closing.length ? closing.map((d) => `
          <div class="activity"><div class="dot" style="background:${stageColor(d.stage)}"></div>
            <div class="text"><b>${esc(d.title)}</b> · ${esc(d.company_name || "")}<br>
            <span style="color:var(--text-3);font-size:12.5px">${money(d.value)} · ${d.probability}% · closes ${esc(d.expected_close)}</span></div>
          </div>`).join("") : `<div class="empty">No deals closing in the next 7 days.</div>`}
      </div>
    </div>`;
  wireTaskRows(tasks, deals);

  const add = async () => {
    const title = $("#qa-title").value.trim();
    if (!title) return;
    await POST("/api/tasks", { title, due_date: today, owner: "You" });
    route();
  };
  $("#qa-add").onclick = add;
  $("#qa-title").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
}

/* ---------- captures: business cards & client notes ---------- */
async function vCaptures() {
  const [{ captures }, { contacts }] = await Promise.all([GET("/api/captures"), GET("/api/contacts")]);
  view.innerHTML = `
    <div class="toolbar">
      <span style="color:var(--text-2)">${captures.length} captured</span>
      <div class="spacer"></div>
      <label class="btn" for="cap-files" style="cursor:pointer">📷 Take photo / Upload</label>
      <input type="file" id="cap-files" accept="image/*" capture="environment" multiple hidden>
    </div>
    <div id="cap-status"></div>
    <div class="caps-grid">
      ${captures.map((c) => `
        <div class="cap-card">
          <a href="/uploads/${esc(c.filename)}" target="_blank" rel="noopener"><img src="/uploads/${esc(c.filename)}" alt="${esc(c.original_name || "capture")}" loading="lazy"></a>
          <div class="cap-body">
            <div class="cap-note">${c.note ? esc(c.note) : `<span style="color:var(--text-3)">No note yet</span>`}</div>
            <div class="cap-meta">${c.contact_name ? "👤 " + esc(c.contact_name) : "Not linked"} · ${esc((c.created_at || "").slice(0, 16).replace("T", " "))}</div>
            <div class="cap-actions">
              <button class="btn ghost small" data-cap-edit="${c.id}">Edit</button>
              <button class="btn danger small" data-cap-del="${c.id}">Delete</button>
            </div>
          </div>
        </div>`).join("") || `<div class="empty">No captures yet — snap a business card or a page of client notes.</div>`}
    </div>`;

  $("#cap-files").onchange = async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append("photos", f));
    $("#cap-status").innerHTML = `<div class="empty">Uploading ${files.length} photo${files.length === 1 ? "" : "s"}…</div>`;
    try {
      const res = await fetch(wsParam("/api/captures"), { method: "POST", body: fd });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || "upload failed");
      if (r.errors && r.errors.length) alert("Some files were skipped:\n" + r.errors.join("\n"));
      route();
    } catch (err) {
      $("#cap-status").innerHTML = `<div class="empty">Upload failed: ${esc(err.message)}</div>`;
    }
  };
  document.querySelectorAll("[data-cap-edit]").forEach((b) => {
    b.onclick = () => {
      const c = captures.find((x) => x.id === Number(b.dataset.capEdit));
      if (c) editCaptureModal(c, contacts);
    };
  });
  document.querySelectorAll("[data-cap-del]").forEach((b) => {
    b.onclick = async () => {
      if (confirm("Delete this capture?")) { await DEL(`/api/captures/${b.dataset.capDel}`); route(); }
    };
  });
}

function editCaptureModal(c, contacts) {
  openModal("Edit capture", `
    <div class="cap-edit-img"><img src="/uploads/${esc(c.filename)}" alt=""></div>
    ${field("Note", `<textarea name="note" rows="3">${esc(c.note || "")}</textarea>`)}
    ${field("Link to contact", select("contact_id", [["", "—"]].concat(contacts.map((x) => [x.id, x.name + (x.company_name ? " · " + x.company_name : "")])), c.contact_id || ""))}`,
    async (d) => { await PATCH(`/api/captures/${c.id}`, d); route(); }, "Save");
}

async function editTaskModal(t, deals) {
  const fields = await getSchemaFields("task");
  openModal("Edit task", `
    ${field("Title", input("title", t.title))}
    <div class="formgrid">
      ${field("Related deal", select("deal_id", [["", "—"]].concat(deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage)).map((d) => [d.id, d.title])), t.deal_id || ""))}
      ${field("Due date", input("due_date", t.due_date || "", "date"))}
    </div>
    ${field("Owner", input("owner", t.owner))}
    ${cfFieldsHtml(fields, t.custom)}`,
    async (d) => { await PATCH(`/api/tasks/${t.id}`, d); route(); }, "Save changes");
}

function webhookFormHtml(w, events) {
  let ev = [];
  try { ev = JSON.parse(w.events || "[]"); } catch {}
  return `
      ${field("Name", input("name", w.name || "Zapier catch hook"))}
      ${field("URL", input("url", w.url || "https://", "url"))}
      <div class="field"><label>Events (none checked = all)</label>
        <div style="display:flex;gap:12px;flex-wrap:wrap">
          ${events.map((e) => `<label style="font-weight:400"><input type="checkbox" name="events" value="${e}" style="width:auto" ${ev.includes(e) ? "checked" : ""}> ${e}</label>`).join("")}
        </div></div>
      ${headersEditorHtml(w.headers || [])}`;
}

async function vAutomations() {
  const { webhooks, events } = await GET("/api/webhooks");
  const { deliveries } = await GET("/api/deliveries");
  const { hooks } = await GET(showAllHooks ? "/api/hooks?all=1" : "/api/hooks");
  const base = location.origin;
  view.innerHTML = `
    <div class="panel">
      <h2>Outgoing webhooks <span style="color:var(--text-3);font-weight:400;font-size:13px">— CRM → Zapier / Make / n8n</span></h2>
      <p style="color:var(--text-2);margin-top:-6px">POSTs JSON on deal, contact, campaign, and task events. Point it at a Zapier Catch Hook, Make webhook, or n8n Webhook node.</p>
      <div id="wh-list">
        ${webhooks.map((w) => {
          let ev = [];
          try { ev = JSON.parse(w.events); } catch {}
          return `<div class="hook">
            <div class="info"><div class="name">${esc(w.name)} ${w.active ? "" : '<span class="tag">paused</span>'}</div>
              <div class="url">${esc(w.url)}</div>
              <div class="events">${(ev.length ? ev : ["all"]).map((e) => `<span class="tag">${esc(e)}</span>`).join("")}${(w.headers || []).length ? ` <span class="tag" title="${esc(w.headers.join(", "))}">${w.headers.length} header${w.headers.length > 1 ? "s" : ""}</span>` : ""}</div></div>
            <button class="btn ghost small" data-edit="${w.id}">Edit</button>
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
      <p style="color:var(--text-2);margin-top:-6px">POST JSON to the hook URL from any automation platform. Each hook belongs to one workspace, and records land there automatically — no workspace juggling on the platform side. Body: <span class="tag">{"action": "create_deal" | "create_contact" | "create_task", "data": {...}}</span></p>
      <div class="toolbar" style="margin-bottom:10px">
        <label style="font-weight:400;font-size:13px"><input type="checkbox" id="hooks-all" style="width:auto" ${showAllHooks ? "checked" : ""}> Show hooks from all workspaces</label>
      </div>
      ${hooks.map((h) => `
        <div class="hook"><div class="info"><div class="name">${esc(h.name)}
            <span class="tag"><span class="ws-dot" style="background:${esc(h.workspace_color || "#999")}"></span>${esc(h.workspace_name || "—")}</span></div>
          <div class="url">${esc(base)}/api/hooks/in/${esc(h.key)}</div></div>
          <select data-hws="${h.id}" title="Move hook to another workspace">${workspaces.map((x) => `<option value="${x.id}" ${x.id === h.workspace_id ? "selected" : ""}>→ ${esc(x.name)}</option>`).join("")}</select>
          <button class="btn ghost small" data-copy="${esc(base)}/api/hooks/in/${esc(h.key)}">Copy URL</button>
          <button class="btn danger small" data-hdel="${h.id}">Delete</button></div>`).join("") || `<div class="empty">No incoming hooks yet${showAllHooks ? "" : " in this workspace"}.</div>`}
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

  $("#add-wh").onclick = () => {
    openModal("Add outgoing webhook", webhookFormHtml({ headers: [] }, events),
      async (d) => {
        d.headers = collectHeaders($("#modal-root"));
        await POST("/api/webhooks", d); route();
      }, "Add webhook");
    bindHeadersEditor($("#modal-root"));
  };

  document.querySelectorAll("[data-edit]").forEach((b) =>
    (b.onclick = () => {
      const w = webhooks.find((x) => String(x.id) === b.dataset.edit) || { headers: [] };
      openModal("Edit outgoing webhook", webhookFormHtml(w, events),
        async (d) => {
          d.headers = collectHeaders($("#modal-root"));
          if (d.events === undefined) d.events = []; // none checked = all
          await PATCH(`/api/webhooks/${w.id}`, d); route();
        }, "Save changes");
      bindHeadersEditor($("#modal-root"));
    }));
  document.querySelectorAll("[data-test]").forEach((b) =>
    (b.onclick = async () => { const r = await POST(`/api/webhooks/${b.dataset.test}/test`); alert(`Test ${r.status} (HTTP ${r.response_code || "—"})`); route(); }));
  document.querySelectorAll("[data-del]").forEach((b) =>
    (b.onclick = async () => { if (confirm("Delete this webhook?")) { await DEL(`/api/webhooks/${b.dataset.del}`); route(); } }));
  document.querySelectorAll("[data-copy]").forEach((b) =>
    (b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied!"; }));
  document.querySelectorAll("[data-hdel]").forEach((b) =>
    (b.onclick = async () => { if (confirm("Delete this hook?")) { await DEL(`/api/hooks/${b.dataset.hdel}`); route(); } }));
  document.querySelectorAll("[data-hws]").forEach((s) =>
    (s.onchange = async () => { await PATCH(`/api/hooks/${s.dataset.hws}`, { workspace_id: Number(s.value) }); route(); }));
  $("#hooks-all").onchange = (e) => { showAllHooks = e.target.checked; route(); };
  $("#add-hook").onclick = () => {
    const w = workspaces.find((x) => x.id === wsId);
    openModal("New incoming hook",
      `<p style="color:var(--text-2);font-size:13px;margin:0 0 8px">Creates in <span class="tag"><span class="ws-dot" style="background:${esc((w && w.color) || "#999")}"></span>${esc((w && w.name) || "—")}</span> — switch workspaces in the topbar to change it.</p>` +
      field("Name", input("name", "n8n deal intake")),
      async (d) => { const r = await POST("/api/hooks", d); alert("Hook URL:\n" + location.origin + "/api/hooks/in/" + r.hook.key); route(); }, "Create hook");
  };

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

/* ---------- schema editor: custom fields per entity ---------- */
const SCHEMA_ENTITIES = [
  ["contact", "Contacts"], ["company", "Companies"],
  ["campaign", "Campaigns"], ["task", "Tasks"],
];
let schemaEntity = "contact";

async function vSchema() {
  const { fields } = await GET(`/api/schema/${schemaEntity}`);
  const entLabel = SCHEMA_ENTITIES.find(([e]) => e === schemaEntity)[1];
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="schema-seg">
        ${SCHEMA_ENTITIES.map(([e, l]) => `<button data-ent="${e}" class="${e === schemaEntity ? "on" : ""}">${l}</button>`).join("")}
      </div>
      <div class="spacer"></div>
      <button class="btn" id="new-field">+ New field</button>
    </div>
    <div class="panel">
      <h2>${entLabel} — custom fields <span class="count">${fields.length}</span></h2>
      <p style="color:var(--text-2);margin-top:-8px">These fields appear on every ${entLabel.toLowerCase().slice(0, -1)} form. Built-in fields can't be edited here.</p>
      ${fields.map((f, i) => {
        let opts = [];
        try { opts = JSON.parse(f.options || "[]"); } catch {}
        return `<div class="schema-field">
          <div class="info">
            <div class="name">${esc(f.label)} ${f.required ? `<span class="pill" style="background:#e5484d22;color:#e5484d">required</span>` : ""}</div>
            <div class="url">${esc(f.name)} · ${FIELD_TYPES.find(([t]) => t === f.type)?.[1] || f.type}${opts.length ? ` · ${esc(opts.join(", "))}` : ""}</div>
          </div>
          <div class="schema-actions">
            <button class="btn ghost small" data-move="-1" data-id="${f.id}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn ghost small" data-move="1" data-id="${f.id}" ${i === fields.length - 1 ? "disabled" : ""}>↓</button>
            <button class="btn ghost small" data-edit="${f.id}">Edit</button>
            <button class="btn danger small" data-del="${f.id}">Delete</button>
          </div>
        </div>`;
      }).join("") || `<div class="empty">No custom fields yet — add one to start tracking what matters.</div>`}
    </div>`;
  document.querySelectorAll("#schema-seg button").forEach((b) => {
    b.onclick = () => { schemaEntity = b.dataset.ent; route(); };
  });
  document.querySelectorAll("[data-move]").forEach((b) => {
    b.onclick = async () => {
      const i = fields.findIndex((f) => f.id === Number(b.dataset.id));
      const j = i + Number(b.dataset.move);
      if (j < 0 || j >= fields.length) return;
      await PATCH(`/api/schema/fields/${fields[i].id}`, { position: fields[j].position });
      await PATCH(`/api/schema/fields/${fields[j].id}`, { position: fields[i].position });
      route();
    };
  });
  document.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => {
      const f = fields.find((x) => x.id === Number(b.dataset.edit));
      if (f) fieldModal(f);
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const f = fields.find((x) => x.id === Number(b.dataset.del));
      if (f && confirm(`Delete the "${f.label}" field and all its values?`)) {
        await DEL(`/api/schema/fields/${f.id}`);
        route();
      }
    };
  });
  $("#new-field").onclick = () => fieldModal(null);
}

function fieldModal(f) {
  const isNew = !f;
  const typeOpts = FIELD_TYPES.map(([t, l]) => [t, l]);
  let opts = [];
  try { opts = JSON.parse((f && f.options) || "[]"); } catch {}
  openModal(isNew ? "New custom field" : "Edit field", `
    ${field("Label", input("label", f ? f.label : "", "text", "required"))}
    <div class="formgrid">
      ${field("Type", select("type", typeOpts, f ? f.type : "text"))}
      ${field("Required", `<input type="checkbox" name="required" value="1" ${f && f.required ? "checked" : ""} style="width:18px;height:18px;margin-top:4px">`)}
    </div>
    <div id="cf-opts">${field("Dropdown options (comma-separated)", input("options", opts.join(", ")))}</div>
    ${isNew ? `<p style="color:var(--text-3);font-size:12.5px">The field key is generated from the label (e.g. "Customer tier" → customer_tier).</p>` : ""}`,
    async (d) => {
      const payload = {
        label: d.label,
        type: d.type,
        options: d.options || "",
        required: !!(d.required && d.required.length),
      };
      if (isNew) {
        const r = await POST(`/api/schema/${schemaEntity}`, payload);
        if (r.error) throw new Error(r.error);
      } else {
        await PATCH(`/api/schema/fields/${f.id}`, payload);
      }
      route();
    }, isNew ? "Add field" : "Save");
  const syncOpts = () => {
    $("#cf-opts").style.display = $('[name="type"]').value === "select" ? "" : "none";
  };
  $('[name="type"]').onchange = syncOpts;
  syncOpts();
}

/* ---------- command palette (⌘K quick find) ---------- */
function initPalette() {
  const root = $("#palette-root");
  let items = [];
  let sel = 0;
  let cache = null;
  let cacheWs = null;
  // called when the workspace changes so Cmd+K re-indexes
  paletteBust = () => { cache = null; };

  async function buildItems() {
    if (cache && cacheWs === wsId) return cache;
    const NAV = [
      ["Dashboard", "#/dashboard"], ["Daily Feed", "#/feed"],
      ["Calendar", "#/calendar"], ["Campaigns", "#/campaigns"],
      ["Captures", "#/captures"], ["Automations", "#/automations"],
      ["Schema", "#/schema"],
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
        run: () => { location.hash = d.campaign_id ? `#/campaigns/${d.campaign_id}` : "#/campaigns"; },
      }));
      contacts.forEach((c) => out.push({
        group: "Contacts", kind: "person",
        label: c.name, sub: c.company_name || c.title || "",
        run: () => { location.hash = c.campaign_id ? `#/campaigns/${c.campaign_id}` : `#/contacts?q=${encodeURIComponent(c.name)}`; },
      }));
      companies.forEach((c) => out.push({
        group: "Companies", kind: "org",
        label: c.name, sub: c.industry || "",
        run: () => { location.hash = c.campaign_id ? `#/campaigns/${c.campaign_id}` : "#/companies"; },
      }));
    } catch {}
    cache = out;
    cacheWs = wsId;
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
  const parts = (hash.replace("#/", "") || "dashboard").split("/");
  const r = parts[0];
  const name = TITLES[r] ? r : "dashboard";
  document.querySelectorAll("#nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.r === name));
  view.innerHTML = `<div class="skel" style="height:34px;max-width:300px;margin-bottom:18px"></div>
    <div class="skel" style="height:120px;margin-bottom:16px"></div>
    <div class="skel" style="height:220px"></div>`;
  try {
    if (name === "campaigns" && parts[1]) {
      $("#page-title").textContent = "Campaign";
      await vCampaignDetail(Number(parts[1]));
    } else {
      $("#page-title").textContent = TITLES[name];
      await { dashboard: vDashboard, feed: vFeed, calendar: vCalendar, contacts: vContacts,
        companies: vCompanies, campaigns: vCampaigns, captures: vCaptures,
        automations: vAutomations, schema: vSchema }[name]();
    }
  } catch (e) {
    view.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`;
  }
}

(async () => {
  await loadMeta();
  await initWorkspaces();
  initPalette();
  window.addEventListener("hashchange", route);
  if (!location.hash) location.hash = "#/dashboard";
  route();
})();
