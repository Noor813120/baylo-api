// The MSME posting gate (fix/msme-post-gate, 16 Oct 2026), IN-PROCESS: POST
// /api/items is imported and called directly, so no dev server is needed.
//
//   $base = (Get-Content .env | ? { $_ -match '^DATABASE_URL=' }) -replace '^DATABASE_URL="?([^"]*)"?$','$1'
//   $env:DATABASE_URL = "${base}?schema=scratch_msme"; $env:PUSHER_SECRET = "invalid-harness"; npx tsx --env-file=.env scripts/verify-msme-post-gate.ts
//
// SCRATCH ONLY (requireScratchSchema). Build the schema first with
// `.\scripts\scratch.ps1 -Push -Name scratch_msme`.
//
// The rule, posting with and without the X-Baylo-Org header:
//   individual, no ID                      403 ID_VERIFICATION_REQUIRED (unchanged)
//   individual, ID verified                201 (unchanged)
//   owner of a PENDING shop, no ID         403 ORG_VERIFICATION_PENDING, not the ID gate
//   owner of a REJECTED shop, no ID        403 ORG_VERIFICATION_REJECTED
//   owner of a VERIFIED shop, no ID        403 ORG_CONTEXT_REQUIRED, and NOTHING posted
//     ...with the header                   201, authored by the shop's backing row
//   owner of a PENDING shop, ID verified   201 as themselves (the personal ID still counts)
//     ...with the header                   403 ORG_VERIFICATION_PENDING (unchanged)
import { asBearer, jsonRequest, read } from "./lib/in-process-routes"
import { requireScratchSchema } from "./lib/live-guard"

requireScratchSchema("scripts/verify-msme-post-gate.ts")

let failures = 0
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${!ok && detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}

async function main() {
  const { default: prisma } = await import("../src/lib/prisma")
  const { createOrganization } = await import("../src/lib/organizations")
  const { signAccessToken } = await import("../src/lib/auth-tokens")
  const { POST } = await import("../src/app/api/items/route")

  const tag = `msmegate${Date.now().toString(36)}`
  const users: string[] = []
  const orgs: string[] = []
  const listing = (title: string) => ({
    title: `${tag} ${title}`, description: "x", category: "FOOD", condition: "NEW", images: [], lookingForCategories: ["PLANTS"],
  })

  async function person(name: string, idVerified: boolean) {
    const u = await prisma.user.create({
      data: { name: `${tag}-${name}`, email: `${tag}-${name}@test.invalid`, isVerified: true, ...(idVerified ? { idVerifiedGrandfatheredAt: new Date() } : {}) },
      select: { id: true },
    })
    users.push(u.id)
    return { id: u.id, token: await signAccessToken(u.id) }
  }
  async function shop(ownerId: string, status: "PENDING" | "VERIFIED" | "REJECTED") {
    const o = await createOrganization({ founderUserId: ownerId, name: `${tag} ${status} Store`, businessCategory: "SARI_SARI" })
    orgs.push(o.organizationId)
    users.push(o.orgUserId)
    await prisma.organization.update({
      where: { id: o.organizationId },
      data: { verificationStatus: status, ...(status === "REJECTED" ? { rejectionReason: "BLURRY_DOCUMENT" } : {}) },
    })
    return o
  }
  async function post(token: string, title: string, orgId?: string) {
    asBearer(token)
    if (orgId) (globalThis as { __inProcessHeaders?: Headers }).__inProcessHeaders!.set("x-baylo-org", orgId)
    return read(await POST(jsonRequest("POST", "/api/items", listing(title))))
  }
  const org = (r: { json: Record<string, unknown> }) => r.json.organization as { id?: string } | undefined

  try {
    console.log("\nindividuals (unchanged)")
    const plain = await person("plain", false)
    const r1 = await post(plain.token, "plain")
    check("no shop, no ID: 403 ID_VERIFICATION_REQUIRED", r1.status === 403 && r1.json.code === "ID_VERIFICATION_REQUIRED", `${r1.status} ${String(r1.json.code)}`)
    const verified = await person("verified", true)
    const r2 = await post(verified.token, "verified")
    check("no shop, ID verified: 201", r2.status === 201, `${r2.status} ${JSON.stringify(r2.json)}`)

    console.log("\nMSME owners without a personal ID, no header")
    const pOwner = await person("pending-owner", false)
    const pShop = await shop(pOwner.id, "PENDING")
    const r3 = await post(pOwner.token, "pending self")
    check("PENDING shop: 403 ORG_VERIFICATION_PENDING (not the ID gate)", r3.status === 403 && r3.json.code === "ORG_VERIFICATION_PENDING", `${r3.status} ${String(r3.json.code)}`)
    check("…naming the shop", org(r3)?.id === pShop.organizationId)
    check("…with the under-review sentence", String(r3.json.error).includes("still under review"), String(r3.json.error))

    const rOwner = await person("rejected-owner", false)
    await shop(rOwner.id, "REJECTED")
    const r4 = await post(rOwner.token, "rejected self")
    check("REJECTED shop: 403 ORG_VERIFICATION_REJECTED", r4.status === 403 && r4.json.code === "ORG_VERIFICATION_REJECTED", `${r4.status} ${String(r4.json.code)}`)

    const vOwner = await person("verified-owner", false)
    const vShop = await shop(vOwner.id, "VERIFIED")
    const r5 = await post(vOwner.token, "verified self")
    check("VERIFIED shop: 403 ORG_CONTEXT_REQUIRED", r5.status === 403 && r5.json.code === "ORG_CONTEXT_REQUIRED", `${r5.status} ${String(r5.json.code)}`)
    check("…naming the shop", org(r5)?.id === vShop.organizationId)
    const silent = await prisma.item.count({ where: { title: `${tag} verified self` } })
    check("…and NOTHING was posted, as the shop or anyone", silent === 0, `count=${silent}`)

    console.log("\nwith the header")
    const r6 = await post(vOwner.token, "verified as shop", vShop.organizationId)
    check("VERIFIED shop, as the shop: 201", r6.status === 201, `${r6.status} ${JSON.stringify(r6.json)}`)
    if (r6.status === 201) {
      const row = await prisma.item.findUnique({ where: { id: String(r6.json.id) }, select: { userId: true } })
      check("…authored by the shop's backing row", row?.userId === vShop.orgUserId, String(row?.userId))
    }
    const r7 = await post(pOwner.token, "pending as shop", pShop.organizationId)
    check("PENDING shop, as the shop: 403 ORG_VERIFICATION_PENDING", r7.status === 403 && r7.json.code === "ORG_VERIFICATION_PENDING", `${r7.status} ${String(r7.json.code)}`)

    console.log("\nan owner WITH a verified personal ID")
    const both = await person("pending-owner-with-id", true)
    const bShop = await shop(both.id, "PENDING")
    const r8 = await post(both.token, "pending owner with id self")
    check("PENDING shop, posting as themselves: 201", r8.status === 201, `${r8.status} ${String(r8.json.code)}`)
    if (r8.status === 201) {
      const row = await prisma.item.findUnique({ where: { id: String(r8.json.id) }, select: { userId: true } })
      check("…authored by the person", row?.userId === both.id, String(row?.userId))
    }
    const r9 = await post(both.token, "pending owner with id as shop", bShop.organizationId)
    check("PENDING shop, as the shop: still 403 ORG_VERIFICATION_PENDING", r9.status === 403 && r9.json.code === "ORG_VERIFICATION_PENDING", `${r9.status} ${String(r9.json.code)}`)
  } finally {
    const itemIds = (await prisma.item.findMany({ where: { userId: { in: users } }, select: { id: true } })).map((i) => i.id)
    await prisma.notification.deleteMany({ where: { entityType: "item", entityId: { in: itemIds } } })
    await prisma.item.deleteMany({ where: { id: { in: itemIds } } })
    await prisma.organization.deleteMany({ where: { id: { in: orgs } } })
    await prisma.user.deleteMany({ where: { id: { in: users } } })
    await prisma.$disconnect()
  }

  console.log(failures ? `\n  ${failures} FAILED\n` : "\n  ALL PASSED\n")
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
