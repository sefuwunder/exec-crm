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

**Incoming** — create a hook, then POST from any platform's HTTP step:

```sh
curl -X POST localhost:3001/api/hooks/in/YOUR_KEY \
  -H 'Content-Type: application/json' \
  -d '{"action":"create_deal","data":{"title":"Acme renewal","value":120000,"stage":"proposal"}}'
```

Actions: `create_deal`, `create_contact`, `create_task`. Inbound records also
fan out to outgoing webhooks, so chains compose.

## API

`GET /api/kpis` · `GET|POST /api/deals` · `PATCH|DELETE /api/deals/:id` ·
`GET|POST /api/contacts` · `GET|POST /api/companies` · `GET|POST /api/tasks` ·
`POST /api/tasks/:id/toggle` · `GET /api/activities` · `GET /api/webhooks` ·
`POST /api/webhooks/:id/test` · `GET /api/deliveries` · `GET|POST /api/hooks` ·
`DELETE /api/hooks/:id` · `POST /api/hooks/in/:key` ·
`GET|POST /api/captures` (multipart `photos[]`) · `PATCH|DELETE /api/captures/:id` ·
`GET /uploads/:file` ·
`GET /api/schema/:entity` · `POST /api/schema/:entity` · `PATCH|DELETE /api/schema/fields/:id` ·
`GET|POST /api/campaigns` · `PATCH|DELETE /api/campaigns/:id`

Captured photos land in `./uploads/` (created on boot; override with
`CRM_UPLOADS`). Images only, 12 MB max each.
