# exec-crm

A focused, C-suite CRM with a modern monday.com-style UI, built on **Bun** +
**SQLite** (zero npm dependencies). Executive dashboard, drag-and-drop sales
pipeline, contacts, companies, tasks — plus two-way **automation platform**
integration via webhooks.

## Run

```sh
bun install   # no-op, zero deps
bun start     # -> http://localhost:3001
PORT=4000 bun start
```

Data lives in `./crm.db` (created + seeded on first run). Override with `CRM_DB`.

Start Milton first (default port 3009), then exec-crm: the Milton page and
Dashboard insights talk to Milton through exec-crm's same-origin proxy. If
Milton runs on another host, set `MILTON_URL` on exec-crm — it stays
server-side and is never exposed to the browser.

## Views

The app is built around the **Review → Action → Outcome** cycle:

- **Dashboard** — Milton insights only: Milton's pipeline-hygiene findings
  grouped Review → Action → Outcome, with a cycle strip showing the counts.
  No KPIs, no pipeline summary — those live where the work happens. Below the
  feed, your **widgets** mount into Dashboard slots (see Widgets).
- **Milton** — the Milton agent embedded in the CRM. Same-origin chat
  (no iframe): one Milton session per workspace, remembered in the browser,
  every call re-validated against the active workspace server-side.
- **Outreach** — the Action log: every touch in one place — calls, emails,
  social messages, video calls, in-person. Filter by channel, link each
  touch to a deal and/or contact, and log the outcome when it lands.
- **Campaigns** — pipeline kanban board (drag cards between stages, fires
  webhooks), per-campaign detail, stage management.
- **Contacts / Companies / Tasks** — search, create, complete.
- **Data Workshop** — the back-office, in four tabs:
  - **Captures** — snap or upload photos of business cards and client notes
    (`capture="environment"` opens the camera on mobile); add a note and link
    each photo to a contact.
  - **Schema** — add your own custom fields (text, long text, number,
    date, dropdown, checkbox, URL) to contacts, companies, campaigns, and
    tasks; fields show up on every form automatically.
  - **Automation** — manage both webhook directions, test endpoints, see a
    delivery log.
  - **Sandbox** — stage CSV/VCF contact imports safely: exact + fuzzy dedup
    against existing contacts and within the file, junk/invalid data flags,
    per-row approve/reject/edit, then import only the approved rows.
- **Daily Feed** — overdue, today's, and upcoming todos plus deals closing
  this week, with quick-add.

## Automation platforms (Zapier / Make / n8n)

**Outgoing** — the CRM POSTs JSON to your URLs on:
`deal.created`, `deal.stage_changed`, `deal.updated`, `contact.created`,
`task.created`, `task.completed`. Add them in Data Workshop → Automation or:

```sh
curl -X POST localhost:3001/api/webhooks \
  -H 'Content-Type: application/json' \
  -d '{"name":"n8n","url":"https://n8n.example.com/webhook/abc","events":["deal.stage_changed"]}'
```

Payload shape: `{"event": "...", "sent_at": "...", "data": {...}}` with an
`X-CRM-Event` header. Every delivery (ok / error / failed) is logged and
visible in Data Workshop → Automation; a **Test** button sends a sample payload.

**Custom headers** — each outgoing webhook can send extra headers with every
delivery (API keys, shared secrets). Add them in Data Workshop → Automation's
webhook editor, or pass `"headers": {"X-Foo": "bar"}` to
`POST /api/webhooks` (`PATCH /api/webhooks/:id` to change them later).
Header values are secrets: the API and UI only ever reveal header *names*,
never values. Custom headers win over the defaults (`Content-Type`,
`X-CRM-Event`); connection-framing headers (`Content-Length`, `Host`, …)
are rejected.

**Milton wiring** — no proxy needed. Point a webhook straight at Milton:
1. In Milton: set `MILTON_HOOK_SECRET` to a shared secret and restart it.
2. Here: Automations → Add webhook, URL
   `http://<milton-host>:3009/api/hooks/exec-crm`, events e.g.
   `deal.stage_changed`, custom header `X-Milton-Secret` = the same secret.
3. In Milton chat: `when deal won run celebrate`. exec-crm fires on the
   event, Milton runs the routine.

**Incoming** — each hook belongs to exactly one workspace (the one active
when it's created). Create a hook, then POST from any platform's HTTP step —
records land in the hook's workspace automatically:

```sh
curl -X POST localhost:3001/api/hooks/in/YOUR_KEY \
  -H 'Content-Type: application/json' \
  -d '{"action":"create_deal","data":{"title":"Acme renewal","value":120000,"stage":"proposal"}}'
```

Actions: `create_deal`, `create_contact`, `create_task`. An explicit
`?workspace=<id>` on the hook URL overrides the hook's workspace for one-off
routing. Reassign a hook from Data Workshop → Automation, or
`PATCH /api/hooks/:id {"workspace_id": 2}`. Inbound records also fan out to
outgoing webhooks, so chains compose.

## API

`GET /api/kpis` · `GET|POST /api/deals` · `PATCH|DELETE /api/deals/:id` ·
`GET|POST /api/contacts` · `GET|POST /api/companies` · `GET|POST /api/tasks` ·
`POST /api/tasks/:id/toggle` · `GET /api/activities` · `GET|POST /api/webhooks` · `PATCH /api/webhooks/:id` ·
`POST /api/webhooks/:id/test` · `GET /api/deliveries` · `GET|POST /api/hooks` ·
`PATCH|DELETE /api/hooks/:id` · `POST /api/hooks/in/:key` ·
`GET|POST /api/captures` (multipart `photos[]`) · `PATCH|DELETE /api/captures/:id` ·
`GET /uploads/:file` ·
`GET /api/schema/:entity` · `POST /api/schema/:entity` · `PATCH|DELETE /api/schema/fields/:id` ·
`GET|POST /api/campaigns` · `PATCH|DELETE /api/campaigns/:id`

Captured photos land in `./uploads/` (created on boot; override with
`CRM_UPLOADS`). Images only, 12 MB max each.

## Widgets

exec-crm is the widget scaffold for the Milton business agent: small
**manifest + JavaScript + CSS** bundles that mount into Dashboard slots. A
widget is proposed by Milton or by you — there is no third-party registry.

**Bundle format** — one JSON manifest plus code:

```json
{
  "name": "stalled-deals",
  "title": "Stalled Deals",
  "version": "1.0.0",
  "mount": "dashboard",
  "permissions": ["deals:read", "deals:write"],
  "description": "Flags deals untouched for 30+ days."
}
```

- `name`: lowercase slug (`a-z0-9-`), unique per workspace.
- `version`: semver. Updating a widget snapshots the previous bundle, so you
  can roll back (last 25 versions are kept).
- `mount`: currently only `"dashboard"`.
- `permissions`: non-empty, from the allowlist below. **Reads and writes are
  available from day 1** — `deals:write` really can change your deals.

Limits: JS 256 KB, CSS 64 KB, manifest 8 KB.

**Permission model** — the manifest lists what the widget wants; **you grant
it at install/update time**, reads and writes shown separately with writes
called out plainly ("changes your CRM data"). The server re-checks every
call: a widget can only reach the endpoints its granted permissions allow,
in its own workspace. Nothing else is reachable — no widget APIs, no Milton
proxy, no hooks.

Permission allowlist:

| reads | writes |
|---|---|
| `deals:read` | `deals:write` |
| `contacts:read` | `contacts:write` |
| `companies:read` | `companies:write` |
| `tasks:read` | `tasks:write` |
| `outreach:read` | `outreach:write` |
| `feed:read` | — |

Reachable endpoints per permission: the matching CRM collection and
item routes (`GET` needs `:read`, `POST`/`PATCH`/`DELETE` need `:write`;
`feed:read` covers `GET /api/daily-feed`).

**Sandbox** — each widget runs in its own `<iframe sandbox="allow-scripts">`
(no same-origin access) with a strict Content-Security-Policy: no network
connections at all. The only way a widget touches exec-crm is the host
bridge:

```js
// inside widget.js — window.execrm is injected by the host bundle
const deals = await window.execrm.api.get("/api/deals");
await window.execrm.api.post("/api/tasks", { title: "Follow up" });
window.execrm.notify("Deal moved");   // toast in the CRM chrome
window.execrm.resize(320);            // ask the host to resize the slot
// window.execrm.widget / .workspace / .permissions describe the context
```

Calls outside the granted permissions fail with `permission denied`; calls
outside the allowlist never leave the browser. Disabled widgets are
unmounted and their bundle URL returns 404.

**Manager** — the ⚙ Manage button on the Dashboard widget panel opens
`#/dashboard/widgets` (kept out of the main nav on purpose). It lists every
widget with its version, permission chips, and enable toggle; from there you
can install/update (paste code or upload a `{manifest, js, css}` JSON
bundle), roll back to the previous version, or uninstall.

Widget API: `GET|POST /api/widgets` · `GET /api/widgets/:id` ·
`PATCH /api/widgets/:id` (`{enabled}`) · `DELETE /api/widgets/:id` ·
`GET /api/widgets/:id/versions` · `POST /api/widgets/:id/rollback` ·
`GET /api/widgets/:id/bundle` · `POST /api/widgets/:id/invoke`
(`{method, path, body}` → proxied CRM call, permission-checked).

**Local development** — on boot the server scans `./widgets/` (created if
missing; override with `CRM_WIDGETS`, gitignored): each subfolder with a
`manifest.json` + `widget.js` (+ optional `widget.css`) is installed or
updated into the first workspace automatically. Restart the server to pick
up changes.
