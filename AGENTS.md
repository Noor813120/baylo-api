<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Branches: the defense server runs `integration/defense`

The defense server runs `integration/defense` in BOTH repos (this API and baylo-mobile).

- Finished features merge INTO `integration/defense` with `git merge --no-ff` (a real merge commit). No rebase, no force-push.
- `main` is merged later, with the team. Do not merge `integration/defense` into `main`, or `main` into it, on your own.

## Schema freeze until the defense (since 11 Oct 2026)

The database stays at **28 tables + 1 view** (`ItemWantedCategorySummary`). NO new tables, views or columns, and no new migration folder after `20261008100000_item_wanted_category_summary_view`.

- If a fix seems to need a schema change, STOP and tell the owner first. Find a way without one.
- `npx tsx scripts/verify-schema-freeze.ts` fails if `prisma/schema.prisma` has more or fewer than 28 models, gains a `view` block or a field, or if a migration folder appears after that one. Run it before every commit that touches `prisma/`.
