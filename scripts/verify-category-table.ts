// The Category table, its labels, and the code that still sends them.
//
//   npx tsx --env-file=.env scripts/verify-category-table.ts            (static checks + the schema in DATABASE_URL)
//   npx tsx --env-file=.env scripts/verify-category-table.ts --static   (files only; no database)
//
// The API sends CATEGORY_LABELS from src/lib/v1/taxonomy.ts, and the Category
// table holds a label too. Two copies can drift, so this fails if they do:
//   STATIC  CATEGORY_SEED (taxonomy + validation, 19 since SERVICES was
//           removed on 16 Oct 2026) == the rows the migration hard-codes and
//           the enum the rollback file recreates, each minus the removed
//           codes, in order.
//   DB      READ-ONLY. The Category rows in the target schema == CATEGORY_SEED;
//           the enum is gone; Item and ItemWantedCategory reference only known
//           codes; the foreign keys and RESTRICT are in place.
import "dotenv/config"
import { Client } from "pg"
import { readFileSync } from "node:fs"
import { CATEGORY_SEED } from "../prisma/category-seed"
import { REMOVED_CATEGORY_IDS, categorySchema, createItemSchema, updateItemSchema } from "../src/lib/validation"
import { browseQuerySchema } from "../src/lib/v1/browse-query"
import { targetSchema } from "./lib/live-guard"

const MIGRATION = "20261008000000_category_lookup_table"
let failures = 0
function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`)
  if (!ok) failures++
}
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")
const want = CATEGORY_SEED.map((c) => `${c.id}|${c.label}|${c.sortOrder}`)

function staticChecks() {
  console.log("\n  static")
  check(CATEGORY_SEED.length === 19, "19 categories in CATEGORY_VALUES (SERVICES removed 16 Oct 2026)", String(CATEGORY_SEED.length))
  check(CATEGORY_SEED.every((c) => !(REMOVED_CATEGORY_IDS as readonly string[]).includes(c.id)), "no removed code is still in CATEGORY_VALUES", REMOVED_CATEGORY_IDS.join(","))
  check(CATEGORY_SEED.every((c) => typeof c.label === "string" && c.label.length > 0), "every code has a label in CATEGORY_LABELS")
  check(new Set(CATEGORY_SEED.map((c) => c.label)).size === CATEGORY_SEED.length, "labels are unique (Category_label_key)")

  // The applied migration still seeds the original 20 and is never edited.
  // What has to hold is that ITS rows, with the removal applied the way
  // apply-remove-services.ts applies it (drop the code, renumber by position),
  // are exactly the taxonomy.
  const fwd = read(`prisma/migrations/${MIGRATION}/migration.sql`)
  const seeded = [...fwd.matchAll(/\('([A-Z_]+)', '((?:[^']|'')*)', (\d+)\)/g)]
  check(seeded.length === 20, "the migration still seeds its original 20 rows", String(seeded.length))
  const rows = seeded
    .filter((m) => !(REMOVED_CATEGORY_IDS as readonly string[]).includes(m[1]))
    .map((m, i) => `${m[1]}|${m[2].replace(/''/g, "'")}|${i + 1}`)
  const diff = want.filter((w, i) => rows[i] !== w)
  check(rows.length === want.length && diff.length === 0, "migration seed rows minus removals == taxonomy (code, label, order)", diff.length ? `differs at ${diff.join(", ")}` : `${rows.length} rows`)

  const back = read(`prisma/rollback/${MIGRATION}.sql`)
  const enumList = (/CREATE TYPE "Category_restore" AS ENUM \(([\s\S]*?)\);/.exec(back)?.[1] ?? "").match(/'([A-Z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? []
  const enumKept = enumList.filter((c) => !(REMOVED_CATEGORY_IDS as readonly string[]).includes(c))
  check(JSON.stringify(enumKept) === JSON.stringify(CATEGORY_SEED.map((c) => c.id)), "rollback enum minus removals == CATEGORY_VALUES, same order", enumList.join(","))

  // An app built before the removal still offers SERVICES. Every write path
  // validates with these schemas BEFORE the database is reached, so the answer
  // is a 400 carrying this sentence, never the foreign key's 500.
  const removedMsg = "Services is no longer a category. Pick Miscellaneous or another category."
  const base = { title: "x", description: "x", condition: "NEW", images: [] }
  const create = createItemSchema.safeParse({ ...base, category: "SERVICES" })
  check(!create.success && create.error.issues.some((i) => i.path.join(".") === "category" && i.message === removedMsg), "POST /api/items category SERVICES -> 400 with the removal sentence", create.success ? "accepted" : create.error.issues[0]?.message)
  const wanted = createItemSchema.safeParse({ ...base, category: "OTHER", lookingForCategories: ["BOOKS", "SERVICES"] })
  check(!wanted.success && wanted.error.issues.some((i) => i.message === removedMsg), "lookingForCategories with SERVICES -> 400 with the removal sentence", wanted.success ? "accepted" : wanted.error.issues[0]?.message)
  const patch = updateItemSchema.safeParse({ category: "SERVICES" })
  check(!patch.success && patch.error.issues.some((i) => i.message === removedMsg), "PATCH /api/items/[id] category SERVICES -> 400 with the removal sentence", patch.success ? "accepted" : patch.error.issues[0]?.message)
  const browse = browseQuerySchema.safeParse({ category: "BOOKS,SERVICES" })
  check(!browse.success && browse.error.issues.some((i) => i.message === removedMsg), "browse ?category=…SERVICES -> 400 with the removal sentence", browse.success ? "accepted" : browse.error.issues[0]?.message)
  check(createItemSchema.safeParse({ ...base, category: "OTHER" }).success, "category OTHER is still accepted")
  const bogus = categorySchema.safeParse("BOOSK")
  check(!bogus.success && bogus.error.issues[0]?.message !== removedMsg, "an unknown code keeps zod's own message", bogus.success ? "accepted" : bogus.error.issues[0]?.message)
}

async function dbChecks() {
  const schema = targetSchema()
  console.log(`\n  database, schema "${schema}" (read-only)`)
  const u = new URL(process.env.DATABASE_URL!)
  u.searchParams.delete("schema")
  const pg = new Client({ connectionString: u.toString() })
  await pg.connect()
  try {
    await pg.query("SET SESSION default_transaction_read_only = on")
    await pg.query("BEGIN READ ONLY")
    if ((await pg.query("SHOW transaction_read_only")).rows[0].transaction_read_only !== "on") throw new Error("session is not read-only")
    const s = (t: string) => `"${schema}"."${t}"`
    const got = (await pg.query(`SELECT id, label, "sortOrder" FROM ${s("Category")} ORDER BY "sortOrder"`)).rows.map((r) => `${r.id}|${r.label}|${r.sortOrder}`)
    const off = want.filter((w, i) => got[i] !== w)
    check(got.length === want.length && off.length === 0, "Category rows == taxonomy (code, label, order)", off.length ? `differs at ${off.join(", ")}` : `${got.length} rows`)
    const enumLeft = (await pg.query(`SELECT count(*)::int n FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typname IN ('Category', 'Category_old', 'Category_restore') AND t.typtype = 'e'`, [schema])).rows[0].n
    check(enumLeft === 0, "enum Category is gone from the schema")
    for (const t of ["Item", "ItemWantedCategory"]) {
      const orphan = (await pg.query(`SELECT count(*)::int n FROM ${s(t)} x WHERE NOT EXISTS (SELECT 1 FROM ${s("Category")} c WHERE c.id = x."categoryId")`)).rows[0].n
      check(orphan === 0, `${t}.categoryId all reference Category`, `${orphan} orphan(s)`)
      const fk = (await pg.query(`SELECT confdeltype, confupdtype FROM pg_constraint WHERE conname = $1 AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)`, [`${t}_categoryId_fkey`, schema])).rows[0]
      check(fk?.confdeltype === "r" && fk?.confupdtype === "c", `${t}_categoryId_fkey is ON DELETE RESTRICT ON UPDATE CASCADE`, fk ? `${fk.confdeltype}/${fk.confupdtype}` : "missing")
    }
    const pk = (await pg.query(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname = 'ItemWantedCategory_pkey' AND connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)`, [schema])).rows[0]?.d
    check(pk === 'PRIMARY KEY ("itemId", "categoryId")', "ItemWantedCategory PK is (itemId, categoryId)", pk ?? "missing")
    await pg.query("ROLLBACK")
  } finally { await pg.end() }
}

;(async () => {
  staticChecks()
  if (!process.argv.includes("--static")) await dbChecks()
  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  ALL PASSED\n")
  process.exitCode = failures ? 1 : 0
})().catch((e) => { console.error(`  FAILED: ${(e as Error).message}`); process.exit(1) })
