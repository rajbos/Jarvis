// ── Ruddr budget tools for the Jarvis MCP server ──────────────────────────────
// Reads the budget cache the Groups plugin scrapes from ruddr.io and joins it
// to customer groups so a caller can ask "what is the budget utilization for
// customer X?". Read-only; never talks to Ruddr itself.
import type { Database as SqlJsDatabase } from 'sql.js';
import { listGroupsWithRuddr, listRuddrProjects } from './ruddr.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RuddrProjectBudget {
  projectName: string;
  projectPath: string | null;
  projectUrl: string | null;
  note: string | null;
  cloudFolderUrl: string | null;
  /** Raw cached strings as scraped from Ruddr (hours). */
  actualBillableHours: string | null;
  actualNonBillableHours: string | null;
  actualTotalHours: string | null;
  budget: string | null;
  budgetLeft: string | null;
  /** Parsed numbers (hours), null when the cached string is not numeric. */
  budgetHours: number | null;
  budgetLeftHours: number | null;
  actualTotalHoursNumber: number | null;
  /** Fraction of budget consumed (0..1+, >1 means over budget); null when unknown. */
  utilization: number | null;
  overBudget: boolean | null;
  fetchedAt: string | null;
}

export interface CustomerBudgetSummary {
  customer: { id: number; name: string; matchScore: number } | null;
  /** How the customer name was resolved: a Jarvis group, a Ruddr project-name fallback, or nothing. */
  resolution: 'group' | 'project' | 'none';
  projects: RuddrProjectBudget[];
  totals: {
    budgetHours: number;
    budgetLeftHours: number;
    actualTotalHours: number;
    utilization: number | null;
    projectsWithBudget: number;
  };
  /** False when the Jarvis DB has no budget cache table yet (app not upgraded / never scraped). */
  budgetCacheAvailable: boolean;
  /** Other groups that also matched the query, best first. */
  candidates: Array<{ id: number; name: string; matchScore: number }>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasTable(db: SqlJsDatabase, table: string): boolean {
  const stmt = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
  stmt.bind([table]);
  try {
    return stmt.step();
  } finally {
    stmt.free();
  }
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/** Fuzzy name scorer, same heuristic the Groups plugin uses for Ruddr matching. */
export function scoreNameMatch(query: string, candidate: string): number {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (c === q) return 1.0;
  if (c.includes(q) || q.includes(c)) return 0.9;
  const qTokens = q.split(' ').filter(Boolean);
  const cTokens = c.split(' ').filter(Boolean);
  const exact = qTokens.filter((t) => cTokens.includes(t)).length;
  if (exact > 0) return 0.5 + (exact / Math.max(qTokens.length, cTokens.length)) * 0.35;
  const partial = qTokens.some((qt) => cTokens.some((ct) => ct.startsWith(qt) || qt.startsWith(ct)));
  if (partial) return 0.2;
  return 0;
}

/** Parse a scraped Ruddr number such as "1.234,5", "1,234.5", "-12" or "€ 500". */
export function parseRuddrNumber(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: whichever comes last is the decimal separator.
    s = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')   // "1.234,5"
      : s.replace(/,/g, '');                      // "1,234.5"
  } else if (lastComma >= 0) {
    // Only commas: "1,000" / "12,345,678" are thousands groups (Ruddr's US
    // formatting); anything else such as "1,5" is a decimal comma.
    const groups = s.split(',');
    const thousands = groups.length > 1 && groups.slice(1).every((g) => g.length === 3);
    s = thousands ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  // Only dots (or neither): already a JS-parsable number, e.g. "1.5" or "800".
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

interface BudgetRow {
  project_name: string;
  project_url: string | null;
  actual_billable_hours: string | null;
  actual_non_billable_hours: string | null;
  actual_total_hours: string | null;
  budget: string | null;
  budget_left: string | null;
  note: string | null;
  cloud_folder_url: string | null;
  fetched_at: string | null;
}

interface ProjectRef {
  name: string;
  path: string | null;
  note: string | null;
  cloudFolderUrl: string | null;
}

const BUDGET_COLUMNS =
  'project_name, project_url, actual_billable_hours, actual_non_billable_hours, actual_total_hours, ' +
  'budget, budget_left, note, cloud_folder_url, fetched_at';

function toProjectBudget(project: ProjectRef, b: BudgetRow | null): RuddrProjectBudget {
  const budgetHours = parseRuddrNumber(b?.budget);
  const budgetLeftHours = parseRuddrNumber(b?.budget_left);
  const actualTotal = parseRuddrNumber(b?.actual_total_hours);
  let utilization: number | null = null;
  if (budgetHours !== null && budgetHours > 0) {
    if (budgetLeftHours !== null) utilization = (budgetHours - budgetLeftHours) / budgetHours;
    else if (actualTotal !== null) utilization = actualTotal / budgetHours;
  }
  let overBudget: boolean | null = null;
  if (budgetLeftHours !== null) overBudget = budgetLeftHours < 0;
  else if (utilization !== null) overBudget = utilization > 1;
  return {
    projectName: project.name,
    projectPath: project.path,
    projectUrl: b?.project_url ?? (project.path ? `https://www.ruddr.io${project.path}` : null),
    note: b?.note ?? project.note,
    cloudFolderUrl: b?.cloud_folder_url ?? project.cloudFolderUrl,
    actualBillableHours: b?.actual_billable_hours ?? null,
    actualNonBillableHours: b?.actual_non_billable_hours ?? null,
    actualTotalHours: b?.actual_total_hours ?? null,
    budget: b?.budget ?? null,
    budgetLeft: b?.budget_left ?? null,
    budgetHours,
    budgetLeftHours,
    actualTotalHoursNumber: actualTotal,
    utilization,
    overBudget,
    fetchedAt: b?.fetched_at ?? null,
  };
}

function loadBudgetsByName(db: SqlJsDatabase, names: string[]): Map<string, BudgetRow> {
  const map = new Map<string, BudgetRow>();
  if (names.length === 0 || !hasTable(db, 'ruddr_budgets')) return map;
  const stmt = db.prepare(
    `SELECT ${BUDGET_COLUMNS} FROM ruddr_budgets
     WHERE lower(project_name) IN (${names.map(() => 'lower(?)').join(',')})`,
  );
  stmt.bind(names);
  try {
    while (stmt.step()) {
      const r = stmt.getAsObject() as unknown as BudgetRow;
      map.set(r.project_name.toLowerCase(), r);
    }
  } finally {
    stmt.free();
  }
  return map;
}

function summarize(projects: RuddrProjectBudget[]): CustomerBudgetSummary['totals'] {
  let budgetHours = 0;
  let budgetLeftHours = 0;
  let actualTotalHours = 0;
  let projectsWithBudget = 0;
  for (const p of projects) {
    if (p.budgetHours !== null && p.budgetHours > 0) {
      projectsWithBudget++;
      budgetHours += p.budgetHours;
      budgetLeftHours += p.budgetLeftHours ?? 0;
    }
    actualTotalHours += p.actualTotalHoursNumber ?? 0;
  }
  const utilization = budgetHours > 0 ? (budgetHours - budgetLeftHours) / budgetHours : null;
  return { budgetHours, budgetLeftHours, actualTotalHours, utilization, projectsWithBudget };
}

// ── Queries ───────────────────────────────────────────────────────────────────

/** All cached Ruddr budgets, with parsed utilization. Empty when the cache table does not exist yet. */
export function listRuddrBudgets(db: SqlJsDatabase): RuddrProjectBudget[] {
  if (!hasTable(db, 'ruddr_budgets')) return [];
  const projectsByName = new Map(listRuddrProjects(db).map((p) => [p.name.toLowerCase(), p]));
  const stmt = db.prepare(`SELECT ${BUDGET_COLUMNS} FROM ruddr_budgets ORDER BY project_name COLLATE NOCASE`);
  const out: RuddrProjectBudget[] = [];
  try {
    while (stmt.step()) {
      const b = stmt.getAsObject() as unknown as BudgetRow;
      const p = projectsByName.get(b.project_name.toLowerCase());
      out.push(toProjectBudget(
        { name: b.project_name, path: p?.path ?? null, note: p?.note ?? null, cloudFolderUrl: p?.cloudFolderUrl ?? null },
        b,
      ));
    }
  } finally {
    stmt.free();
  }
  return out;
}

/**
 * Resolve a customer name to a Jarvis group (fuzzy), then return budget and
 * actuals for every Ruddr project linked to that group. When no group matches,
 * fall back to Ruddr projects whose name matches the query directly.
 */
export function getCustomerBudget(db: SqlJsDatabase, customerName: string): CustomerBudgetSummary {
  const budgetCacheAvailable = hasTable(db, 'ruddr_budgets');
  const scored = listGroupsWithRuddr(db)
    .map((g) => ({ id: g.id, name: g.name, matchScore: scoreNameMatch(customerName, g.name), group: g }))
    .filter((g) => g.matchScore > 0)
    .sort((a, b) => b.matchScore - a.matchScore);
  const candidates = scored.slice(0, 5).map(({ id, name, matchScore }) => ({ id, name, matchScore }));

  const allProjects = listRuddrProjects(db);
  const projectsByName = new Map(allProjects.map((p) => [p.name.toLowerCase(), p]));

  let resolution: CustomerBudgetSummary['resolution'] = 'none';
  let customer: CustomerBudgetSummary['customer'] = null;
  let selected: ProjectRef[] = [];

  const best = scored[0];
  if (best && best.matchScore >= 0.5) {
    resolution = 'group';
    customer = { id: best.id, name: best.name, matchScore: best.matchScore };
    const names = new Set(best.group.ruddrProjectNames);
    for (const p of allProjects) {
      if (best.group.ruddrProjectPaths.includes(p.path)) names.add(p.name);
    }
    selected = [...names].map((n) => {
      const p = projectsByName.get(n.toLowerCase());
      return { name: p?.name ?? n, path: p?.path ?? null, note: p?.note ?? null, cloudFolderUrl: p?.cloudFolderUrl ?? null };
    });
  } else {
    const matches = allProjects
      .map((p) => ({ p, score: scoreNameMatch(customerName, p.name) }))
      .filter((m) => m.score >= 0.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    if (matches.length > 0) {
      resolution = 'project';
      selected = matches.map(({ p }) => ({ name: p.name, path: p.path, note: p.note, cloudFolderUrl: p.cloudFolderUrl }));
    }
  }

  const budgets = loadBudgetsByName(db, selected.map((s) => s.name));
  const projects = selected
    .map((s) => toProjectBudget(s, budgets.get(s.name.toLowerCase()) ?? null))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));

  return { customer, resolution, projects, totals: summarize(projects), budgetCacheAvailable, candidates };
}
