import { Database } from "bun:sqlite";

export const STAGES = [
  "prospecting",
  "qualification",
  "proposal",
  "negotiation",
  "closed_won",
  "closed_lost",
] as const;

export const STAGE_LABELS: Record<string, string> = {
  prospecting: "Prospecting",
  qualification: "Qualification",
  proposal: "Proposal",
  negotiation: "Negotiation",
  closed_won: "Closed Won",
  closed_lost: "Closed Lost",
};

export const STAGE_COLORS: Record<string, string> = {
  prospecting: "#579bfc",
  qualification: "#a9bee8",
  proposal: "#784bd1",
  negotiation: "#ffcb00",
  closed_won: "#00ca72",
  closed_lost: "#d974b9",
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT DEFAULT '#579bfc',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  industry TEXT DEFAULT '',
  website TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  name TEXT NOT NULL,
  title TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  contact_id INTEGER REFERENCES contacts(id),
  value REAL DEFAULT 0,
  stage TEXT DEFAULT 'prospecting',
  probability INTEGER DEFAULT 10,
  expected_close TEXT DEFAULT '',
  owner TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  deal_id INTEGER REFERENCES deals(id),
  campaign_id INTEGER REFERENCES campaigns(id),
  due_date TEXT DEFAULT '',
  done INTEGER DEFAULT 0,
  owner TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  ref_type TEXT DEFAULT '',
  ref_id INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER REFERENCES webhooks(id),
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  response_code INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS incoming_hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,
  workspace_id INTEGER REFERENCES workspaces(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS milton_widgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER DEFAULT 0,
  color TEXT DEFAULT '#579bfc',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, slug)
);
CREATE TABLE IF NOT EXISTS captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  original_name TEXT DEFAULT '',
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  note TEXT DEFAULT '',
  contact_id INTEGER REFERENCES contacts(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company_id INTEGER REFERENCES companies(id),
  status TEXT DEFAULT 'draft',
  start_date TEXT DEFAULT '',
  end_date TEXT DEFAULT '',
  budget REAL DEFAULT 0,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  entity TEXT NOT NULL,
  name TEXT NOT NULL,
  label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text',
  options TEXT DEFAULT '[]',
  required INTEGER DEFAULT 0,
  position INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(entity, workspace_id, name)
);
CREATE TABLE IF NOT EXISTS custom_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value TEXT DEFAULT '',
  UNIQUE(entity, record_id, field_id)
);
CREATE TABLE IF NOT EXISTS saved_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  name TEXT NOT NULL,
  filters_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sandbox_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id),
  name TEXT NOT NULL,
  filename TEXT DEFAULT '',
  source TEXT DEFAULT 'csv',
  status TEXT DEFAULT 'open',
  row_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sandbox_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER REFERENCES sandbox_batches(id),
  workspace_id INTEGER REFERENCES workspaces(id),
  row_num INTEGER DEFAULT 0,
  name TEXT DEFAULT '',
  title TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  company TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  status TEXT DEFAULT 'clean',
  decision TEXT DEFAULT 'pending',
  dup_of_contact_id INTEGER DEFAULT 0,
  dup_of_row_id INTEGER DEFAULT 0,
  flags TEXT DEFAULT '[]',
  extra_flags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deal_stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal_id INTEGER REFERENCES deals(id),
  workspace_id INTEGER REFERENCES workspaces(id),
  from_stage TEXT DEFAULT '',
  to_stage TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
  workspace_id INTEGER REFERENCES workspaces(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  // migration: tasks gained campaign_id after the schema-editor release.
  // The index is created here (not in SCHEMA) so old DBs get the column first.
  const taskCols = db.query("PRAGMA table_info(tasks)").all() as any[];
  if (!taskCols.some((c) => c.name === "campaign_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_campaign ON tasks(campaign_id)");
  // migration: deals, contacts and companies can be linked to a campaign.
  // Nullable campaign_id; deleting a campaign nulls the link, never the record.
  for (const t of ["deals", "contacts", "companies"]) {
    const cols = db.query(`PRAGMA table_info(${t})`).all() as any[];
    if (!cols.some((c) => c.name === "campaign_id")) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN campaign_id INTEGER REFERENCES campaigns(id)`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_deals_campaign ON deals(campaign_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_campaign ON contacts(campaign_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_companies_campaign ON companies(campaign_id)");
  // migration: campaigns are now connected to a company
  const campCols = db.query("PRAGMA table_info(campaigns)").all() as any[];
  if (!campCols.some((c) => c.name === "company_id")) {
    db.exec("ALTER TABLE campaigns ADD COLUMN company_id INTEGER REFERENCES companies(id)");
  }
  // migration: workspaces — every record lives in exactly one workspace.
  // settings stays global (app config). incoming_hooks are per-workspace so an
  // automation platform posts to one hook and its records land in that hook's
  // workspace with no query-param juggling.
  const SCOPED = [
    "companies", "contacts", "deals", "tasks", "campaigns",
    "activities", "captures", "custom_fields", "webhooks", "incoming_hooks",
  ];
  for (const t of SCOPED) {
    const cols = db.query(`PRAGMA table_info(${t})`).all() as any[];
    if (!cols.some((c) => c.name === "workspace_id")) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id)`);
    }
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_deals_ws ON deals(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_contacts_ws ON contacts(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_companies_ws ON companies(workspace_id)");
  const mainId = ensureMainWorkspace(db);
  for (const t of SCOPED) {
    db.exec(`UPDATE ${t} SET workspace_id = ${mainId} WHERE workspace_id IS NULL`);
  }
  // migration: custom field names were globally unique; they are now unique per workspace
  const cfSql = (db.query("SELECT sql FROM sqlite_master WHERE name = 'custom_fields'").get() as any)?.sql || "";
  if (cfSql.includes("UNIQUE(entity, name)") && !cfSql.includes("workspace_id, name")) {
    db.exec(`
      CREATE TABLE custom_fields_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER REFERENCES workspaces(id),
        entity TEXT NOT NULL,
        name TEXT NOT NULL,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        options TEXT DEFAULT '[]',
        required INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(entity, workspace_id, name)
      );
      INSERT INTO custom_fields_new (id, workspace_id, entity, name, label, type, options, required, position, created_at)
        SELECT id, workspace_id, entity, name, label, type, options, required, position, created_at FROM custom_fields;
      DROP TABLE custom_fields;
      ALTER TABLE custom_fields_new RENAME TO custom_fields;
    `);
  }
  // migration: outgoing webhooks can carry custom headers (e.g. X-Milton-Secret).
  // Values are secrets; the API only ever exposes header names.
  const whCols = db.query("PRAGMA table_info(webhooks)").all() as any[];
  if (!whCols.some((c) => c.name === "headers")) {
    db.exec("ALTER TABLE webhooks ADD COLUMN headers TEXT DEFAULT '{}'");
  }
  // migration: deals gained a free-text source field (lead origin), and the
  // batch-5 tables: deal_stage_history, task_dependencies, saved_views.
  const dealCols = db.query("PRAGMA table_info(deals)").all() as any[];
  if (!dealCols.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE deals ADD COLUMN source TEXT DEFAULT ''");
  }
  // migration: sandbox batches gained a source type ('csv' or 'vcf'), and
  // sandbox rows gained extra_flags (source-specific flags that survive
  // re-analysis, e.g. vCard multi-email notes).
  const sbBatchCols = db.query("PRAGMA table_info(sandbox_batches)").all() as any[];
  if (!sbBatchCols.some((c) => c.name === "source")) {
    db.exec("ALTER TABLE sandbox_batches ADD COLUMN source TEXT DEFAULT 'csv'");
  }
  const sbRowCols = db.query("PRAGMA table_info(sandbox_rows)").all() as any[];
  if (!sbRowCols.some((c) => c.name === "extra_flags")) {
    db.exec("ALTER TABLE sandbox_rows ADD COLUMN extra_flags TEXT DEFAULT '[]'");
  }
  for (const [t, sql] of [
    ["deal_stage_history", `CREATE TABLE deal_stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER REFERENCES deals(id),
      workspace_id INTEGER REFERENCES workspaces(id),
      from_stage TEXT DEFAULT '',
      to_stage TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')))`,],
    ["task_dependencies", `CREATE TABLE task_dependencies (
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      depends_on_task_id INTEGER NOT NULL REFERENCES tasks(id),
      workspace_id INTEGER REFERENCES workspaces(id),
      PRIMARY KEY (task_id, depends_on_task_id))`,],
    ["saved_views", `CREATE TABLE saved_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id),
      name TEXT NOT NULL,
      filters_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')))`,],
  ] as [string, string][]) {
    const exists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
    if (!exists) db.exec(sql);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_stage_history_deal ON deal_stage_history(deal_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_stage_history_ws ON deal_stage_history(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_task_deps_ws ON task_dependencies(workspace_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_saved_views_ws ON saved_views(workspace_id)");
  // migration: pipeline stages are editable per workspace (Milton schema editing).
  // deals.stage stays a TEXT slug; the stages table owns the per-workspace
  // ordered schema. Legacy DBs get the table created and seeded below.
  const hasStages = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stages'")
    .get();
  if (!hasStages) {
    db.exec(`CREATE TABLE stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id INTEGER REFERENCES workspaces(id),
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      color TEXT DEFAULT '#579bfc',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(workspace_id, slug)
    )`);
  }
  for (const w of db.query("SELECT id FROM workspaces").all() as any[]) {
    seedStages(db, w.id);
  }
  return db;
}

/** Turn a display name into a URL-safe stage slug. */
export function slugifyStage(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return slug;
}

/** Ordered stage rows for a workspace. Empty array when exec-crm is unreachable is never the case here; callers seed on demand. */
export function workspaceStages(db: Database, wsId: number) {
  return db
    .query("SELECT slug, name, position, color FROM stages WHERE workspace_id = ? ORDER BY position, id")
    .all(wsId) as { slug: string; name: string; position: number; color: string }[];
}

/** Seed the six default stages into a workspace that has none. Idempotent. */
export function seedStages(db: Database, wsId: number): void {
  const n = (db.query("SELECT COUNT(*) AS n FROM stages WHERE workspace_id = ?").get(wsId) as any).n;
  if (n > 0) return;
  const ins = db.prepare(
    "INSERT INTO stages (workspace_id, slug, name, position, color) VALUES (?, ?, ?, ?, ?)"
  );
  STAGES.forEach((slug, i) => {
    ins.run(wsId, slug, STAGE_LABELS[slug] || slug, i, STAGE_COLORS[slug] || "#579bfc");
  });
}

/** Slugs of the workspace's stages, seeded on demand. */
export function stageSlugs(db: Database, wsId: number): string[] {
  seedStages(db, wsId);
  return workspaceStages(db, wsId).map((s) => s.slug);
}

/** Renumber stage positions 0..n in display order. */
export function renumberStages(db: Database, wsId: number): void {
  const rows = workspaceStages(db, wsId);
  const upd = db.prepare("UPDATE stages SET position = ? WHERE workspace_id = ? AND slug = ?");
  rows.forEach((r, i) => upd.run(i, wsId, r.slug));
}

// Returns the id of the first workspace, creating "Main" when none exist.
export function ensureMainWorkspace(db: Database): number {
  const w = db.query("SELECT id FROM workspaces ORDER BY id LIMIT 1").get() as any;
  if (w) return w.id;
  const r = db
    .prepare("INSERT INTO workspaces (name, color) VALUES ('Main', '#579bfc')")
    .run();
  return Number(r.lastInsertRowid);
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
}

export function seedIfEmpty(db: Database) {
  if (count(db, "companies") > 0) return;
  const ws = ensureMainWorkspace(db);

  const companies: [string, string, string][] = [
    ["Meridian Logistics", "Logistics", "meridianlog.com"],
    ["Bluefin Capital", "Finance", "bluefincap.com"],
    ["Northwind Retail", "Retail", "northwindretail.com"],
    ["Helios Energy", "Energy", "heliosenergy.com"],
    ["Copperline Foods", "Food & Bev", "copperlinefoods.com"],
    ["Vertex Health", "Healthcare", "vertexhealth.com"],
    ["Driftwell Travel", "Travel", "driftwelltravel.com"],
    ["Ironpeak Manufacturing", "Industrial", "ironpeakmfg.com"],
  ];
  const insCo = db.prepare(
    "INSERT INTO companies (name, industry, website, workspace_id) VALUES (?, ?, ?, ?)"
  );
  const coIds = companies.map((c) => Number(insCo.run(c[0], c[1], c[2], ws).lastInsertRowid));

  const contacts: [number, string, string, string][] = [
    [0, "Amara Okafor", "COO", "amara@meridianlog.com"],
    [0, "David Reyes", "VP Operations", "d.reyes@meridianlog.com"],
    [1, "Priya Nair", "CFO", "priya@bluefincap.com"],
    [2, "Tom Becker", "CEO", "tom@northwindretail.com"],
    [3, "Lena Fischer", "Head of Procurement", "lena@heliosenergy.com"],
    [4, "Marcus Webb", "Founder", "marcus@copperlinefoods.com"],
    [5, "Dr. Sofia Almeida", "CMO", "sofia@vertexhealth.com"],
    [6, "Jonas Lindqvist", "CEO", "jonas@driftwelltravel.com"],
    [7, "Rachel Kim", "VP Supply Chain", "rachel@ironpeakmfg.com"],
    [1, "Omar Haddad", "Partner", "omar@bluefincap.com"],
  ];
  const insCt = db.prepare(
    "INSERT INTO contacts (company_id, name, title, email, workspace_id) VALUES (?, ?, ?, ?, ?)"
  );
  const ctIds = contacts.map(([ci, n, t, e]) =>
    Number(insCt.run(coIds[ci], n, t, e, ws).lastInsertRowid)
  );

  const deals: [string, number, number, number, string, number, string, string][] = [
    // title, company idx, contact idx, value, stage, prob, close, owner
    ["Fleet tracking rollout", 0, 0, 240000, "negotiation", 75, "2026-10-15", "You"],
    ["Treasury automation", 1, 2, 180000, "proposal", 60, "2026-11-01", "You"],
    ["POS upgrade — 40 stores", 2, 3, 320000, "qualification", 35, "2026-12-01", "You"],
    ["Solar farm monitoring", 3, 4, 410000, "negotiation", 80, "2026-10-02", "You"],
    ["Distribution partnership", 4, 5, 95000, "prospecting", 15, "2027-01-15", "You"],
    ["Patient intake platform", 5, 6, 275000, "proposal", 55, "2026-11-20", "You"],
    ["Booking engine revamp", 6, 7, 150000, "qualification", 40, "2026-12-10", "You"],
    ["Factory IoT sensors", 7, 8, 520000, "negotiation", 70, "2026-10-28", "You"],
    ["Working capital facility", 1, 9, 600000, "prospecting", 20, "2027-02-01", "You"],
    ["Cold-chain expansion", 0, 1, 130000, "qualification", 30, "2026-12-18", "You"],
    ["Regional hub license", 2, 3, 210000, "closed_won", 100, "2026-08-30", "You"],
    ["Payroll migration", 4, 5, 88000, "closed_won", 100, "2026-07-22", "You"],
    ["Legacy audit", 6, 7, 64000, "closed_lost", 0, "2026-08-11", "You"],
    ["Grid analytics pilot", 3, 4, 175000, "proposal", 50, "2026-11-08", "You"],
    ["Private label launch", 4, 5, 142000, "prospecting", 10, "2027-01-30", "You"],
    ["Telehealth integration", 5, 6, 198000, "qualification", 35, "2026-12-05", "You"],
    ["Loyalty program rebuild", 6, 7, 115000, "negotiation", 65, "2026-10-20", "You"],
    ["Robotics cell install", 7, 8, 460000, "proposal", 55, "2026-11-25", "You"],
  ];
  const insDeal = db.prepare(
    `INSERT INTO deals (title, company_id, contact_id, value, stage, probability,
     expected_close, owner, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const dealIds = deals.map(([t, ci, cti, v, s, p, ec, o]) =>
    Number(insDeal.run(t, coIds[ci], ctIds[cti], v, s, p, ec, o, ws).lastInsertRowid)
  );

  const tasks: [string, number | null, string, string][] = [
    ["Send revised SOW to Helios", 3, "2026-09-12", "You"],
    ["Exec briefing prep — Ironpeak", 7, "2026-09-11", "You"],
    ["Follow up: Bluefin treasury demo", 1, "2026-09-14", "You"],
    ["Intro call: Copperline private label", 14, "2026-09-16", "You"],
    ["Review Northwind POS proposal", 2, "2026-09-13", "You"],
    ["Q3 board deck — pipeline slide", null, "2026-09-18", "You"],
  ];
  const insTask = db.prepare(
    "INSERT INTO tasks (title, deal_id, due_date, owner, workspace_id) VALUES (?, ?, ?, ?, ?)"
  );
  for (const [t, d, dd, o] of tasks) insTask.run(t, d === null ? null : dealIds[d], dd, o, ws);

  const acts: [string, string][] = [
    ["deal", "Solar farm monitoring moved to Negotiation"],
    ["deal", "Factory IoT sensors moved to Negotiation"],
    ["note", "Board asked for pipeline coverage ≥ 3x — currently on track"],
    ["deal", "Regional hub license closed won — $210,000"],
    ["task", "Q3 board deck — pipeline slide due Sep 18"],
    ["deal", "Working capital facility added to Prospecting"],
  ];
  const insAct = db.prepare("INSERT INTO activities (kind, text, workspace_id) VALUES (?, ?, ?)");
  for (const [k, t] of acts) insAct.run(k, t, ws);

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '1')").run();
}
