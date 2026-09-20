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

## Views

- **Dashboard** — open pipeline, weighted pipeline, won this quarter, open
  tasks; pipeline-by-stage bars; deals closing soon; activity feed.
- **Pipeline** — kanban board, drag cards between stages (fires webhooks).
- **Contacts / Companies / Campaigns / Tasks** — search, create, complete.
- **Schema editor** — add your own custom fields (text, long text, number,
  date, dropdown, checkbox, URL) to contacts, companies, campaigns, and
  tasks; fields show up on every form automatically.
- **Daily Feed** — overdue, today's, and upcoming todos plus deals closing
  this week, with quick-add.
- **Calendar** — week grid (default) or month grid of deal expected-close
  dates and task due dates; global view in the sidebar, a Calendar panel on
  every campaign page (in the prominent slot above the workflow tasks), and a
  mini month calendar inside the deal editor. Read-only: dates change via the
  deal and task forms. Overdue open items are muted terracotta; done tasks and
  closed deals are dimmed. Deal chips carry a left border in their stage's
  funnel-phase color.
- **Funnel-phase colors** — the workspace's ordered stages are split into
  thirds (early / middle / end) purely by position, so the coding survives
  stage renames, reorders, and additions; closed stages sit at the end of the
  order and land in the end third naturally. Applied to kanban column headers
  and card dots, per-campaign pipeline strips, and calendar deal chips/dots.
  Stages outside the workspace order fall back to their legacy color.
- **Collapsible workflow tasks** — the campaign detail's task list starts
  collapsed (chevron + count + Add task in the header); click to expand.
- **Captures** — snap or upload photos of business cards and client notes
  (`capture="environment"` opens the camera on mobile); add a note and link
  each photo to a contact.
- **Automations** — manage both webhook directions, test endpoints, see a
  delivery log.

## Automation platforms (Zapier / Make / n8n)

**Outgoing** — the CRM POSTs JSON to your URLs on:
`deal.created`, `deal.stage_changed`, `deal.updated`, `contact.created`,
`task.created`, `task.completed`. Add them in the Automations view or:

```sh
curl -X POST localhost:3001/api/webhooks \
  -H 'Content-Type: application/json' \
  -d '{"name":"n8n","url":"https://n8n.example.com/webhook/abc","events":["deal.stage_changed"]}'
```

Payload shape: `{"event": "...", "sent_at": "...", "data": {...}}` with an
`X-CRM-Event` header. Every delivery (ok / error / failed) is logged and
visible in the Automations view; a **Test** button sends a sample payload.

**Custom headers** — each outgoing webhook can send extra headers with every
delivery (API keys, shared secrets). Add them in the Automations view's
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
routing. Reassign a hook from the Automations view, or
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
`GET|POST /api/campaigns` · `PATCH|DELETE /api/campaigns/:id` ·\
`GET /api/calendar?scope=global|campaign|deal&id=<n>&from=YYYY-MM-DD&to=YYYY-MM-DD`

Captured photos land in `./uploads/` (created on boot; override with
`CRM_UPLOADS`). Images only, 12 MB max each.
