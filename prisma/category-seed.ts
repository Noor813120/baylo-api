// The 19 Category rows: reference data, not user data (see the Category model).
//
// The migration 20261008000000_category_lookup_table seeds them on any
// database built by migrations (live, drills, rehearsal copies). A schema
// built by `prisma db push` gets none, and then every listing insert fails its
// foreign key, so prisma/seed.ts and scripts/seed-categories.ts (called by
// scripts/scratch.ps1 after every push) put them in from here.
//
// Built from CATEGORY_VALUES (order = sortOrder) and CATEGORY_LABELS, the
// lists the API validates and labels with, so a push-built schema can never
// disagree with the code. scripts/verify-category-table.ts checks that the
// migration's hard-coded rows equal this list too, once the removal below is
// applied to them.
//
// REMOVED (16 Oct 2026): SERVICES. The migration still seeds it -- an applied
// migration is never edited -- so a schema built by migrations ALONE starts
// with 20 rows. A restore from a dump does not: pg-backup clears the seeded
// rows and loads the dump's own. Live lost it to scripts/apply-remove-services.ts,
// which also moved OTHER from sortOrder 20 to 19.
import type { PrismaClient } from "@/generated/prisma/client"
import { CATEGORY_VALUES, REMOVED_CATEGORY_IDS } from "../src/lib/validation"
import { CATEGORY_LABELS } from "../src/lib/v1/taxonomy"

export const CATEGORY_SEED: readonly { id: string; label: string; sortOrder: number }[] =
  CATEGORY_VALUES.map((id, i) => ({ id, label: CATEGORY_LABELS[id], sortOrder: i + 1 }))

/**
 * Idempotent: removes withdrawn codes, inserts missing rows, and brings an
 * existing row's label and order in line. The removal comes FIRST: sortOrder is
 * unique, and OTHER's new 19 is SERVICES's old one. A withdrawn code still in
 * use makes the delete fail on its RESTRICT foreign key, which is the right
 * answer: that schema needs apply-remove-services.ts, not a seed.
 */
export async function seedCategories(db: Pick<PrismaClient, "category">): Promise<number> {
  await db.category.deleteMany({ where: { id: { in: [...REMOVED_CATEGORY_IDS] } } })
  for (const c of CATEGORY_SEED) {
    await db.category.upsert({ where: { id: c.id }, create: c, update: { label: c.label, sortOrder: c.sortOrder } })
  }
  return CATEGORY_SEED.length
}
