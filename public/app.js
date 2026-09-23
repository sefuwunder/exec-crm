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
  dashboard: "Dashboard", milton: "Milton", outreach: "Outreach",
  feed: "Daily Feed", contacts: "Contacts",
  companies: "Companies", campaigns: "Campaigns", workshop: "Data Workshop",
};
// Old top-level sections now live inside the Data Workshop tabs.
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
let campTab = "overview"; // campaigns window tab: "overview" | "board"
let campBoardFilter = "all"; // campaign filter on the campaigns board: "all" | campaign id

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
  // Dashboard is Milton insights only: the Review → Action → Outcome cycle
  // compass. KPIs, stage bars and activity lists used to live here; they are
  // gone — Milton's playbook already watches the pipeline and says what
  // needs attention, grouped by phase.
  const PHASES = ["review", "action", "outcome"];
  const PHASE_LABEL = { review: "Review", action: "Action", outcome: "Outcome" };
  const PHASE_HINT = {
    review: "prep, research & strategy",
    action: "the touch — log it in Outreach",
    outcome: "what came back",
  };
  const PHASE_COLOR = { review: "#4c8dff", action: "#f5b83d", outcome: "#22c07a" };
  let filter = "all";
  let data = null;
  let err = "";
  try {
    data = await GET("/api/milton/hygiene");
    if (data && data.error) { err = data.error; data = null; }
  } catch (e) { err = e.message || "milton unreachable"; }

  const render = () => {
    if (!data) {
      view.innerHTML = `<div class="panel"><h2>Milton insights</h2>
        <div class="empty">${esc(err || "Milton didn't return insights.")}<br><br>
        The Dashboard shows only Milton's playbook insights now. Start Milton
        (default <code>http://127.0.0.1:3009</code>) and reload — or set
        <code>MILTON_URL</code> on exec-crm if Milton runs on another host.</div></div>`;
      return;
    }
    const items = data.items.filter((i) => filter === "all" || i.phase === filter);
    const groups = PHASES
      .map((ph) => ({ ph, items: items.filter((i) => i.phase === ph) }))
      .filter((g) => g.items.length);
    view.innerHTML = `
      <div class="cycle-strip" role="group" aria-label="Review, Action, Outcome">
        ${PHASES.map((ph, idx) => `
          <button class="cycle-step ${filter === ph ? "sel" : ""}" data-phase="${ph}">
            <span class="cycle-dot" style="background:${PHASE_COLOR[ph]}"></span>
            <span class="cycle-name">${PHASE_LABEL[ph]}</span>
            <span class="cycle-count">${data.counts[ph] || 0}</span>
            <span class="cycle-hint">${PHASE_HINT[ph]}</span>
          </button>${idx < 2 ? `<span class="cycle-arrow">→</span>` : ""}`).join("")}
      </div>
      <p class="dash-lead">${esc(data.lead)}</p>
      ${groups.length ? groups.map((g) => `
        <div class="panel"><h2><span class="cycle-dot sm" style="background:${PHASE_COLOR[g.ph]}"></span>
          ${PHASE_LABEL[g.ph]} <span class="count">${g.items.length}</span></h2>
          ${g.items.map((i) => `
            <div class="finding"><span class="f-icon">${esc(i.icon)}</span>
              <div class="text">${esc(i.text)}${i.fix ? `<div class="fix">${esc(i.fix)}</div>` : ""}</div>
            </div>`).join("")}
        </div>`).join("") : `<div class="panel"><div class="empty">${esc(data.lead)}</div></div>`}
      <p class="dash-foot">Insights by Milton's playbook ·
        <a href="#/milton">ask Milton</a> · <a href="#/outreach">log outreach</a></p>`;
    view.querySelectorAll(".cycle-step").forEach((b) => {
      b.onclick = () => { filter = filter === b.dataset.phase ? "all" : b.dataset.phase; render(); };
    });
  };
  render();
}

/* ---------- outreach: every channel, one log (the Action phase) ---------- */
let outreachFilter = "all";
const OUTREACH_ICONS = { call: "📞", email: "✉️", social: "💬", video: "🎥", in_person: "🤝" };

async function vOutreach() {
  const [{ outreach, channels }, { deals }, { contacts }] = await Promise.all([
    GET("/api/outreach"), GET("/api/deals"), GET("/api/contacts"),
  ]);
  const labelOf = Object.fromEntries(channels.map((c) => [c.value, c.label]));
  const openDeals = deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage));
  const rows = outreach.filter((o) => outreachFilter === "all" || o.channel === outreachFilter);
  const today = new Date().toISOString().slice(0, 10);

  view.innerHTML = `
    <div class="outreach-head">
      <div class="outreach-sub">Every touch, every channel — the <b>Action</b> log of your
        Review &rarr; Action &rarr; Outcome cycle.</div>
      <div class="spacer"></div>
      <button class="btn" id="or-log">＋ Log outreach</button>
    </div>
    <div class="chip-row" role="group" aria-label="Filter by channel">
      <button class="chip ${outreachFilter === "all" ? "sel" : ""}" data-ch="all">All</button>
      ${channels.map((c) => `<button class="chip ${outreachFilter === c.value ? "sel" : ""}" data-ch="${c.value}">${OUTREACH_ICONS[c.value] || ""} ${esc(c.label)}</button>`).join("")}
    </div>
    <div class="panel"><h2>Outreach <span class="count">${rows.length}</span></h2>
      ${rows.length ? rows.map((o) => `
        <div class="orow">
          <div class="orow-icon" title="${esc(labelOf[o.channel] || o.channel)}">${OUTREACH_ICONS[o.channel] || "•"}</div>
          <div class="orow-body">
            <div class="orow-top"><b>${esc(labelOf[o.channel] || o.channel)}</b>
              ${o.deal_title ? `<span class="orow-deal">${esc(o.deal_title)}</span>` : ""}
              ${o.contact_name ? `<span class="orow-contact">· ${esc(o.contact_name)}</span>` : ""}
              <span class="orow-date">${esc((o.happened_at || o.created_at || "").slice(0, 10))}</span></div>
            ${o.note ? `<div class="orow-note">${esc(o.note)}</div>` : ""}
            ${o.outcome
              ? `<div class="orow-outcome"><span class="oc-label">Outcome</span> ${esc(o.outcome)}</div>`
              : `<button class="linklike" data-or-outcome="${o.id}">＋ log the outcome</button>`}
          </div>
          <button class="btn ghost small" data-or-del="${o.id}" title="Delete">Delete</button>
        </div>`).join("")
        : `<div class="empty">No outreach logged yet — calls, emails, social messages, video calls and in-person touches all live here.</div>`}
    </div>`;

  view.querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => { outreachFilter = b.dataset.ch; route(); };
  });
  $("#or-log").onclick = () => outreachModal(null, channels, openDeals, contacts, today);
  view.querySelectorAll("[data-or-del]").forEach((b) => {
    b.onclick = async () => {
      if (confirm("Delete this outreach entry?")) { await DEL(`/api/outreach/${b.dataset.orDel}`); route(); }
    };
  });
  view.querySelectorAll("[data-or-outcome]").forEach((b) => {
    b.onclick = () => {
      const o = outreach.find((x) => x.id === Number(b.dataset.orOutcome));
      openModal("Log outcome", `
        <p style="color:var(--text-3);font-size:12.5px;margin-top:0">
          What came back from the ${esc((labelOf[o.channel] || o.channel).toLowerCase())}${o.deal_title ? ` on <b>${esc(o.deal_title)}</b>` : ""}?
          This is the <b>Outcome</b> phase — voicemail, bounced, meeting booked, not interested…</p>
        ${field("Outcome", input("outcome", o.outcome || ""))}`,
        async (d) => { await PATCH(`/api/outreach/${o.id}`, { outcome: d.outcome }); route(); },
        "Save outcome");
    };
  });
}

function outreachModal(o, channels, deals, contacts, today) {
  const isNew = !o;
  openModal(isNew ? "Log outreach" : "Edit outreach", `
    <div class="formgrid">
      ${field("Channel", select("channel", channels.map((c) => [c.value, c.label]), o ? o.channel : "call"))}
      ${field("Date", input("happened_at", o ? (o.happened_at || today) : today, "date"))}
    </div>
    <div class="formgrid">
      ${field("Deal", select("deal_id", [["", "—"]].concat(deals.map((d) => [d.id, d.title])), o ? (o.deal_id || "") : ""))}
      ${field("Contact", select("contact_id", [["", "—"]].concat(contacts.map((c) => [c.id, c.name])), o ? (o.contact_id || "") : ""))}
    </div>
    ${field("Note", `<textarea name="note" rows="3" placeholder="What was said, sent, or shown…">${esc(o ? (o.note || "") : "")}</textarea>`)}
    ${field("Outcome (optional — the Outcome phase)", input("outcome", o ? (o.outcome || "") : "", "text"))}`,
    async (d) => {
      const payload = {
        channel: d.channel,
        happened_at: d.happened_at || "",
        deal_id: d.deal_id || null,
        contact_id: d.contact_id || null,
        note: d.note || "",
        outcome: d.outcome || "",
      };
      if (isNew) await POST("/api/outreach", payload);
      else await PATCH(`/api/outreach/${o.id}`, payload);
      route();
    }, isNew ? "Log it" : "Save changes");
}

/* ---------- milton: the agent, embedded ---------- */
/* ---------- milton page: embedded agent --------------------------------------
   Same-origin chat shell: the browser only talks to /api/milton/* on this
   origin; exec-crm proxies to Milton server-side, so MILTON_URL never leaks
   and no cross-origin iframe is needed. One Milton session per workspace,
   remembered in localStorage; the server re-validates the session against
   the active workspace on every call. */
const miltonSessKey = () => `exec-crm-milton-session-${wsId}`;
const miltonGetSession = () => localStorage.getItem(miltonSessKey()) || "";
const miltonSetSession = (sid) =>
  (sid ? localStorage.setItem(miltonSessKey(), sid) : localStorage.removeItem(miltonSessKey()));

const miltonTextHtml = (t) => esc(t).replace(/\n/g, "<br>");

function miltonCardHtml(c) {
  let h = `<div class="mcard">`;
  if (c.title) h += `<div class="mcard-title">${esc(c.title)}</div>`;
  for (const s of c.stats || [])
    h += `<div class="mstat"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`;
  for (const o of c.options || [])
    h += `<button class="mopt" data-send="${o.n}"><b>${o.n}.</b> ${esc(o.label)}${o.sub ? ` <span class="sub">${esc(o.sub)}</span>` : ""}</button>`;
  for (const it of c.items || []) {
    const label = it.title || it.name || it.label || it.text || "";
    const sub = it.stage || it.value != null ? ` <span class="sub">${esc(it.stage || "")}${it.value != null ? " · " + money(it.value) : ""}</span>` : "";
    if (label) h += `<div class="mitem">• ${esc(String(label))}${sub}</div>`;
  }
  for (const r of c.rows || [])
    h += `<div class="mitem">• ${esc(Array.isArray(r) ? r.join(" · ") : String(r))}</div>`;
  if (c.ocrText) h += `<pre class="mocr">${esc(c.ocrText)}</pre>`;
  return h + `</div>`;
}

async function vMilton() {
  let st = { reachable: false };
  try { st = await GET("/api/milton/status"); } catch { /* unreachable */ }
  if (!st.reachable) {
    view.innerHTML = `<div class="panel"><h2>Milton</h2>
      <div class="empty">Milton isn't running.<br><br>
      Start it with <code>bun src/server.ts</code> in the milton project (default port 3009),
      then reload this page. If Milton lives on another host, set
      <code>MILTON_URL</code> on exec-crm.</div></div>`;
    return;
  }
  view.innerHTML = `
    <div class="milton-wrap">
      <div class="milton-head">
        <h2>Milton</h2>
        <span class="milton-status"><span class="dot-ok"></span>listening</span>
        <span class="flex-sp"></span>
        <button class="btn ghost sm" id="milton-new">New conversation</button>
      </div>
      <div class="milton-msgs" id="milton-msgs" aria-live="polite"></div>
      <div class="milton-chips" id="milton-chips"></div>
      <form class="milton-input" id="milton-form">
        <input id="milton-text" placeholder="Ask Milton — try “morning brief” or “pipeline hygiene”" autocomplete="off">
        <button class="btn" type="submit">Send</button>
      </form>
    </div>`;
  const msgs = $("#milton-msgs"), chipsEl = $("#milton-chips"),
    form = $("#milton-form"), input = $("#milton-text");
  let thread = []; // {role: "user"|"milton", html}
  const paint = () => {
    msgs.innerHTML = thread.map((m) =>
      `<div class="msg ${m.role}"><div class="bubble">${m.html}</div></div>`).join("");
    msgs.scrollTop = msgs.scrollHeight;
  };
  const paintChips = (chips) => {
    chipsEl.innerHTML = (chips || []).map((c) =>
      `<button class="chip" data-send="${esc(c)}">${esc(c)}</button>`).join("");
  };
  const push = (role, html) => { thread.push({ role, html }); paint(); };
  const send = async (text) => {
    text = String(text || "").trim();
    if (!text || form.dataset.busy) return;
    form.dataset.busy = "1";
    input.value = "";
    paintChips([]);
    push("user", miltonTextHtml(text));
    push("milton", `<span class="thinking">…</span>`);
    try {
      const rep = await POST("/api/milton/chat",
        { message: text, session: miltonGetSession() || undefined });
      if (rep.session) miltonSetSession(rep.session);
      else if (rep.activeSession) miltonSetSession(rep.activeSession.id);
      let html = miltonTextHtml(rep.text || "(no reply)");
      for (const c of rep.cards || []) html += miltonCardHtml(c);
      thread[thread.length - 1] = { role: "milton", html };
      paint();
      paintChips(rep.chips);
    } catch (e) {
      thread[thread.length - 1] =
        { role: "milton", html: `<span class="merror">${esc(e.message || "send failed")}</span>` };
      paint();
    }
    delete form.dataset.busy;
    input.focus();
  };
  chipsEl.onclick = (e) => {
    const b = e.target.closest("[data-send]");
    if (b) send(b.dataset.send);
  };
  msgs.onclick = (e) => {
    const b = e.target.closest("[data-send]");
    if (b) send(b.dataset.send);
  };
  form.onsubmit = (e) => { e.preventDefault(); send(input.value); };
  $("#milton-new").onclick = () => {
    miltonSetSession("");
    thread = [{
      role: "milton",
      html: miltonTextHtml("Fresh thread. I'm scoped to this workspace — ask me anything."),
    }];
    paint(); paintChips([]); input.focus();
  };
  // load history for the remembered session, else greet
  const sid = miltonGetSession();
  if (sid) {
    try {
      const h = await GET(`/api/milton/history?session=${encodeURIComponent(sid)}`);
      if (h.session) miltonSetSession(h.session);
      thread = (h.messages || []).map((m) => ({
        role: m.role === "user" ? "user" : "milton", html: miltonTextHtml(m.text || ""),
      }));
    } catch { miltonSetSession(""); }
  }
  if (!thread.length) {
    thread = [{
      role: "milton",
      html: miltonTextHtml(
        "Hi — I'm Milton, your pipeline agent for this workspace.\nAsk for the morning brief or pipeline hygiene, or tell me what happened: “log outcome” after a call keeps the Review → Action → Outcome cycle honest."),
    }];
  }
  paint();
  input.focus();
}

/* Pipeline board markup — extracted verbatim from the old standalone vPipeline
   and rewired into the campaigns overview. Stage columns in workspace stage
   order (closed stages last); each deal card carries its campaign badge so the
   board reads as the cross-campaign pipeline. Drag & drop still runs through
   initDealDrag + PATCH /api/deals/:id. */
function pipelineBoardHtml(deals, campById) {
  const closedStages = ["closed_won", "closed_lost"];
  return `<div class="board" id="board">
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
            ${campById.get(d.campaign_id) ? `<div class="crow"><span class="camp-badge">${esc(campById.get(d.campaign_id))}</span></div>` : ``}
            <div class="co">${esc(d.company_name || "—")}${d.contact_name ? " · " + esc(d.contact_name) : ""}</div>
            <div class="row"><div class="val">${money(d.value)}</div><div class="prob">${d.probability}%</div></div>
          </div>`).join("")}
      </div>`;
    }).join("")}
  </div>`;
}

/* Client-side campaign filter for the campaigns board (pure, for testing). */
function filterDealsByCampaign(deals, filter) {
  if (filter === "all") return deals || [];
  return (deals || []).filter((d) => String(d.campaign_id) === String(filter));
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
    </div>`,
    async (data) => {
      if (data.company_id === "") data.company_id = null;
      if (data.contact_id === "") data.contact_id = null;
      if (data.campaign_id === "") data.campaign_id = null;
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
  const campById = new Map((campaigns || []).map((c) => [c.id, c.name]));
  const boardDeals = filterDealsByCampaign(deals, campBoardFilter);
  const boardValue = boardDeals.reduce((a, d) => a + (Number(d.value) || 0), 0);
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg">
        <button data-ct="overview" class="${campTab === "overview" ? "on" : ""}">Overview</button>
        <button data-ct="board" class="${campTab === "board" ? "on" : ""}">Pipeline</button>
      </div>
      <div class="spacer"></div>
      ${campTab === "board" ? `
        <select id="board-filter" title="Filter board by campaign">
          <option value="all"${campBoardFilter === "all" ? " selected" : ""}>All campaigns</option>
          ${(campaigns || []).map((c) => `<option value="${c.id}"${String(campBoardFilter) === String(c.id) ? " selected" : ""}>${esc(c.name)}</option>`).join("")}
        </select>
        <span style="color:var(--text-2);font-size:12.5px;white-space:nowrap">${boardDeals.length} deals · <b>${moneyShort(boardValue)}</b></span>` : ``}
      <button class="btn" id="new-campaign">+ New campaign</button></div>
    ${campTab === "overview" ? `
    <div class="panel"><table>
      <tr><th>Campaign</th><th>Company</th><th>Status</th><th>Start</th><th>End</th><th>Budget</th><th>Pipeline</th></tr>
      ${campaigns.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td>
        <td>${esc(c.company_name) || "—"}</td>
        <td>${statusPill(c.status)}</td><td>${esc(c.start_date) || "—"}</td><td>${esc(c.end_date) || "—"}</td>
        <td><b>${money(c.budget)}</b></td>
        <td>${campaignPipelineStrip(dealsByCamp.get(c.id) || [])}</td></tr>`).join("")}
    </table>${campaigns.length ? "" : `<div class="empty">No campaigns yet — launch your first one.</div>`}</div>` : `
    <div class="panel" style="padding:14px">
      ${pipelineBoardHtml(boardDeals, campById)}
      ${boardDeals.length ? "" : `<div class="empty">No deals${campBoardFilter === "all" ? " yet — add one from a campaign" : " in this campaign"}.</div>`}
    </div>`}`;
  document.querySelectorAll("[data-ct]").forEach((b) =>
    (b.onclick = () => { campTab = b.dataset.ct; route(); }));
  const bf = $("#board-filter");
  if (bf) bf.onchange = () => { campBoardFilter = bf.value; route(); };
  if (campTab === "overview") {
    document.querySelectorAll("#view tr.clickable").forEach((tr) => {
      tr.onclick = () => { location.hash = `#/campaigns/${tr.dataset.id}`; };
    });
  } else {
    initDealDrag(deals || []);
  }
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
/* ---------- data workshop: captures · schema · automation · sandbox in one place ---------- */
const WORKSHOP_TABS = [
  ["captures", "Captures"],
  ["schema", "Schema"],
  ["automation", "Automation"],
  ["sandbox", "Sandbox"],
];
async function vWorkshop(sub) {
  const tab = WORKSHOP_TABS.some(([t]) => t === sub) ? sub : "captures";
  view.innerHTML = `
    <div class="toolbar">
      <div class="seg" id="ws-seg" role="tablist" aria-label="Data workshop">
        ${WORKSHOP_TABS.map(([t, label]) =>
          `<button data-tab="${t}" class="${t === tab ? "on" : ""}" role="tab" aria-selected="${t === tab}">${label}</button>`).join("")}
      </div>
    </div>
    <div id="ws-body"></div>`;
  document.querySelectorAll("#ws-seg button").forEach((b) => {
    b.onclick = () => { location.hash = `#/workshop/${b.dataset.tab}`; };
  });
  const root = $("#ws-body");
  if (tab === "schema") await vSchema(root);
  else if (tab === "automation") await vAutomations(root);
  else if (tab === "sandbox") await vSandbox(root);
  else await vCaptures(root);
}

/* ---------- data sandbox: staged mass contact imports ---------- */
// Nothing lands in the live contacts table until a batch is committed.
let sbOpenBatch = null;

const SB_STATUS_PILL = {
  clean: ["Clean", "var(--ok)"],
  duplicate: ["Duplicate", "var(--urgent)"],
  flagged: ["Flagged", "var(--ctp-yellow)"],
};
const SB_DECISION_PILL = {
  approved: ["Approved", "var(--ok)"],
  rejected: ["Rejected", "var(--ctp-red)"],
  pending: ["Pending", "var(--text-3)"],
};

async function vSandbox(root) {
  const el = root || view;
  if (sbOpenBatch) return vSandboxDetail(el, sbOpenBatch);
  const { batches } = await GET("/api/sandbox/batches");
  el.innerHTML = `
    <div class="toolbar">
      <span style="color:var(--text-2)">${batches.length} import batch${batches.length === 1 ? "" : "es"}</span>
      <div class="spacer"></div>
      <a class="btn ghost small" href="/api/contacts/import/template">CSV template</a>
    </div>
    <div class="sb-drop" id="sb-drop">
      <div><b>Drop a contacts file here</b> or <label class="link" for="sb-file" style="cursor:pointer">choose a file</label></div>
      <div class="sb-hint">CSV or VCF (vCard) — columns: name, email, phone, company, title, notes; extra columns are ignored. Staged rows stay out of your contacts until you approve them.</div>
      <input type="file" id="sb-file" accept=".csv,.vcf,text/csv,text/vcard" hidden>
    </div>
    <div id="sb-status"></div>
    <div class="sb-list">
      ${batches.map((b) => {
        const s = b.summary || {};
        const srcBadge = b.source === "vcf"
          ? `<span class="feed-pill" style="border-color:var(--brand);color:var(--brand)">VCF</span>`
          : `<span class="feed-pill" style="border-color:var(--text-3);color:var(--text-3)">CSV</span>`;
        return `
        <div class="sb-card">
          <div class="info">
            <div class="name">${esc(b.name)} ${srcBadge} ${b.status === "complete" ? `<span class="feed-pill" style="border-color:var(--ok);color:var(--ok)">imported</span>` : `<span class="feed-pill" style="border-color:var(--brand);color:var(--brand)">open</span>`}</div>
            <div class="sb-meta">${b.filename ? esc(b.filename) + " · " : ""}${esc((b.created_at || "").slice(0, 16).replace("T", " "))}</div>
            <div class="sb-counts"><span><b>${s.total || 0}</b> rows</span><span style="color:var(--ok)">${s.clean || 0} clean</span><span style="color:var(--urgent)">${s.duplicates || 0} duplicates</span><span style="color:var(--ctp-yellow)">${s.flagged || 0} flagged</span></div>
          </div>
          <div class="sb-actions">
            <button class="btn small" data-sb-open="${b.id}">Review</button>
            <button class="btn danger small" data-sb-del="${b.id}">Delete</button>
          </div>
        </div>`;
      }).join("") || `<div class="empty">No imports yet — drop a CSV or VCF above to stage your first batch.</div>`}
    </div>`;

  const readAndStage = (file) => {
    if (!file) return;
    const rd = new FileReader();
    rd.onload = async () => {
      $("#sb-status").innerHTML = `<div class="empty">Analyzing ${esc(file.name)}…</div>`;
      try {
        const text = String(rd.result || "");
        const isVcf = /\.vcf$/i.test(file.name) || /^\s*BEGIN:VCARD/im.test(text.slice(0, 500));
        const payload = { name: file.name.replace(/\.(csv|vcf)$/i, ""), filename: file.name };
        if (isVcf) payload.vcf = text; else payload.csv = text;
        const { batch } = await POST("/api/sandbox/batches", payload);
        sbOpenBatch = batch.id;
        route();
      } catch (err) {
        $("#sb-status").innerHTML = `<div class="empty" style="color:var(--ctp-red)">Upload failed: ${esc(err.message)}</div>`;
      }
    };
    rd.readAsText(file);
  };
  $("#sb-file").onchange = (e) => readAndStage(e.target.files[0]);
  const dz = $("#sb-drop");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => readAndStage(e.dataTransfer.files[0]));

  document.querySelectorAll("[data-sb-open]").forEach((b) => {
    b.onclick = () => { sbOpenBatch = Number(b.dataset.sbOpen); route(); };
  });
  document.querySelectorAll("[data-sb-del]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this import batch? Staged rows are discarded; your live contacts are untouched.")) return;
      await DEL(`/api/sandbox/batches/${b.dataset.sbDel}`);
      route();
    };
  });
}

async function vSandboxDetail(el, batchId) {
  const { batch, rows } = await GET(`/api/sandbox/batches/${batchId}`);
  const s = batch.summary || {};
  const open = batch.status === "open";
  const approvable = rows.filter((r) => r.decision === "approved" && r.status !== "duplicate").length;
  el.innerHTML = `
    <div class="toolbar">
      <button class="btn ghost small" id="sb-back">← All imports</button>
      <div class="spacer"></div>
      ${open ? `<button class="btn ghost small" id="sb-bulk-clean">Approve all clean</button>
      <button class="btn ghost small" id="sb-bulk-dup">Reject all duplicates</button>
      <button class="btn small" id="sb-commit" ${approvable ? "" : "disabled"}>Import approved (${approvable})</button>
      <button class="btn danger small" id="sb-del">Delete batch</button>` : ``}
    </div>
    <div class="camp-head">
      <h2 style="margin:0">${esc(batch.name)} ${batch.source === "vcf" ? `<span class="feed-pill" style="border-color:var(--brand);color:var(--brand)">VCF</span>` : `<span class="feed-pill" style="border-color:var(--text-3);color:var(--text-3)">CSV</span>`}</h2>
      <div class="sb-meta">${batch.filename ? esc(batch.filename) + " · " : ""}staged ${esc((batch.created_at || "").slice(0, 16).replace("T", " "))}${batch.status === "complete" ? " · imported " + esc((batch.completed_at || "").slice(0, 16).replace("T", " ")) : ""}</div>
      <div class="sb-summary">
        <span><b>${s.total || 0}</b> rows</span>
        <span style="color:var(--ok)"><b>${s.clean || 0}</b> clean</span>
        <span style="color:var(--urgent)"><b>${s.duplicates || 0}</b> duplicates</span>
        <span style="color:var(--ctp-yellow)"><b>${s.flagged || 0}</b> flagged</span>
        <span><b>${s.approved || 0}</b> approved</span>
        <span><b>${s.rejected || 0}</b> rejected</span>
      </div>
    </div>
    <div class="sb-table-wrap"><table class="sb-table">
      <thead><tr><th>#</th><th>Contact</th><th>Email</th><th class="sb-phone-col">Phone</th><th>Status</th><th>Decision</th></tr></thead>
      <tbody>
      ${rows.map((r) => {
        const [sl, sc] = SB_STATUS_PILL[r.status] || SB_STATUS_PILL.clean;
        const [dl, dc] = SB_DECISION_PILL[r.decision] || SB_DECISION_PILL.pending;
        const dupNote = r.dup_contact
          ? `↳ matches <b>${esc(r.dup_contact.name)}</b> in contacts`
          : r.dup_row ? `↳ same as row #${r.dup_row.row_num} (${esc(r.dup_row.name || "unnamed")})` : "";
        const flags = r.flags || [];
        const flagHtml = flags.length ? `
          <div style="margin-top:6px"><button class="link" data-sb-flags="${r.id}">⚠ ${flags.length} flag${flags.length === 1 ? "" : "s"}</button>
          <ul class="sb-flags" id="sb-flags-${r.id}" hidden>${flags.map((f) => `<li>${esc(f.reason)}</li>`).join("")}</ul></div>` : "";
        return `
        <tr>
          <td style="color:var(--text-3)">${r.row_num}</td>
          <td><b>${esc(r.name) || `<span style="color:var(--text-3)">(no name)</span>`}</b>${r.title ? `<div class="sb-meta">${esc(r.title)}</div>` : ""}${r.company ? `<div class="sb-meta">🏢 ${esc(r.company)}</div>` : ""}</td>
          <td class="sb-email">${esc(r.email)}</td>
          <td class="sb-phone-col">${esc(r.phone)}</td>
          <td><span class="feed-pill" style="border-color:${sc};color:${sc}">${sl}</span>${dupNote ? `<div class="sb-meta sb-status-note">${dupNote}</div>` : ""}${flagHtml}</td>
          <td>${open ? `
            <span class="feed-pill" style="border-color:${dc};color:${dc}">${dl}</span>
            <div class="sb-actions" style="margin-top:6px">
              ${r.decision !== "approved" ? `<button class="btn ghost small" data-sb-approve="${r.id}">Approve</button>` : ""}
              ${r.decision !== "rejected" ? `<button class="btn ghost small" data-sb-reject="${r.id}">Reject</button>` : ""}
              <button class="btn ghost small" data-sb-edit="${r.id}">Edit</button>
            </div>` : `<span class="feed-pill" style="border-color:${dc};color:${dc}">${dl}</span>`}</td>
        </tr>`;
      }).join("")}
      </tbody>
    </table></div>`;

  $("#sb-back").onclick = () => { sbOpenBatch = null; route(); };
  document.querySelectorAll("[data-sb-flags]").forEach((b) => {
    b.onclick = () => { const u = $(`#sb-flags-${b.dataset.sbFlags}`); if (u) u.hidden = !u.hidden; };
  });
  if (!open) return;
  const refresh = () => route();
  const setDecision = async (id, decision) => { await PATCH(`/api/sandbox/rows/${id}`, { decision }); refresh(); };
  document.querySelectorAll("[data-sb-approve]").forEach((b) => { b.onclick = () => setDecision(b.dataset.sbApprove, "approved"); });
  document.querySelectorAll("[data-sb-reject]").forEach((b) => { b.onclick = () => setDecision(b.dataset.sbReject, "rejected"); });
  document.querySelectorAll("[data-sb-edit]").forEach((b) => {
    b.onclick = async () => {
      const r = rows.find((x) => x.id === Number(b.dataset.sbEdit));
      if (!r) return;
      openModal(`Edit row #${r.row_num}`,
        field("Name", input("name", r.name)) + field("Title", input("title", r.title)) +
        field("Email", input("email", r.email)) + field("Phone", input("phone", r.phone)) +
        field("Company", input("company", r.company)) + field("Notes", `<textarea name="notes" rows="2">${esc(r.notes)}</textarea>`),
        async (data) => { await PATCH(`/api/sandbox/rows/${r.id}`, data); refresh(); });
    };
  });
  $("#sb-bulk-clean").onclick = async () => { await POST(`/api/sandbox/batches/${batch.id}/decision`, { action: "approve-clean" }); refresh(); };
  $("#sb-bulk-dup").onclick = async () => { await POST(`/api/sandbox/batches/${batch.id}/decision`, { action: "reject-duplicates" }); refresh(); };
  $("#sb-commit").onclick = async () => {
    if (!confirm(`Import ${approvable} approved contact${approvable === 1 ? "" : "s"}? Duplicate rows are skipped; this can't be undone in bulk.`)) return;
    const r = await POST(`/api/sandbox/batches/${batch.id}/commit`, {});
    alert(`Imported ${r.imported}, skipped ${r.skipped} duplicate${r.skipped === 1 ? "" : "s"}.`);
    refresh();
  };
  $("#sb-del").onclick = async () => {
    if (!confirm("Delete this import batch? Staged rows are discarded; your live contacts are untouched.")) return;
    await DEL(`/api/sandbox/batches/${batch.id}`);
    sbOpenBatch = null;
    route();
  };
}

/* ---------- captures: business cards & client notes ---------- */
async function vCaptures(root) {
  const el = root || view;
  const [{ captures }, { contacts }] = await Promise.all([GET("/api/captures"), GET("/api/contacts")]);
  el.innerHTML = `
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

async function vAutomations(root) {
  const el = root || view;
  const { webhooks, events } = await GET("/api/webhooks");
  const { deliveries } = await GET("/api/deliveries");
  const { hooks } = await GET(showAllHooks ? "/api/hooks?all=1" : "/api/hooks");
  const base = location.origin;
  el.innerHTML = `
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

async function vSchema(root) {
  const el = root || view;
  const { fields } = await GET(`/api/schema/${schemaEntity}`);
  const entLabel = SCHEMA_ENTITIES.find(([e]) => e === schemaEntity)[1];
  el.innerHTML = `
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
      ["Dashboard", "#/dashboard"], ["Milton", "#/milton"], ["Outreach", "#/outreach"],
      ["Campaigns", "#/campaigns"], ["Daily Feed", "#/feed"], ["Data Workshop", "#/workshop"],
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
// Captures / Automations / Schema moved into the Data Workshop tabs —
// old top-level routes redirect into the matching tab.
const LEGACY_ROUTES = { captures: "captures", automations: "automation", schema: "schema" };
async function route() {
  const [hash] = location.hash.split("?");
  const parts = (hash.replace("#/", "") || "dashboard").split("/");
  const r = parts[0];
  if (LEGACY_ROUTES[r]) { location.hash = `#/workshop/${LEGACY_ROUTES[r]}`; return; }
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
    } else if (name === "workshop") {
      $("#page-title").textContent = TITLES[name];
      await vWorkshop(parts[1]);
    } else {
      $("#page-title").textContent = TITLES[name];
      await { dashboard: vDashboard, milton: vMilton, outreach: vOutreach, feed: vFeed, contacts: vContacts,
        companies: vCompanies, campaigns: vCampaigns }[name]();
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
