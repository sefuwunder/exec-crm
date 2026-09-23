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
  No KPIs, no pipeline summary — those live where the work happens.
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
