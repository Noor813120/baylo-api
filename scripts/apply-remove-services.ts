// Remove the SERVICES listing category (16 Oct 2026): a DATA change on the
// Category lookup table, not a schema change -- no table, column, view or
// migration folder (the schema freeze; see AGENTS.md). Rehearse it on a
// scratch copy of a backup, apply it, and reverse it, each as ONE guarded
// transaction through scripts/lib/migration-runner.ts.
//
//   npx tsx --env-file=.env scripts/apply-remove-services.ts build-scratch <backup.sql> --target scratch_noservices [--replace]
//   npx tsx --env-file=.env scripts/apply-remove-services.ts counts  --target <schema>
//   npx tsx --env-file=.env scripts/apply-remove-services.ts forward --target <schema> [--backup <file>] [--confirm-live-migrate]
//   npx tsx --env-file=.env scripts/apply-remove-services.ts reverse --target <schema> --snapshot <file> [--confirm-live-rollback]
//
// --target IS REQUIRED and has no default, so forgetting it can never mean
// live. It is `public` (LIVE) or a scratch_* schema. DATABASE_URL must not
// carry ?schema=.
//
// FORWARD, in one transaction, after locking Item, ItemWantedCategory and
// Category NOWAIT (an app mid-request makes it refuse, not wait):
//   1  Item.categoryId SERVICES -> OTHER (Miscellaneous). updatedAt is left
//      alone: nobody edited these listings.
//   2  ItemWantedCategory rows for SERVICES deleted. Not converted to OTHER:
//      "looking for services" is not "looking for anything", and a listing
//      that already wants OTHER keeps exactly that one row.
//   3  the SERVICES Category row deleted (RESTRICT now has nothing to refuse).
//   4  OTHER's sortOrder 20 -> 19, so live equals prisma/category-seed.ts,
//      which numbers by position.
// The exact rows it moved and deleted are written to a snapshot JSON (in
// D:\BAYLO\backups) BEFORE COMMIT, so a committed forward always has one.
// Then, BEFORE COMMIT: every table but Category and ItemWantedCategory has its
// count unchanged; Category is exactly CATEGORY_SEED (19 rows: code, label,
// order); ItemWantedCategory lost exactly the snapshot's rows; per category,
// Item counts are unchanged except SERVICES -> 0 and OTHER + the moved ones,
// and ItemWantedCategory counts are unchanged except SERVICES -> 0; the
// summary view names no SERVICES; the Leaves ledger holds with the same
// figures. Any difference throws and the whole thing rolls back.
//
// REVERSE puts back exactly the snapshot's rows: OTHER to 20, the SERVICES
// row at 19, the moved listings back to SERVICES (only those, and only if
// still OTHER), the wanted rows. It asserts the per-category counts and the
// Category rows equal the snapshot's "before". Run it only with code that
// still knows SERVICES (integration/defense before this branch).
//
// LIVE (`--target public`) additionally needs, before anything is opened for
// writing: BAYLO_CUTOVER_LIVE=1 in this shell; for forward, `--backup` naming
// a verified dump whose per-table counts equal live's right now (nothing
// written since); no app connection open; and confirmLiveWrite(): the
// `--confirm-live-migrate` / `--confirm-live-rollback` flag, an interactive
// terminal, and the phrase typed back with its one-time code.
import { Client, types } from "pg"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { LEDGER_INVARIANT_SQL, figuresFromRow, judge, type LedgerJudgement } from "./lib/ledger-invariant"
import {
  GuardError, PRISMA_MIGRATE_LOCK_KEY, confirmLiveWrite, isLiveTarget, isScratchTarget, liveLabel, loadMigration, localMigrationNames,
  prepareBatch, refusePublicUnderStandIn, withGuardedTransaction, type Guarded, type LivePurpose, type LiveWriteAuthorization,
} from "./lib/migration-runner"
import { CATEGORY_SEED } from "../prisma/category-seed"

for (const oid of [1082, 1114, 1083, 1184]) types.setTypeParser(oid, (v) => v)
types.setTypeParser(20, (v) => v)
types.setTypeParser(1700, (v) => v)

const REMOVED = "SERVICES"
const INTO = "OTHER"
const TRAILER = "-- Baylo data dump complete"
const SNAPSHOT_DIR = "D:\\BAYLO\\backups"
/** The layout this runs FROM: the migration's 20 rows. */
const BEFORE_LAYOUT = { removed: { id: REMOVED, label: "Services", sortOrder: 19 }, into: { id: INTO, sortOrder: 20 } }

const argv = process.argv.slice(2)
const cmd = argv[0]
const opt = (n: string) => { const i = argv.indexOf(n); return i === -1 ? undefined : argv[i + 1] }
function die(msg: string): never { console.error(`\n  REFUSING: ${msg}\n`); process.exit(1) }

function targetArg(): string {
  const t = opt("--target")
  if (!t) die("--target is required (public, or a scratch_* schema)")
  try { refusePublicUnderStandIn(t) } catch (e) { die((e as Error).message) }
  if (t !== "public" && !(isScratchTarget(t) && t.startsWith("scratch_"))) die(`--target must be public or a scratch_* schema (got "${t}")`)
  return t
}
function url(): URL {
  const raw = process.env.DATABASE_URL
  if (!raw?.startsWith("postgres")) die("DATABASE_URL is not a Postgres URL")
  const u = new URL(raw)
  if (u.searchParams.get("schema")) die("DATABASE_URL must not carry ?schema=; the schema is --target")
  return u
}
function printTarget(target: string, mode: string) {
  const u = url()
  console.log(`  target  host=${u.hostname}:${u.port || 5432}  database=${u.pathname.slice(1)}  schema=${target} (${isLiveTarget(target) ? liveLabel(target) : "scratch"})  mode=${mode}`)
}
async function connect(readOnly: boolean): Promise<Client> {
  const c = new Client({ connectionString: url().toString(), application_name: "apply-remove-services" })
  await c.connect()
  if (readOnly) {
    await c.query(`SET SESSION default_transaction_read_only = on`)
    if ((await c.query(`SHOW transaction_read_only`)).rows[0].transaction_read_only !== "on") die("could not make the session read-only")
  }
  return c
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>
const qi = (schema: string, t: string) => `"${schema}"."${t}"`

interface Facts {
  tables: Record<string, number>
  /** "id|label|sortOrder", by sortOrder. */
  categories: string[]
  /** "Item:OTHER" -> rows, "Wanted:OTHER" -> rows. */
  perCategory: Record<string, number>
  /** wantedCategoryIds rows in the summary view naming the removed code. */
  viewMentions: number
  ledger: LedgerJudgement
}

async function facts(q: Q, schema: string): Promise<Facts> {
  const names = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename <> '_prisma_migrations' ORDER BY 1`, [schema])).rows.map((r) => String(r.tablename))
  const tables: Record<string, number> = {}
  for (const t of names) tables[t] = Number((await q(`SELECT count(*) AS n FROM ${qi(schema, t)}`)).rows[0].n)
  const categories = (await q(`SELECT id, label, "sortOrder" FROM ${qi(schema, "Category")} ORDER BY "sortOrder"`)).rows.map((r) => `${r.id}|${r.label}|${r.sortOrder}`)
  const perCategory: Record<string, number> = {}
  for (const [t, key] of [["Item", "Item"], ["ItemWantedCategory", "Wanted"]] as const) {
    for (const r of (await q(`SELECT "categoryId" AS c, count(*) AS n FROM ${qi(schema, t)} GROUP BY 1`)).rows) perCategory[`${key}:${r.c}`] = Number(r.n)
  }
  const viewMentions = Number((await q(`SELECT count(*) AS n FROM ${qi(schema, "ItemWantedCategorySummary")} WHERE $1 = ANY("wantedCategoryIds")`, [REMOVED])).rows[0].n)
  const ledger = judge(figuresFromRow((await q(LEDGER_INVARIANT_SQL(schema, "v2"))).rows[0] as Record<string, string>))
  return { tables, categories, perCategory, viewMentions, ledger }
}

function printFacts(label: string, f: Facts) {
  const total = Object.values(f.tables).reduce((a, b) => a + b, 0)
  console.log(`\n  ── ${label}: ${Object.keys(f.tables).length} tables, ${total} rows; Category ${f.categories.length} rows; summary-view rows naming ${REMOVED}: ${f.viewMentions}`)
  console.log(`  ${Object.entries(f.tables).map(([t, n]) => `${t}=${n}`).join(" ")}`)
  const cats = [...new Set(Object.keys(f.perCategory).map((k) => k.split(":")[1]))].sort()
  console.log(`  per category (Item / ItemWantedCategory): ${cats.map((c) => `${c} ${f.perCategory[`Item:${c}`] ?? 0}/${f.perCategory[`Wanted:${c}`] ?? 0}`).join(", ") || "(none)"}`)
  console.log(`  categories: ${f.categories.map((c) => c.split("|").filter((_, i) => i !== 1).join("@")).join(" ")}`)
  console.log(`  ledger: ${f.ledger.lines.join("; ")}`)
}

const fig = (l: LedgerJudgement) => JSON.stringify([l.userLeaves, l.ledger, l.escrow, l.issuance])
const n = (f: Facts, k: string) => f.perCategory[k] ?? 0

/** Every table except `skip` has the same count; ledger holds with the same figures. */
function untouched(before: Facts, after: Facts, skip: string[]): string[] {
  const why: string[] = []
  const keys = (f: Facts) => Object.keys(f.tables).sort().join(",")
  if (keys(before) !== keys(after)) why.push(`table set changed: ${keys(before)} -> ${keys(after)}`)
  for (const t of Object.keys(before.tables)) if (!skip.includes(t) && before.tables[t] !== after.tables[t]) why.push(`${t} ${before.tables[t]} -> ${after.tables[t]}`)
  if (!after.ledger.ok) why.push(`ledger broken: ${after.ledger.lines.join("; ")}`)
  if (fig(before.ledger) !== fig(after.ledger)) why.push("ledger figures changed")
  return why
}

function readBackup(file: string) {
  if (!file || !existsSync(file)) die(`no such backup: ${file}`)
  const sql = readFileSync(file, "utf8")
  if (!sql.includes(TRAILER)) die("the backup has no trailer; it is truncated")
  const claimed = Object.fromEntries((/-- rowcounts: (.*)/.exec(sql)?.[1] ?? "").split(/\s+/).filter(Boolean).map((p) => { const [t, c] = p.split("="); return [t, Number(c)] }))
  const migrations = (/^-- migrations\s+(.*)$/m.exec(sql)?.[1] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== "(none recorded)")
  return { sql, claimed: claimed as Record<string, number>, migrations }
}

/** Live only: refuse while an app server holds a connection (same filter as apply-category-lookup.ts). */
async function appConnections(pg: Client) {
  return (await pg.query(`SELECT pid, application_name, state FROM pg_stat_activity
     WHERE datname = current_database() AND usename = 'postgres' AND pid <> pg_backend_pid() AND application_name NOT LIKE 'pg_net%'`)).rows
}

// ── build-scratch ───────────────────────────────────────────────────────────

const PRISMA_MIGRATIONS_DDL = `CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`

async function buildScratch() {
  const file = argv[1]
  const target = targetArg()
  if (isLiveTarget(target)) die("build-scratch never targets live")
  const { sql, claimed, migrations } = readBackup(file)
  const local = new Set(await localMigrationNames())
  const missing = migrations.filter((m) => !local.has(m))
  if (!migrations.length || missing.length) die(`the backup's migrations are not all in this repo: ${missing.join(", ") || "(none listed)"}`)
  if (!("Category" in claimed)) die("the backup carries no Category rows; it predates the lookup table")
  const chain = await Promise.all(migrations.map(loadMigration))
  const data = prepareBatch(file, "data", sql)

  printTarget(target, `BUILD from ${file}`)
  const pg = await connect(false)
  try {
    await withGuardedTransaction(pg, { target, create: argv.includes("--replace") ? "replace" : "fresh" }, async (g) => {
      for (const m of chain) await g.run(m.batch)
      // The category migration seeded its 20 rows; the dump carries Category in
      // full and is the truth (the same rule as pg-backup.ts clearSeeded()).
      await g.query(`DELETE FROM "Category"`)
      await g.run(data)
      await g.query(PRISMA_MIGRATIONS_DDL)
      for (const m of chain) {
        await g.query(`INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
           VALUES ($1, $2, clock_timestamp(), $3, NULL, NULL, clock_timestamp(), 1)`, [randomUUID(), m.checksum, m.name])
      }
      const f = await facts((s, p) => g.query(s, p), target)
      const off = Object.keys(claimed).filter((t) => f.tables[t] !== claimed[t])
      if (off.length || Object.keys(f.tables).length !== Object.keys(claimed).length) throw new GuardError(`restored counts differ from the backup: ${off.map((t) => `${t} file ${claimed[t]} got ${f.tables[t]}`).join(", ") || "table set differs"}`)
      if (!f.ledger.ok) throw new GuardError(`ledger broken in the copy: ${f.ledger.lines.join("; ")}`)
      console.log(`  built "${target}": ${chain.length} migrations recorded, ${Object.keys(f.tables).length} tables equal the backup's trailer`)
      printFacts("COPY (= backup)", f)
    })
    console.log(`\n  BUILT ${target}`)
  } finally { await pg.end() }
}

// ── counts ──────────────────────────────────────────────────────────────────

async function counts() {
  const target = targetArg()
  printTarget(target, "READ-ONLY")
  const pg = await connect(true)
  try {
    await pg.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const q: Q = (s, p) => pg.query(s, p)
    printFacts(target, await facts(q, target))
    const wanted = (await q(`SELECT w."itemId", i.title, i.status, (SELECT count(*) FROM ${qi(target, "ItemWantedCategory")} x WHERE x."itemId" = w."itemId") AS total
       FROM ${qi(target, "ItemWantedCategory")} w JOIN ${qi(target, "Item")} i ON i.id = w."itemId" WHERE w."categoryId" = $1`, [REMOVED])).rows
    const items = (await q(`SELECT id, title, status, "userId" FROM ${qi(target, "Item")} WHERE "categoryId" = $1`, [REMOVED])).rows
    console.log(`\n  listings in ${REMOVED}: ${items.length}${items.map((r) => `\n    ${r.id} "${r.title}" ${r.status} owner ${r.userId}`).join("")}`)
    console.log(`  wanted rows naming ${REMOVED}: ${wanted.length}${wanted.map((r) => `\n    ${r.itemId} "${r.title}" ${r.status}, wants ${r.total} categories${Number(r.total) === 1 ? "  <- WOULD BE LEFT WITH NONE" : ""}`).join("")}`)
    await pg.query("ROLLBACK")
  } finally { await pg.end() }
}

// ── forward / reverse ───────────────────────────────────────────────────────

interface Snapshot {
  kind: "remove-services"
  target: string
  takenAt: string
  /** The Category row deleted, and OTHER's order before. */
  removedCategory: { id: string; label: string; sortOrder: number }
  intoSortOrderBefore: number
  /** Listings moved SERVICES -> OTHER. */
  movedItemIds: string[]
  /** ItemWantedCategory rows deleted. */
  deletedWantedItemIds: string[]
  /** Listings that wanted something before and nothing after. */
  leftWithNoWanted: string[]
  before: { categories: string[]; perCategory: Record<string, number> }
}

async function preconditions(target: string, purpose: LivePurpose): Promise<LiveWriteAuthorization | undefined> {
  if (!isLiveTarget(target)) return undefined
  if (process.env.BAYLO_CUTOVER_LIVE !== "1") die("BAYLO_CUTOVER_LIVE=1 is not set in this shell")
  // Read-only preconditions first: nothing is opened for writing until they pass.
  const ro = await connect(true)
  try {
    if (purpose === "migrate") {
      const f = await facts((s, p) => ro.query(s, p), target)
      const { claimed } = readBackup(opt("--backup") ?? "")
      const drift = Object.keys(claimed).filter((t) => f.tables[t] !== claimed[t])
      if (drift.length || Object.keys(claimed).length !== Object.keys(f.tables).length) die(`live differs from the backup (take a new one): ${drift.map((t) => `${t} ${claimed[t]}->${f.tables[t]}`).join(", ") || "table set differs"}`)
      console.log(`  backup matches live: ${Object.keys(claimed).length} tables equal`)
    }
    const apps = await appConnections(ro)
    if (apps.length) die(`${apps.length} app connection(s) open (stop the dev server gracefully first): ${apps.map((a) => `${a.pid} ${a.application_name || "-"} ${a.state}`).join("; ")}`)
  } finally { await ro.end() }
  try { return await confirmLiveWrite(purpose, url().hostname, target) } catch (e) { die((e as Error).message) }
}

async function inTransaction(target: string, purpose: LivePurpose, label: string, body: (g: Guarded, q: Q) => Promise<void>) {
  const live = await preconditions(target, purpose)
  const pg = await connect(false)
  const t0 = Date.now()
  try {
    await withGuardedTransaction(pg, { target, live, purpose: live ? purpose : undefined, lockTimeout: "5s" }, async (g) => {
      await g.query(`SELECT pg_advisory_xact_lock($1)`, [PRISMA_MIGRATE_LOCK_KEY])
      await g.query(`LOCK TABLE "Item", "ItemWantedCategory", "Category" IN ACCESS EXCLUSIVE MODE NOWAIT`)
      await body(g, (s, p) => g.query(s, p))
    })
    console.log(`\n  ${label} COMMITTED on ${target} in ${Date.now() - t0} ms (one transaction)`)
  } catch (e) {
    console.error(`\n  ${label} ROLLED BACK after ${Date.now() - t0} ms; ${target} is exactly as it was: ${(e as Error).message}`)
    process.exitCode = 1
  } finally {
    await pg.end().catch(() => {})
  }
}

const SEED_ROWS = CATEGORY_SEED.map((c) => `${c.id}|${c.label}|${c.sortOrder}`)

async function forward() {
  const target = targetArg()
  printTarget(target, "FORWARD")
  await inTransaction(target, "migrate", "FORWARD", async (g, q) => {
    const before = await facts(q, target)
    printFacts("BEFORE", before)
    const has = (id: string, order: number) => before.categories.some((c) => c.startsWith(`${id}|`) && c.endsWith(`|${order}`))
    if (!has(REMOVED, BEFORE_LAYOUT.removed.sortOrder) || !has(INTO, BEFORE_LAYOUT.into.sortOrder) || before.categories.length !== 20) {
      throw new GuardError(`not the 20-row layout this runs from (already applied?): ${before.categories.length} rows`)
    }

    const removedRow = (await q(`SELECT id, label, "sortOrder" FROM "Category" WHERE id = $1`, [REMOVED])).rows[0]
    const movedItemIds = (await q(`SELECT id FROM "Item" WHERE "categoryId" = $1 ORDER BY id`, [REMOVED])).rows.map((r) => String(r.id))
    const deletedWantedItemIds = (await q(`SELECT "itemId" FROM "ItemWantedCategory" WHERE "categoryId" = $1 ORDER BY "itemId"`, [REMOVED])).rows.map((r) => String(r.itemId))
    const leftWithNoWanted = (await q(`SELECT w."itemId" FROM "ItemWantedCategory" w WHERE w."categoryId" = $1
       AND NOT EXISTS (SELECT 1 FROM "ItemWantedCategory" x WHERE x."itemId" = w."itemId" AND x."categoryId" <> $1) ORDER BY 1`, [REMOVED])).rows.map((r) => String(r.itemId))
    console.log(`\n  to move to ${INTO}: ${movedItemIds.length} listing(s) ${movedItemIds.join(", ")}`)
    console.log(`  wanted rows to delete: ${deletedWantedItemIds.length} ${deletedWantedItemIds.join(", ")}`)
    console.log(`  listings left wanting nothing: ${leftWithNoWanted.length} ${leftWithNoWanted.join(", ")}`)

    const moved = await q(`UPDATE "Item" SET "categoryId" = $2 WHERE "categoryId" = $1`, [REMOVED, INTO])
    if (moved.rowCount !== movedItemIds.length) throw new GuardError(`moved ${moved.rowCount} listings, expected ${movedItemIds.length}`)
    const unwanted = await q(`DELETE FROM "ItemWantedCategory" WHERE "categoryId" = $1`, [REMOVED])
    if (unwanted.rowCount !== deletedWantedItemIds.length) throw new GuardError(`deleted ${unwanted.rowCount} wanted rows, expected ${deletedWantedItemIds.length}`)
    const gone = await q(`DELETE FROM "Category" WHERE id = $1`, [REMOVED])
    if (gone.rowCount !== 1) throw new GuardError(`deleted ${gone.rowCount} Category rows, expected 1`)
    const renumbered = await q(`UPDATE "Category" SET "sortOrder" = $2 WHERE id = $1 AND "sortOrder" = $3`, [INTO, BEFORE_LAYOUT.removed.sortOrder, BEFORE_LAYOUT.into.sortOrder])
    if (renumbered.rowCount !== 1) throw new GuardError(`renumbered ${renumbered.rowCount} rows, expected 1`)

    const after = await facts(q, target)
    printFacts("AFTER (inside the transaction)", after)
    const why = untouched(before, after, ["Category", "ItemWantedCategory"])
    if (after.tables.Category !== before.tables.Category - 1) why.push(`Category ${before.tables.Category} -> ${after.tables.Category}`)
    if (after.tables.ItemWantedCategory !== before.tables.ItemWantedCategory - deletedWantedItemIds.length) why.push(`ItemWantedCategory ${before.tables.ItemWantedCategory} -> ${after.tables.ItemWantedCategory}`)
    if (JSON.stringify(after.categories) !== JSON.stringify(SEED_ROWS)) why.push(`Category rows != CATEGORY_SEED: ${after.categories.join(",")}`)
    for (const k of new Set([...Object.keys(before.perCategory), ...Object.keys(after.perCategory)])) {
      const expect = k.endsWith(`:${REMOVED}`) ? 0 : k === `Item:${INTO}` ? n(before, k) + movedItemIds.length : n(before, k)
      if (n(after, k) !== expect) why.push(`${k} ${n(before, k)} -> ${n(after, k)}, expected ${expect}`)
    }
    if (after.viewMentions !== 0) why.push(`the summary view still names ${REMOVED} on ${after.viewMentions} rows`)
    if (why.length) throw new GuardError(`post-checks failed: ${why.join("; ")}`)

    const snapshot: Snapshot = {
      kind: "remove-services", target, takenAt: new Date().toISOString(),
      removedCategory: { id: String(removedRow.id), label: String(removedRow.label), sortOrder: Number(removedRow.sortOrder) },
      intoSortOrderBefore: BEFORE_LAYOUT.into.sortOrder,
      movedItemIds, deletedWantedItemIds, leftWithNoWanted,
      before: { categories: before.categories, perCategory: before.perCategory },
    }
    // Written BEFORE COMMIT: a committed forward without its reverse file
    // cannot happen. A failed commit leaves a file whose reverse refuses (the
    // 20-row layout is still there).
    const file = `${SNAPSHOT_DIR}\\remove-services-${target}-${snapshot.takenAt.replace(/[-:]/g, "").replace(/\..*$/, "")}.json`
    writeFileSync(file, JSON.stringify(snapshot, null, 2))
    console.log(`\n  post-checks passed: Category = CATEGORY_SEED (19), ${movedItemIds.length} moved, ${deletedWantedItemIds.length} wanted row(s) deleted, every other table unchanged, ledger as before`)
    console.log(`  snapshot for reverse: ${file}`)
  })
}

async function reverse() {
  const target = targetArg()
  const file = opt("--snapshot")
  if (!file || !existsSync(file)) die(`--snapshot <file> is required and must exist (got ${file ?? "nothing"})`)
  const snap = JSON.parse(readFileSync(file, "utf8")) as Snapshot
  if (snap.kind !== "remove-services") die("that file is not a remove-services snapshot")
  if (snap.target !== target) die(`the snapshot was taken on "${snap.target}", not "${target}"`)
  printTarget(target, `REVERSE from ${file}`)
  await inTransaction(target, "rollback", "REVERSE", async (g, q) => {
    const before = await facts(q, target)
    printFacts("BEFORE", before)
    if (JSON.stringify(before.categories) !== JSON.stringify(SEED_ROWS)) throw new GuardError(`not the 19-row layout (nothing to reverse?): ${before.categories.join(",")}`)

    const r1 = await q(`UPDATE "Category" SET "sortOrder" = $2 WHERE id = $1 AND "sortOrder" = $3`, [INTO, snap.intoSortOrderBefore, snap.removedCategory.sortOrder])
    if (r1.rowCount !== 1) throw new GuardError(`renumbered ${r1.rowCount} rows, expected 1`)
    await q(`INSERT INTO "Category" (id, label, "sortOrder") VALUES ($1, $2, $3)`, [snap.removedCategory.id, snap.removedCategory.label, snap.removedCategory.sortOrder])
    if (snap.movedItemIds.length) {
      const r2 = await q(`UPDATE "Item" SET "categoryId" = $1 WHERE id = ANY($2::text[]) AND "categoryId" = $3`, [REMOVED, snap.movedItemIds, INTO])
      if (r2.rowCount !== snap.movedItemIds.length) throw new GuardError(`moved back ${r2.rowCount} listings, expected ${snap.movedItemIds.length} (one was deleted or recategorised since)`)
    }
    if (snap.deletedWantedItemIds.length) {
      const r3 = await q(`INSERT INTO "ItemWantedCategory" ("itemId", "categoryId") SELECT unnest($1::text[]), $2`, [snap.deletedWantedItemIds, REMOVED])
      if (r3.rowCount !== snap.deletedWantedItemIds.length) throw new GuardError(`restored ${r3.rowCount} wanted rows, expected ${snap.deletedWantedItemIds.length}`)
    }

    const after = await facts(q, target)
    printFacts("AFTER (inside the transaction)", after)
    const why = untouched(before, after, ["Category", "ItemWantedCategory"])
    if (JSON.stringify(after.categories) !== JSON.stringify(snap.before.categories)) why.push(`Category rows != the snapshot's before: ${after.categories.join(",")}`)
    for (const k of new Set([...Object.keys(snap.before.perCategory), ...Object.keys(after.perCategory)])) {
      if ((snap.before.perCategory[k] ?? 0) !== n(after, k)) why.push(`${k} ${snap.before.perCategory[k] ?? 0} before forward, ${n(after, k)} now`)
    }
    if (why.length) throw new GuardError(`post-checks failed: ${why.join("; ")}`)
    console.log(`\n  post-checks passed: Category and every per-category count equal the snapshot's before, every other table unchanged, ledger as before`)
  })
}

const run =
  cmd === "build-scratch" ? buildScratch()
  : cmd === "counts" ? counts()
  : cmd === "forward" ? forward()
  : cmd === "reverse" ? reverse()
  : die("usage: apply-remove-services.ts build-scratch <backup> --target scratch_x [--replace] | counts --target <s> | forward --target <s> [--backup <file>] [--confirm-live-migrate] | reverse --target <s> --snapshot <file> [--confirm-live-rollback]")
run.catch((e) => { console.error(`\n  FAILED: ${(e as Error).message}\n`); process.exit(1) })
