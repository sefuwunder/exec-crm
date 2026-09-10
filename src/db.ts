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
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n;
}

export function seedIfEmpty(db: Database) {
  if (count(db, "companies") > 0) return;

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
    "INSERT INTO companies (name, industry, website) VALUES (?, ?, ?)"
  );
  const coIds = companies.map((c) => Number(insCo.run(...c).lastInsertRowid));

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
    "INSERT INTO contacts (company_id, name, title, email) VALUES (?, ?, ?, ?)"
  );
  const ctIds = contacts.map(([ci, n, t, e]) =>
    Number(insCt.run(coIds[ci], n, t, e).lastInsertRowid)
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
     expected_close, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const dealIds = deals.map(([t, ci, cti, v, s, p, ec, o]) =>
    Number(insDeal.run(t, coIds[ci], ctIds[cti], v, s, p, ec, o).lastInsertRowid)
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
    "INSERT INTO tasks (title, deal_id, due_date, owner) VALUES (?, ?, ?, ?)"
  );
  for (const [t, d, dd, o] of tasks) insTask.run(t, d === null ? null : dealIds[d], dd, o);

  const acts: [string, string][] = [
    ["deal", "Solar farm monitoring moved to Negotiation"],
    ["deal", "Factory IoT sensors moved to Negotiation"],
    ["note", "Board asked for pipeline coverage ≥ 3x — currently on track"],
    ["deal", "Regional hub license closed won — $210,000"],
    ["task", "Q3 board deck — pipeline slide due Sep 18"],
    ["deal", "Working capital facility added to Prospecting"],
  ];
  const insAct = db.prepare("INSERT INTO activities (kind, text) VALUES (?, ?)");
  for (const [k, t] of acts) insAct.run(k, t);

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('seeded', '1')").run();
}
