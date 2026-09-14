/* exec-crm frontend — vanilla SPA */
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const TITLES = {
  dashboard: "Dashboard", feed: "Daily Feed", pipeline: "Pipeline", contacts: "Contacts",
  companies: "Companies", campaigns: "Campaigns", tasks: "Tasks", captures: "Captures",
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
    if (el.select) el.select();
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
    if (kind === "select") el.addEventListener("change", () => commit());
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
    ${pipeView === "board" ? `<div class="board" id="board">
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
    </div>` : ganttHtml(open)}
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
  $("#new-contact").onclick = async () => {
    const [{ companies }, { fields }] = await Promise.all([GET("/api/companies"), getSchemaFields("contact")]);
    openModal("New contact", `
      <div class="formgrid">
        ${field("Name", input("name"))}
        ${field("Title", input("title"))}
        ${field("Company", select("company_id", companies.map((c) => [c.id, c.name])))}
        ${field("Email", input("email", "", "email"))}
        ${field("Phone", input("phone"))}
        ${field("—", `<div></div>`)}
      </div>
      ${cfFieldsHtml(fields)}`,
      async (d) => { await POST("/api/contacts", d); route(); }, "Create contact");
  };
}

async function editContactModal(c) {
  const [{ companies }, { fields }] = await Promise.all([GET("/api/companies"), getSchemaFields("contact")]);
  openModal("Edit contact", `
    <div class="formgrid">
      ${field("Name", input("name", c.name))}
      ${field("Title", input("title", c.title))}
      ${field("Company", select("company_id", [["", "—"]].concat(companies.map((x) => [x.id, x.name])), c.company_id || ""))}
      ${field("Email", input("email", c.email, "email"))}
      ${field("Phone", input("phone", c.phone))}
      ${field("—", `<div></div>`)}
    </div>
    ${cfFieldsHtml(fields, c.custom)}`,
    async (d) => { await PATCH(`/api/contacts/${c.id}`, d); route(); }, "Save changes");
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
  $("#new-company").onclick = async () => {
    const fields = await getSchemaFields("company");
    openModal("New company", `
      ${field("Name", input("name"))}
      <div class="formgrid">${field("Industry", input("industry"))}${field("Website", input("website"))}</div>
      ${cfFieldsHtml(fields)}`,
      async (d) => { await POST("/api/companies", d); route(); }, "Create company");
  };
}

async function editCompanyModal(c) {
  const fields = await getSchemaFields("company");
  openModal("Edit company", `
    ${field("Name", input("name", c.name))}
    <div class="formgrid">${field("Industry", input("industry", c.industry))}${field("Website", input("website", c.website))}</div>
    ${cfFieldsHtml(fields, c.custom)}`,
    async (d) => { await PATCH(`/api/companies/${c.id}`, d); route(); }, "Save changes");
}

/* ---------- campaigns ---------- */
const CAMPAIGN_STATUSES = ["draft", "active", "paused", "completed"];

async function vCampaigns() {
  const { campaigns } = await GET("/api/campaigns");
  view.innerHTML = `
    <div class="toolbar"><div class="spacer"></div>
      <button class="btn" id="new-campaign">+ New campaign</button></div>
    <div class="panel"><table>
      <tr><th>Campaign</th><th>Status</th><th>Start</th><th>End</th><th>Budget</th></tr>
      ${campaigns.map((c) => `<tr class="clickable" data-id="${c.id}"><td><b>${esc(c.name)}</b></td>
        <td>${statusPill(c.status)}</td><td>${esc(c.start_date) || "—"}</td><td>${esc(c.end_date) || "—"}</td>
        <td><b>${money(c.budget)}</b></td></tr>`).join("")}
    </table>${campaigns.length ? "" : `<div class="empty">No campaigns yet — launch your first one.</div>`}</div>`;
  document.querySelectorAll("#view tr.clickable").forEach((tr) => {
    tr.onclick = () => {
      const c = campaigns.find((x) => x.id === Number(tr.dataset.id));
      if (c) editCampaignModal(c);
    };
  });
  $("#new-campaign").onclick = async () => {
    const fields = await getSchemaFields("campaign");
    openModal("New campaign", `
      ${field("Name", input("name"))}
      <div class="formgrid">
        ${field("Status", select("status", CAMPAIGN_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), "draft"))}
        ${field("Budget ($)", input("budget", "0", "number"))}
        ${field("Start date", input("start_date", "", "date"))}
        ${field("End date", input("end_date", "", "date"))}
      </div>
      ${field("Notes", `<textarea name="notes" rows="3"></textarea>`)}
      ${cfFieldsHtml(fields)}`,
      async (d) => { await POST("/api/campaigns", d); route(); }, "Create campaign");
  };
}

async function editCampaignModal(c) {
  const fields = await getSchemaFields("campaign");
  openModal("Edit campaign", `
    ${field("Name", input("name", c.name))}
    <div class="formgrid">
      ${field("Status", select("status", CAMPAIGN_STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), c.status || "draft"))}
      ${field("Budget ($)", input("budget", c.budget || 0, "number"))}
      ${field("Start date", input("start_date", c.start_date || "", "date"))}
      ${field("End date", input("end_date", c.end_date || "", "date"))}
    </div>
    ${field("Notes", `<textarea name="notes" rows="3">${esc(c.notes || "")}</textarea>`)}
    ${cfFieldsHtml(fields, c.custom)}
    <div style="margin-top:14px"><button class="btn danger small" id="m-delete">Delete campaign</button></div>`,
    async (d) => { await PATCH(`/api/campaigns/${c.id}`, d); route(); }, "Save changes");
  $("#m-delete").onclick = async () => {
    if (confirm(`Delete campaign "${c.name}"?`)) { await DEL(`/api/campaigns/${c.id}`); $("#modal-root").innerHTML = ""; route(); }
  };
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
      ${tasks.map(taskRow).join("") || `<div class="empty">All clear.</div>`}
    </div>`;
  wireTaskRows(tasks, deals);
  $("#new-task").onclick = async () => {
    const fields = await getSchemaFields("task");
    openModal("New task", `
      ${field("Title", input("title"))}
      <div class="formgrid">
        ${field("Related deal", select("deal_id", [["", "—"]].concat(deals.filter((d) => !["closed_won", "closed_lost"].includes(d.stage)).map((d) => [d.id, d.title]))))}
        ${field("Due date", input("due_date", "", "date"))}
      </div>
      ${field("Owner", input("owner", "You"))}
      ${cfFieldsHtml(fields)}`,
      async (d) => { if (!d.deal_id) delete d.deal_id; await POST("/api/tasks", d); route(); }, "Create task");
  };
}

/* shared task row + wiring (used by Tasks and Daily Feed) */
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
      const res = await fetch("/api/captures", { method: "POST", body: fd });
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

async function vAutomations() {
  const { webhooks, events } = await GET("/api/webhooks");
  const { deliveries } = await GET("/api/deliveries");
  const { hooks } = await GET("/api/hooks");
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

  async function buildItems() {
    if (cache) return cache;
    const NAV = [
      ["Dashboard", "#/dashboard"], ["Daily Feed", "#/feed"], ["Pipeline", "#/pipeline"], ["Contacts", "#/contacts"],
      ["Companies", "#/companies"], ["Campaigns", "#/campaigns"], ["Tasks", "#/tasks"], ["Captures", "#/captures"],
      ["Automations", "#/automations"], ["Schema", "#/schema"],
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
  view.innerHTML = `<div class="skel" style="height:34px;max-width:300px;margin-bottom:18px"></div>
    <div class="skel" style="height:120px;margin-bottom:16px"></div>
    <div class="skel" style="height:220px"></div>`;
  try {
    await { dashboard: vDashboard, feed: vFeed, pipeline: vPipeline, contacts: vContacts,
      companies: vCompanies, campaigns: vCampaigns, tasks: vTasks, captures: vCaptures,
      automations: vAutomations, schema: vSchema }[name]();
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
