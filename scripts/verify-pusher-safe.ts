// Acceptance harness: a Pusher failure never changes an HTTP response.
//
// ══ THE BUG THIS PINS (found 11 Oct 2026, Category rehearsal) ═══════════════
//
// With Pusher unreachable, "cancel -> 200" failed: the trade was cancelled, the
// fee refunded, the items freed, and the caller got a 500. A retry was refused
// ("cannot be cancelled in its current state"). Decline and web typing did the
// same. Ten more routes were protected only by `.catch(() => {})`, which does
// not see the OTHER way pusher.trigger() fails: with no secret it throws BEFORE
// returning a promise, so confirm/submit answered 500 on a trade it had just
// COMPLETED and paid, and the message route made the phone keep a draft that a
// second tap saved twice. Every trigger now goes through notifyUser() in
// src/lib/realtime.ts.
//
// ══ THREE PARTS ═════════════════════════════════════════════════════════════
//
//   A  STATIC   no `pusher.trigger(` and no import of @/lib/pusher outside
//               src/lib/realtime.ts (and /api/pusher/auth, which signs channel
//               auth and sends nothing). This is what keeps the bug fixed.
//               Also runs scripts/verify-schema-freeze.ts (AGENTS.md).
//   B  HELPER   notifyUser() against a trigger that THROWS, one that REJECTS
//               and the real client against an address that never answers:
//               all three resolve, all three log, the hang ends on the
//               client's timeout. In process; nothing is sent to Pusher.
//   C  HTTP     every route that triggers, over real HTTP against a server
//               whose Pusher is broken. Each must return its normal success
//               AND leave the rows it always left. Run once per mode:
//
//     # window 1 (stop the live server first; see the script's header)
//     .\scripts\scratch-dev-safe.ps1 -Name scratch_pusher -Port 3001                       # REJECTS
//     .\scripts\scratch-dev-safe.ps1 -Name scratch_pusher -Port 3001 -NoPush -PusherSecret unset   # THROWS
//     # window 2, each time
//     $env:DATABASE_URL = "${base}?schema=scratch_pusher"; $env:ACCEPT_BASE = "http://127.0.0.1:3001"
//     npx tsx --env-file=.env scripts/verify-pusher-safe.ts
//
// `--static-only` runs A and B with no server and no database.
//
// Fixtures carry a per-run prefix, so both modes run on one schema without a
// cleanup pass; drop the schema afterwards (.\scripts\scratch.ps1 -Drop ...).
// Channel names are built from scratch-only ids, and the server's secret is
// broken by construction, so nothing here reaches a real phone.

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail: unknown = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}   ${typeof detail === "string" ? detail : JSON.stringify(detail)}`) }
}
function head(s: string) {
  console.log(`\n── ${s} ${"─".repeat(Math.max(0, 66 - s.length))}`)
}

const ROOT = join(__dirname, "..")
const STATIC_ONLY = process.argv.includes("--static-only")

/* ═════════════════════════════ A  STATIC ═════════════════════════════════ */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "generated" || name === "node_modules") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function partA() {
  head("A  no trigger outside src/lib/realtime.ts")
  const files = walk(join(ROOT, "src"))
  const rel = (p: string) => relative(ROOT, p).split(sep).join("/")
  const TRIGGER_OK = new Set(["src/lib/realtime.ts"])
  const IMPORT_OK = new Set(["src/lib/realtime.ts", "src/app/api/pusher/auth/route.ts"])

  const triggers: string[] = []
  const imports: string[] = []
  for (const f of files) {
    const src = readFileSync(f, "utf8")
    // Code only: the realtime.ts header names `pusher.trigger(` in a comment.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
    if (/\.trigger(Batch)?\s*\(/.test(code) && !TRIGGER_OK.has(rel(f))) triggers.push(rel(f))
    if (/from\s+["'](@\/lib\/pusher|(\.\.?\/)+(lib\/)?pusher)["']/.test(code) && !IMPORT_OK.has(rel(f))) imports.push(rel(f))
  }
  check(`no .trigger( outside realtime.ts (${files.length} files scanned)`, triggers.length === 0, triggers)
  check("nothing but realtime.ts and /api/pusher/auth imports the server client", imports.length === 0, imports)

  const pusherTs = readFileSync(join(ROOT, "src/lib/pusher.ts"), "utf8")
  check("the server client has a timeout", /timeout:\s*\d+/.test(pusherTs))

  // The owner's schema freeze (AGENTS.md): this fix must not have needed one.
  head("A  schema freeze: 28 models, no new migration (verify-schema-freeze.ts)")
  const freeze = spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts/verify-schema-freeze.ts")], {
    cwd: ROOT, encoding: "utf8",
  })
  process.stdout.write(freeze.stdout ?? "")
  check("verify-schema-freeze.ts passes", freeze.status === 0, (freeze.stderr ?? "").slice(0, 300))
}

/* ═════════════════════════════ B  HELPER ═════════════════════════════════ */

async function partB() {
  head("B  notifyUser() survives both failures and a hang")
  const { notifyUser } = await import("../src/lib/realtime")
  const pusher = (await import("../src/lib/pusher")).default
  const PusherServer = (await import("pusher")).default

  const realTrigger = pusher.trigger
  const realWarn = console.warn
  const warned: string[] = []
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")) }
  const swap = (fn: (...a: unknown[]) => unknown) => {
    ;(pusher as unknown as { trigger: unknown }).trigger = fn
  }

  try {
    // 1  thrown before a promise exists: what a missing secret does
    swap(() => { throw new TypeError("The \"key\" argument must be of type string") })
    let threw = false
    try { await notifyUser("zz-psafe-none", "probe", {}) } catch { threw = true }
    check("a trigger that THROWS: notifyUser resolves", !threw)
    check("...and logs it", warned.some((w) => w.includes("[realtime] probe") && w.includes("key")), warned)

    // 2  a rejected promise: what a wrong secret / an outage does
    warned.length = 0
    swap(() => Promise.reject(Object.assign(new Error("Request failed with an error"), { status: 401 })))
    threw = false
    try { await notifyUser("zz-psafe-none", "probe", {}) } catch { threw = true }
    check("a trigger that REJECTS: notifyUser resolves", !threw)
    check("...and logs it with the HTTP status", warned.some((w) => w.includes("(HTTP 401)")), warned)

    // 3  the unswapped library really does throw synchronously with no secret,
    //    so (1) is not a hypothetical. No request is made: it throws first.
    const noSecret = new PusherServer({ appId: "1", key: "k", secret: undefined as unknown as string, cluster: "mt1" })
    let sync = false
    try { void noSecret.trigger("private-user-zz-psafe-none", "probe", {}) } catch { sync = true }
    check("pusher@5 with no secret throws synchronously (why .catch() was not enough)", sync)
  } finally {
    ;(pusher as unknown as { trigger: typeof realTrigger }).trigger = realTrigger
    console.warn = realWarn
  }

  // 4  a network that hangs: the real client, a non-routable address, the
  //    timeout pusher.ts sets. Bounded, not the OS TCP timeout. Nothing leaves
  //    for Pusher: the host is a black hole.
  const timeout = (pusher as unknown as { config: { timeout?: number } }).config.timeout
  check("src/lib/pusher.ts configures the client timeout", typeof timeout === "number" && timeout > 0, String(timeout))
  const hung = new PusherServer({
    appId: "1", key: "k", secret: "s", host: "10.255.255.1", useTLS: false, timeout: timeout ?? 3000,
  })
  const t0 = Date.now()
  let rejected = false
  try { await hung.trigger("private-user-zz-psafe-none", "probe", {}) } catch { rejected = true }
  const took = Date.now() - t0
  check(`a hanging network ends on the timeout (${took} ms, limit ${timeout})`, rejected && took < (timeout ?? 3000) + 1500, `${rejected} ${took}ms`)
}

/* ═════════════════════════════ C  HTTP ═══════════════════════════════════ */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON from the wire
type Json = Record<string, any>
const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3001"
// A response slower than this means notifyUser() was waiting on something it
// should have given up on (the client timeout is 3 s; the offer decision has
// two sequential awaits, so 6 s is the honest worst case, plus headroom). The
// FIRST hit on a route after a dev-server restart also compiles it, which on
// this machine has measured up to ~10 s for routes with no Pusher call at all
// (confirm/start), so a slow first run is re-timed warm before it is believed.
const SLOW_MS = 8000

async function call(method: string, path: string, token: string, body?: Json) {
  const t0 = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json: Json = {}
  try { json = JSON.parse(text) as Json } catch { json = { _raw: text.slice(0, 120) } }
  return { status: res.status, json, ms: Date.now() - t0 }
}
const brief = (r: { status: number; json: Json; ms: number }) =>
  `${r.status} ${r.ms}ms ${JSON.stringify(r.json).slice(0, 200)}`

async function partC() {
  const prisma = (await import("../src/lib/prisma")).default
  const { requireScratchSchema } = await import("./lib/live-guard")
  const { signAccessToken } = await import("../src/lib/auth-tokens")
  requireScratchSchema("scripts/verify-pusher-safe.ts")

  // Is the server reachable at all? A refused connection is not a Pusher result.
  try { await fetch(`${BASE}/api/health`).catch(() => fetch(BASE)) } catch {
    console.error(`\n  No server at ${BASE}. Start scratch-dev-safe.ps1 first (see the header).`)
    process.exit(2)
  }

  const P = `ZZPSAFE_${Date.now().toString(36)}_`
  const ok = (r: { status: number; ms: number }, want: number[]) => want.includes(r.status) && r.ms < SLOW_MS

  async function mkUser(tag: string) {
    const u = await prisma.user.create({
      data: { name: `${P}${tag}`, email: `${P}${tag}@example.com`.toLowerCase(), isVerified: true, leaves: 0 },
    })
    return { ...u, token: await signAccessToken(u.id) }
  }
  async function mkItem(userId: string, tag: string) {
    return prisma.item.create({
      data: {
        title: `${P}${tag}`, description: "fixture", category: "OTHER", condition: "GOOD",
        valueLeaves: 100, suggestedLeaves: 100, status: "AVAILABLE", userId,
      },
      select: { id: true },
    })
  }
  const notes = (userId: string, type: string) => prisma.notification.count({ where: { userId, type: type as never } })
  const itemStatus = async (id: string) => (await prisma.item.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
  const row = (id: string) =>
    prisma.trade.findUniqueOrThrow({ where: { id }, select: { status: true, offerStatus: true } })
  // The decision's two cards only: POST /api/offers wrote a third row (the
  // `offer` card itself) carrying the same offerId.
  const offerCards = (offerId: string) =>
    prisma.message.count({
      where: { AND: [{ content: { contains: `"offerId":"${offerId}"` } }, { content: { contains: '"type":"offer_update"' } }] },
    })

  const alice = await mkUser("alice")
  const bob = await mkUser("bob")

  head("C1  messages + both typing routes")
  {
    const before = await prisma.message.count({ where: { senderId: alice.id, receiverId: bob.id } })
    const r = await call("POST", "/api/messages", alice.token, { receiverId: bob.id, content: "hello from the harness" })
    check("POST /api/messages -> 201", ok(r, [201]), brief(r))
    const after = await prisma.message.count({ where: { senderId: alice.id, receiverId: bob.id } })
    check("...exactly one message saved", after === before + 1, `${before} -> ${after}`)
    check("...NEW_MESSAGE notification for the receiver", (await notes(bob.id, "NEW_MESSAGE")) === 1)

    const t1 = await call("POST", "/api/messages/typing", alice.token, { receiverId: bob.id, isTyping: true })
    check("POST /api/messages/typing -> 200 { ok: true }", ok(t1, [200]) && t1.json.ok === true, brief(t1))
    const t2 = await call("POST", "/api/pusher/typing", alice.token, { receiverId: bob.id })
    check("POST /api/pusher/typing -> 200 { ok: true } (was a bare 500)", ok(t2, [200]) && t2.json.ok === true, brief(t2))
  }

  head("C2  offer: send, decline, withdraw, accept")
  const sendOffer = async (tag: string) => {
    const mine = await mkItem(alice.id, `${tag}-offered`)
    const theirs = await mkItem(bob.id, `${tag}-wanted`)
    const r = await call("POST", "/api/offers", alice.token, { postId: theirs.id, offeredItemId: mine.id })
    return { r, mine, theirs, offerId: r.json.offerId as string | undefined }
  }
  {
    const notesBefore = await notes(bob.id, "NEW_MESSAGE")
    const s = await sendOffer("dec")
    check("POST /api/offers -> 201", ok(s.r, [201]) && !!s.offerId, brief(s.r))
    if (s.offerId) {
      check("...offer row PENDING", (await row(s.offerId)).offerStatus === "PENDING")
      // The route deletes the unread NEW_MESSAGE and writes one fresh: still one.
      check("...the receiver's NEW_MESSAGE notification is written", (await notes(bob.id, "NEW_MESSAGE")) >= Math.min(1, notesBefore + 1))

      const d = await call("PATCH", `/api/offers/${s.offerId}`, bob.token, { action: "decline" })
      check("PATCH /api/offers/[id] decline -> 200", ok(d, [200]), brief(d))
      check("...offer row DECLINED", (await row(s.offerId)).offerStatus === "DECLINED", (await row(s.offerId)).offerStatus)
      check("...TRADE_REJECTED notification for the sender", (await notes(alice.id, "TRADE_REJECTED")) >= 1)
      check("...BOTH offer-update cards written (skipped when the trigger threw)", (await offerCards(s.offerId)) === 2, String(await offerCards(s.offerId)))
    }
  }
  {
    const s = await sendOffer("wd")
    check("second offer -> 201", ok(s.r, [201]) && !!s.offerId, brief(s.r))
    if (s.offerId) {
      const w = await call("POST", `/api/v1/offers/${s.offerId}/withdraw`, alice.token, {})
      check("POST /api/v1/offers/[id]/withdraw -> 200 (no try: a throw was a bare 500)", ok(w, [200]), brief(w))
      check("...offer row WITHDRAWN", (await row(s.offerId)).offerStatus === "WITHDRAWN", (await row(s.offerId)).offerStatus)
    }
  }
  let acceptedTradeId: string | undefined
  {
    const s = await sendOffer("acc")
    check("third offer -> 201", ok(s.r, [201]) && !!s.offerId, brief(s.r))
    if (s.offerId) {
      const a = await call("PATCH", `/api/offers/${s.offerId}`, bob.token, { action: "accept" })
      check("PATCH /api/offers/[id] accept -> 200 with a tradeId", ok(a, [200]) && !!a.json.tradeId, brief(a))
      acceptedTradeId = a.json.tradeId
      if (acceptedTradeId) {
        check("...trade ACCEPTED", (await row(acceptedTradeId)).status === "ACCEPTED", (await row(acceptedTradeId)).status)
        check("...TRADE_ACCEPTED notification for the sender", (await notes(alice.id, "TRADE_ACCEPTED")) >= 1)
        check("...BOTH offer-update cards written", (await offerCards(s.offerId)) === 2, String(await offerCards(s.offerId)))
      }
    }
  }

  head("C3  the code exchange to COMPLETED (confirm/submit)")
  if (acceptedTradeId) {
    const id = acceptedTradeId
    const start = await call("POST", `/api/trades/${id}/confirm/start`, alice.token, {})
    check("confirm/start -> 200", ok(start, [200]), brief(start))
    const aStatus = await call("GET", `/api/trades/${id}/confirm/status`, alice.token)
    const bStatus = await call("GET", `/api/trades/${id}/confirm/status`, bob.token)
    const aCode = aStatus.json.code as string | undefined
    const bCode = bStatus.json.code as string | undefined
    check("both sides read their own code", typeof aCode === "string" && typeof bCode === "string", `${brief(aStatus)} | ${brief(bStatus)}`)
    if (aCode && bCode) {
      const s1 = await call("POST", `/api/trades/${id}/confirm/submit`, alice.token, { code: bCode })
      check("first submit -> 200 correct", ok(s1, [200]) && s1.json.correct === true, brief(s1))
      const s2 = await call("POST", `/api/trades/${id}/confirm/submit`, bob.token, { code: aCode })
      check("LAST submit -> 200 completed (was a 500 on a paid, completed trade)", ok(s2, [200]) && s2.json.completed === true, brief(s2))
      check("...trade COMPLETED", (await row(id)).status === "COMPLETED", (await row(id)).status)
      // Those two writes are fire-and-forget by design; give them a moment.
      let done = 0
      for (let i = 0; i < 20 && done < 2; i++) {
        done = await prisma.notification.count({ where: { entityId: id, type: "TRADE_COMPLETED" } })
        if (done < 2) await new Promise((r) => setTimeout(r, 250))
      }
      check("...both TRADE_COMPLETED notifications written (lost when the trigger threw)", done === 2, String(done))
      const completedCards = await prisma.message.count({ where: { tradeId: id, content: { contains: '"type":"trade_completed"' } } })
      check("...both trade_completed chat cards written", completedCards === 2, String(completedCards))
    }
  } else {
    check("an accepted trade to complete", false, "C2's accept did not produce one")
  }

  head("C4  legacy swap request: create, reject, accept, cancel")
  const request = async (tag: string) => {
    const mine = await mkItem(alice.id, `${tag}-offered`)
    const theirs = await mkItem(bob.id, `${tag}-wanted`)
    const r = await call("POST", "/api/trades", alice.token, { offeredItemId: mine.id, requestedItemId: theirs.id })
    return { r, mine, theirs, tradeId: r.json.id as string | undefined }
  }
  {
    const q = await request("rej")
    check("POST /api/trades -> 201", ok(q.r, [201]) && !!q.tradeId, brief(q.r))
    if (q.tradeId) {
      check("...trade PENDING", (await row(q.tradeId)).status === "PENDING")
      check("...TRADE_REQUEST notification for the receiver", (await notes(bob.id, "TRADE_REQUEST")) >= 1)
      const before = await notes(alice.id, "TRADE_REJECTED")
      const r = await call("PATCH", "/api/trades", bob.token, { tradeId: q.tradeId, status: "REJECTED" })
      check("PATCH /api/trades REJECTED -> 200 (was a 500)", ok(r, [200]) && r.json.status === "REJECTED", brief(r))
      check("...trade REJECTED", (await row(q.tradeId)).status === "REJECTED", (await row(q.tradeId)).status)
      check("...TRADE_REJECTED notification for the sender", (await notes(alice.id, "TRADE_REJECTED")) === before + 1)
    }
  }
  {
    const q = await request("can")
    check("second request -> 201", ok(q.r, [201]) && !!q.tradeId, brief(q.r))
    if (q.tradeId) {
      const a = await call("PATCH", "/api/trades", bob.token, { tradeId: q.tradeId, status: "ACCEPTED" })
      check("PATCH /api/trades ACCEPTED -> 200", ok(a, [200]) && a.json.status === "ACCEPTED", brief(a))
      check("...items IN_TRADE", (await itemStatus(q.mine.id)) === "IN_TRADE" && (await itemStatus(q.theirs.id)) === "IN_TRADE")

      const c = await call("PATCH", `/api/trades/${q.tradeId}`, alice.token, { action: "cancel" })
      check("PATCH /api/trades/[id] cancel -> 200 (the rehearsal failure)", ok(c, [200]) && c.json.ok === true, brief(c))
      check("...trade CANCELLED", (await row(q.tradeId)).status === "CANCELLED", (await row(q.tradeId)).status)
      check("...both items back to AVAILABLE", (await itemStatus(q.mine.id)) === "AVAILABLE" && (await itemStatus(q.theirs.id)) === "AVAILABLE")
      check("...TRADE_CANCELLED notification for the other side", (await notes(bob.id, "TRADE_CANCELLED")) === 1)
      // 400 from the status pre-check; 409 is only the two-taps-at-once race.
      const again = await call("PATCH", `/api/trades/${q.tradeId}`, alice.token, { action: "cancel" })
      check("a second cancel is refused (400), not re-run", again.status === 400, brief(again))
      check("...and wrote no second TRADE_CANCELLED", (await notes(bob.id, "TRADE_CANCELLED")) === 1)
    }
  }

  await prisma.$disconnect()
}

async function main() {
  partA()
  await partB()
  if (!STATIC_ONLY) await partC()
  console.log(`\n  ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
