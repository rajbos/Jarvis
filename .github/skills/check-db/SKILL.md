---
name: check-db
description: Inspect the live Jarvis SQLite database to check the schema migration version and list all tables. Use this when verifying a migration ran correctly, checking what tables exist before writing a new migration, confirming the user_version matches the expected schema, or debugging "table not found" errors at runtime.
argument-hint: "[optional: describe what to verify]"
---

# Check Jarvis Database

Run `check-db.js` from the repo root to inspect `%APPDATA%\jarvis\jarvis.db` without starting the app.

## How to run

```shell
node check-db.js
```

## What it outputs

- `user_version` — the current schema migration number (set by `PRAGMA user_version` in `src/storage/schema.ts`)
- `tables` — comma-separated list of all tables in `sqlite_master`

## Example output

```
user_version: 3
tables: chat_messages, github_repos, notifications, secrets, settings
```

## When to use this skill

| Situation | What to look for |
|-----------|-----------------|
| After changing `src/storage/schema.ts` | `user_version` incremented; new table/column exists |
| Before adding a migration | Confirm current `user_version` so the next one is `N+1` |
| "Table not found" error at runtime | Check whether the table is actually present |
| Suspecting a corrupt or stale DB | See all tables at a glance |

## Script source

The full script is at [check-db.js](./check-db.js) in this skill folder:

```js
const initSqlJs = require('./node_modules/sql.js');
const fs = require('fs');
const path = require('path');
const dbPath = path.join(process.env.APPDATA, 'jarvis', 'jarvis.db');
initSqlJs().then(SQL => {
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);
  const ver = db.exec('PRAGMA user_version')[0].values[0][0];
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  const tableNames = tables.length > 0 ? tables[0].values.map(r => r[0]) : [];
  console.log('user_version:', ver);
  console.log('tables:', tableNames.join(', '));
  db.close();
});
```
