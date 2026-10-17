// Acceptance harness for credentials email verification.
//
// Everything here runs against the REAL routes over HTTP, on purpose. The one
// thing this file fakes is the SMTP server — and it fakes it by speaking actual
// SMTP on a local port, so nodemailer, the template and the send path are all
// exercised and the verification link is read out of the delivered message
// exactly as a user would read it out of their inbox. Nothing reaches into the
// database to fabricate a token.
//
// Driving it over HTTP is also what proves the routing question: the NextAuth
// catch-all at /api/auth/[...nextauth] matches every /api/auth/* path, so the
// only way to know these endpoints are real static segments and not the
// catch-all answering is to call them and look at what comes back.
//
// Run (from baylo/, with a dev server on BASE and SMTP pointed at SMTP_PORT):
//   npx tsx scripts/verify-email-verification.ts
import net from "net"
import prisma from "../src/lib/prisma"
import { SIGNUP_GRANT_LEAVES, TASK_REWARDS } from "../src/lib/task-constants"
import { requireScratchSchema } from "./lib/live-guard"

/** Comfortably over 18. See the note at the first register call below. */
const ADULT_DOB = "1995-06-15"

const BASE = process.env.ACCEPT_BASE ?? "http://127.0.0.1:3100"
const SMTP_PORT = Number(process.env.ACCEPT_SMTP_PORT ?? 2525)
const P = "zzmailverify-"
const PASSWORD = "correct-horse-battery"

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}  ${detail}`) }
}

// ── A minimal SMTP sink ──────────────────────────────────────────────────────
// Enough of RFC 5321 for nodemailer to complete a session. Captures the raw
// message so the test can pull the verification URL out of the body.

interface Captured { to: string; body: string }
const inbox: Captured[] = []

function startSmtpSink(port: number): Promise<net.Server> {
  const server = net.createServer((socket) => {
    let inData = false
    let rcpt = ""
    let body = ""

    socket.write("220 localhost ESMTP sink\r\n")
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8")

      if (inData) {
        body += text
        // "\r\n.\r\n" terminates DATA.
        if (body.includes("\r\n.\r\n")) {
          inData = false
          inbox.push({ to: rcpt, body: body.split("\r\n.\r\n")[0] })
          body = ""
          socket.write("250 2.0.0 Ok: queued\r\n")
        }
        return
      }

      for (const line of text.split("\r\n").filter(Boolean)) {
        const verb = line.slice(0, 4).toUpperCase()
        if (verb === "EHLO" || verb === "HELO") {
          socket.write("250-localhost\r\n250 AUTH PLAIN LOGIN\r\n")
        } else if (verb === "AUTH") {
          socket.write("235 2.7.0 Accepted\r\n")
        } else if (verb === "MAIL") {
          socket.write("250 2.1.0 Ok\r\n")
        } else if (verb === "RCPT") {
          rcpt = /<([^>]*)>/.exec(line)?.[1] ?? ""
          socket.write("250 2.1.5 Ok\r\n")
        } else if (verb === "DATA") {
          inData = true
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n")
        } else if (verb === "QUIT") {
          socket.write("221 2.0.0 Bye\r\n")
          socket.end()
        } else {
          socket.write("250 2.0.0 Ok\r\n")
        }
      }
    })
    socket.on("error", () => { /* client hung up; not this test's concern */ })
  })

  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve(server))
  })
}

/** Pulls the verification link out of the most recent message to `to`. */
function linkFor(to: string): string | null {
  for (let i = inbox.length - 1; i >= 0; i--) {
    if (inbox[i].to !== to) continue
    // Quoted-printable soft line breaks split long URLs across lines.
    const decoded = inbox[i].body.replace(/=\r\n/g, "").replace(/=3D/g, "=")
    // Since 17 Oct 2026 the link is the confirm PAGE (/auth/verify-email), not
    // the API route: opening it spends nothing; the page's button POSTs.
    const match = /https?:\/\/[^\s"'<>]*\/auth\/verify-email\?token=[A-Za-z0-9]+/.exec(decoded)
    if (match) return match[0]
  }
  return null
}

/** Pulls the password-reset link out of the most recent message to `to`. */
function resetLinkFor(to: string): string | null {
  for (let i = inbox.length - 1; i >= 0; i--) {
    if (inbox[i].to !== to) continue
    const decoded = inbox[i].body.replace(/=\r\n/g, "").replace(/=3D/g, "=")
    const match = /https?:\/\/[^\s"'<>]*\/auth\/reset-password\?token=[A-Za-z0-9]+/.exec(decoded)
    if (match) return match[0]
  }
  return null
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

async function req(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; json: Record<string, unknown>; location: string | null }> {
  const res = await fetch(`${BASE}${path}`, { ...init, redirect: "manual" })
  let json: Record<string, unknown> = {}
  try { json = (await res.json()) as Record<string, unknown> } catch { /* redirect or empty */ }
  return { status: res.status, json, location: res.headers.get("location") }
}

const jsonHeaders = { "content-type": "application/json", accept: "application/json" }

/** The first <form> in served HTML: its method, action, and named input values. */
function parseForm(html: string): { method: string; action: string; fields: Record<string, string> } | null {
  const m = /<form\b([^>]*)>([\s\S]*?)<\/form>/i.exec(html)
  if (!m) return null
  const attr = (src: string, name: string) =>
    new RegExp(`\\b${name}="([^"]*)"`, "i").exec(src)?.[1]?.replace(/&amp;/g, "&") ?? ""
  const fields: Record<string, string> = {}
  for (const input of m[2].matchAll(/<input\b([^>]*)>/gi)) {
    const name = attr(input[1], "name")
    if (name) fields[name] = attr(input[1], "value")
  }
  return { method: attr(m[1], "method").toLowerCase(), action: attr(m[1], "action"), fields }
}

/**
 * Submits a form the way a browser with JavaScript OFF does: urlencoded body,
 * the page's Origin, Accept: text/html, and no redirect-following, so the 303
 * itself can be checked.
 */
async function submitForm(
  action: string,
  fields: Record<string, string>,
  origin = new URL(BASE).origin,
): Promise<{ status: number; location: string }> {
  const res = await fetch(`${BASE}${action}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", origin },
    body: new URLSearchParams(fields).toString(),
    redirect: "manual",
  })
  return { status: res.status, location: res.headers.get("location") ?? "" }
}

async function snapshot(userId: string) {
  const [u, txs, tokens] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { isVerified: true, signupGrantClaimed: true, leaves: true, lifetimeLeaves: true },
    }),
    prisma.leafTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { type: true, amount: true, description: true, createdAt: true, eventAt: true },
    }),
    prisma.authToken.count({ where: { userId, type: "EMAIL_VERIFICATION" as const } }),
  ])
  return { ...u, txs, tokens }
}

function printLedger(label: string, txs: Awaited<ReturnType<typeof snapshot>>["txs"]) {
  console.log(`      ${label}:`)
  if (txs.length === 0) { console.log("        (no rows)"); return }
  for (const t of txs) {
    console.log(
      `        ${t.type.padEnd(14)} ${String(t.amount).padStart(4)}  "${t.description}"` +
      `  createdAt=${t.createdAt.toISOString()}  eventAt=${t.eventAt.toISOString()}`,
    )
  }
}

/**
 * This run's accounts only: their balances against their own ledger rows.
 * A freshly verified account has been touched by nothing but credits -- the
 * signup grant and the VERIFY_ACCOUNT reward -- so for THESE users the sum of
 * positive rows, the sum of all rows and the balance must be one number. That
 * is a claim about the verification path, and it is scoped to the accounts the
 * verification path created. It is NOT true of the whole database, which
 * carries TRADE_SPEND and CONTRACT_PAY debits by design.
 */
async function runTotals() {
  const users = await prisma.user.findMany({ where: { email: { startsWith: P } }, select: { id: true, leaves: true } })
  const ids = users.map((u) => u.id)
  const [positive, all] = await Promise.all([
    prisma.leafTransaction.aggregate({ _sum: { amount: true }, where: { userId: { in: ids }, amount: { gt: 0 } } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true }, where: { userId: { in: ids } } }),
  ])
  return {
    userLeaves: users.reduce((n, u) => n + u.leaves, 0),
    positiveRows: positive._sum.amount ?? 0,
    allRows: all._sum.amount ?? 0,
  }
}

/** The whole-database ledger invariant, measured rather than assumed. */
async function ledgerTotals() {
  const [users, positive, all] = await Promise.all([
    prisma.user.aggregate({ _sum: { leaves: true } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true }, where: { amount: { gt: 0 } } }),
    prisma.leafTransaction.aggregate({ _sum: { amount: true } }),
  ])
  return {
    userLeaves: users._sum.leaves ?? 0,
    positiveRows: positive._sum.amount ?? 0,
    allRows: all._sum.amount ?? 0,
  }
}

async function main() {
  requireScratchSchema("scripts/verify-email-verification.ts")
  const sink = await startSmtpSink(SMTP_PORT)
  console.log(`SMTP sink listening on 127.0.0.1:${SMTP_PORT}`)
  console.log(`Driving ${BASE}\n`)

  const before = await ledgerTotals()
  console.log(`Ledger before: SUM(User.leaves)=${before.userLeaves}  ` +
              `SUM(positive rows)=${before.positiveRows}  SUM(all rows)=${before.allRows}`)

  const stamp = Date.now()
  const emailA = `${P}a-${stamp}@example.com`
  const emailB = `${P}b-${stamp}@example.com`

  // ── 1. The catch-all trap ──────────────────────────────────────────────────
  // /api/auth/[...nextauth] answers every /api/auth/* path it is given and
  // returns a bare 400 for an action it does not know. These three responses
  // are ones it cannot produce, so getting them proves the static segments win.
  console.log("\n[1] routing — real static segments, not the NextAuth catch-all")

  // GET never redeems: it forwards to the confirm page with the token intact,
  // whatever the Accept header says. The catch-all would answer a bare 400.
  const bogus = await req("/api/auth/verify-email?token=deadbeef", { headers: jsonHeaders })
  check("GET verify-email reaches our handler (303 to the confirm page)",
    bogus.status === 303 && /\/auth\/verify-email\?token=deadbeef$/.test(bogus.location ?? ""),
    `status=${bogus.status} location=${bogus.location}`)

  const badBody = await req("/api/auth/verify-email", {
    method: "POST", headers: jsonHeaders, body: "{}",
  })
  check("POST verify-email reaches our zod validation",
    badBody.status === 400 && Array.isArray(badBody.json.issues),
    `status=${badBody.status} body=${JSON.stringify(badBody.json)}`)

  const noAuth = await req("/api/auth/resend-verification", { method: "POST", headers: jsonHeaders })
  check("POST resend-verification reaches our handler (401, a status the catch-all never returns)",
    noAuth.status === 401,
    `status=${noAuth.status} body=${JSON.stringify(noAuth.json)}`)

  // ── 2. Register and receive the email ──────────────────────────────────────
  console.log("\n[2] credentials registration sends a verification email")

  const regA = await req("/api/auth/register", {
    method: "POST", headers: jsonHeaders,
    // dateOfBirth is REQUIRED by /api/auth/register since the 18+ gate landed
    // (migration 20260903000000_user_date_of_birth). This suite predates it and
    // had been failing on a 400 ever since; the fixture is simply an adult.
    body: JSON.stringify({ name: "ZZ Verify A", email: emailA, password: PASSWORD, dateOfBirth: ADULT_DOB }),
  })
  check("register returns 201", regA.status === 201, JSON.stringify(regA.json))
  check("register reports the account as unverified", regA.json.isVerified === false)
  check("register reports the verification email as sent", regA.json.verificationEmailSent === true)

  const userA = await prisma.user.findUniqueOrThrow({ where: { email: emailA }, select: { id: true } })
  const snapA0 = await snapshot(userA.id)
  check("account starts unverified with 0 Leaves and no ledger rows",
    !snapA0.isVerified && snapA0.leaves === 0 && snapA0.lifetimeLeaves === 0 && snapA0.txs.length === 0,
    JSON.stringify(snapA0))
  check("exactly one verification token exists", snapA0.tokens === 1, `got ${snapA0.tokens}`)

  const linkA = linkFor(emailA)
  check("an email arrived carrying a verification link", linkA !== null)
  if (!linkA) throw new Error("no verification link captured — cannot continue")
  console.log(`      link: ${linkA.replace(/token=([A-Za-z0-9]{8})[A-Za-z0-9]+/, "token=$1…")}`)

  const storedHash = await prisma.authToken.findFirstOrThrow({
    where: { userId: userA.id }, select: { tokenHash: true },
  })
  const rawA = new URL(linkA).searchParams.get("token") ?? ""
  check("the token is 32 CSPRNG bytes, hex encoded", /^[0-9a-f]{64}$/.test(rawA), `len=${rawA.length}`)
  check("the raw token is NOT what is stored — the column holds its digest",
    storedHash.tokenHash !== rawA)

  // ── 3. Verify ──────────────────────────────────────────────────────────────
  console.log("\n[3] verifying credits exactly the grant plus VERIFY_ACCOUNT")

  // Opening the link must verify NOTHING — mail scanners open every link in a
  // message. Neither the emailed page URL nor the legacy API URL may spend it.
  const pagePath = linkA.slice(new URL(linkA).origin.length)
  check("the emailed link is the confirm page, not the API",
    pagePath.startsWith("/auth/verify-email?token="), pagePath)
  const opened = await fetch(`${BASE}${pagePath}`, { headers: { accept: "text/html" }, redirect: "manual" })
  check("opening the link serves the confirm page (200)", opened.status === 200, `status=${opened.status}`)
  const legacyOpen = await req(`/api/auth/verify-email?token=${rawA}`, { headers: { accept: "*/*" } })
  check("GET of the legacy API link only redirects (303)", legacyOpen.status === 303,
    `status=${legacyOpen.status}`)
  const snapOpened = await snapshot(userA.id)
  check("after opening, still unverified with the token unspent",
    !snapOpened.isVerified && snapOpened.tokens === 1 && snapOpened.txs.length === 0,
    `isVerified=${snapOpened.isVerified} tokens=${snapOpened.tokens} rows=${snapOpened.txs.length}`)

  // THE CONFIRM BUTTON, PRESSED THE WAY A BROWSER PRESSES IT (17 Oct 2026).
  // This used to POST JSON straight at the API, which never touched the page —
  // and so passed while the real button was dead on a phone whose browser
  // could not load the page's scripts. Now: read the served page's HTML, find
  // its <form> and hidden token, submit them as a browser submits a form with
  // no JavaScript at all, and follow the 303 to the page that results.
  const pageHtml = await opened.text()
  const form = parseForm(pageHtml)
  check("the confirm page carries a plain POST form (no JavaScript needed)",
    form?.action === "/api/auth/verify-email" && form.method === "post", JSON.stringify(form))
  check("the form's hidden token is the emailed one", form?.fields.token === rawA)
  if (!form) throw new Error("no confirm form on the page — cannot continue")

  // A form post from another site is refused before anything is spent.
  const crossSite = await submitForm(form.action, form.fields, "http://evil.example")
  check("a cross-site form post is refused (403)", crossSite.status === 403, `status=${crossSite.status}`)
  const snapCross = await snapshot(userA.id)
  check("…and spent nothing", !snapCross.isVerified && snapCross.tokens === 1, JSON.stringify(snapCross))

  const verified = await submitForm(form.action, form.fields)
  const expected = SIGNUP_GRANT_LEAVES + TASK_REWARDS.VERIFY_ACCOUNT
  check("pressing Confirm answers 303 to the verified page",
    verified.status === 303 && /\/auth\/verify-email\?status=verified&leaves=\d+$/.test(verified.location),
    `status=${verified.status} location=${verified.location}`)
  check(`the redirect reports ${expected} Leaves`, verified.location.endsWith(`leaves=${expected}`), verified.location)
  const resultPage = await fetch(verified.location, { headers: { accept: "text/html" } })
  const resultHtml = await resultPage.text()
  check("the verified page says so", resultPage.status === 200 && resultHtml.includes("re verified") &&
    resultHtml.includes(`${expected} welcome Leaves are in your balance`), `status=${resultPage.status}`)

  const snapA1 = await snapshot(userA.id)
  printLedger("ledger after verifying", snapA1.txs)
  check("isVerified is now true", snapA1.isVerified)
  check("signupGrantClaimed is now true", snapA1.signupGrantClaimed)
  check(`leaves = ${expected}`, snapA1.leaves === expected, `got ${snapA1.leaves}`)
  check(`lifetimeLeaves = ${expected}`, snapA1.lifetimeLeaves === expected, `got ${snapA1.lifetimeLeaves}`)
  check("exactly two ledger rows", snapA1.txs.length === 2, `got ${snapA1.txs.length}`)

  const grantRow = snapA1.txs.find((t) => t.type === "SIGNUP_GRANT")
  const taskRow = snapA1.txs.find((t) => t.type === "TASK_REWARD")
  check(`one SIGNUP_GRANT row for exactly ${SIGNUP_GRANT_LEAVES}`,
    !!grantRow && grantRow.amount === SIGNUP_GRANT_LEAVES, JSON.stringify(grantRow))
  check(`one TASK_REWARD row for VERIFY_ACCOUNT (${TASK_REWARDS.VERIFY_ACCOUNT})`,
    !!taskRow && taskRow.amount === TASK_REWARDS.VERIFY_ACCOUNT, JSON.stringify(taskRow))

  const completion = await prisma.leafTransaction.findFirst({
    where: { userId: userA.id, task: "VERIFY_ACCOUNT" }, select: { amount: true, taskRefId: true },
  })
  check("a VERIFY_ACCOUNT task row was written to the ledger",
    !!completion && completion.amount === TASK_REWARDS.VERIFY_ACCOUNT, JSON.stringify(completion))

  // eventAt is the verification moment on the live path, so it should sit
  // within a breath of createdAt rather than being backdated to signup.
  const drift = Math.abs((grantRow!.eventAt.getTime() - grantRow!.createdAt.getTime()))
  check("eventAt tracks the verification moment, not account creation", drift < 5000,
    `drift=${drift}ms`)

  check("the token was consumed and deleted", snapA1.tokens === 0, `got ${snapA1.tokens}`)

  // ── 4. Verifying twice credits nothing ─────────────────────────────────────
  console.log("\n[4] verifying twice credits nothing")

  // The same form, submitted again — a double tap, or Back and press again.
  const replay = await submitForm(form.action, form.fields)
  check("pressing Confirm again lands on 'didn't work'",
    replay.status === 303 && replay.location.endsWith("/auth/verify-email?status=invalid"),
    `status=${replay.status} location=${replay.location}`)
  const replayJson = await req("/api/auth/verify-email", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ token: rawA }),
  })
  check("the spent token is refused over JSON too", replayJson.status === 400 && replayJson.json.code === "INVALID_TOKEN",
    `status=${replayJson.status} body=${JSON.stringify(replayJson.json)}`)
  const snapReplay = await snapshot(userA.id)
  check("the second press credited nothing (still two ledger rows)", snapReplay.txs.length === 2 &&
    snapReplay.leaves === expected, `rows=${snapReplay.txs.length} leaves=${snapReplay.leaves}`)

  // A spent link being rejected is the easy half. The half that matters is a
  // LIVE token against an account that is already verified — which is what a
  // resend issued just before verifying would leave behind. It must redeem
  // cleanly and pay nothing.
  await prisma.authToken.deleteMany({ where: { userId: userA.id, type: "EMAIL_VERIFICATION" as const } })
  const resendA = await req("/api/auth/resend-verification", {
    method: "POST", headers: { ...jsonHeaders, authorization: `Bearer ${await bearerFor(emailA)}` },
  })
  check("resend on a verified account is a no-op that sends nothing",
    resendA.status === 200 && resendA.json.alreadyVerified === true && resendA.json.sent === false,
    JSON.stringify(resendA.json))

  const snapA2 = await snapshot(userA.id)
  printLedger("ledger after the second attempt", snapA2.txs)
  check("still exactly two ledger rows", snapA2.txs.length === 2, `got ${snapA2.txs.length}`)
  check(`leaves unchanged at ${expected}`, snapA2.leaves === expected, `got ${snapA2.leaves}`)
  check(`lifetimeLeaves unchanged at ${expected}`, snapA2.lifetimeLeaves === expected,
    `got ${snapA2.lifetimeLeaves}`)

  // ── 5. An expired token is refused ─────────────────────────────────────────
  console.log("\n[5] an expired token is refused")

  const regB = await req("/api/auth/register", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ name: "ZZ Verify B", email: emailB, password: PASSWORD, dateOfBirth: ADULT_DOB }),
  })
  check("register B returns 201", regB.status === 201, JSON.stringify(regB.json))
  const userB = await prisma.user.findUniqueOrThrow({ where: { email: emailB }, select: { id: true } })

  const linkB = linkFor(emailB)
  check("B received a verification link", linkB !== null)
  if (!linkB) throw new Error("no verification link captured for B")

  // Age the token past its life. The expiry check reads the column, so moving
  // the column is the honest way to test it without waiting 24 hours.
  await prisma.authToken.updateMany({
    where: { userId: userB.id },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  })

  const expiredGet = await req("/api/auth/verify-email", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ token: new URL(linkB).searchParams.get("token") }),
  })
  check("POST with an expired token is refused",
    expiredGet.status === 400 && expiredGet.json.code === "EXPIRED_TOKEN",
    `status=${expiredGet.status} body=${JSON.stringify(expiredGet.json)}`)

  const snapB1 = await snapshot(userB.id)
  check("B is still unverified", !snapB1.isVerified)
  check("B has 0 Leaves and no ledger rows",
    snapB1.leaves === 0 && snapB1.lifetimeLeaves === 0 && snapB1.txs.length === 0,
    JSON.stringify(snapB1))
  check("the expired token was purged", snapB1.tokens === 0, `got ${snapB1.tokens}`)

  // ── 6. Resend, and its rate limit ──────────────────────────────────────────
  console.log("\n[6] resend-verification, rate limited 3/hour per user")

  const tokenB = await bearerFor(emailB)
  const authB = { ...jsonHeaders, authorization: `Bearer ${tokenB}` }

  const resend1 = await req("/api/auth/resend-verification", { method: "POST", headers: authB })
  check("first resend succeeds", resend1.status === 200 && resend1.json.sent === true,
    JSON.stringify(resend1.json))
  check("a fresh email arrived", linkFor(emailB) !== linkB)
  check("still exactly one live token — the previous one was purged",
    (await prisma.authToken.count({ where: { userId: userB.id, type: "EMAIL_VERIFICATION" as const } })) === 1)

  const resend2 = await req("/api/auth/resend-verification", { method: "POST", headers: authB })
  const resend3 = await req("/api/auth/resend-verification", { method: "POST", headers: authB })
  const resend4 = await req("/api/auth/resend-verification", { method: "POST", headers: authB })
  check("second and third resends succeed", resend2.status === 200 && resend3.status === 200,
    `${resend2.status} ${resend3.status}`)
  check("the fourth is refused with 429", resend4.status === 429,
    `status=${resend4.status} body=${JSON.stringify(resend4.json)}`)

  // ── 7. The POST transport the native client uses ───────────────────────────
  console.log("\n[7] POST /api/auth/verify-email — the native transport")

  const linkB2 = linkFor(emailB)!
  const rawB = new URL(linkB2).searchParams.get("token")!
  const postVerify = await req("/api/auth/verify-email", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ token: rawB }),
  })
  check("POST with the token verifies the account",
    postVerify.status === 200 && postVerify.json.alreadyVerified === false &&
    postVerify.json.leavesAwarded === expected,
    JSON.stringify(postVerify.json))

  const snapB2 = await snapshot(userB.id)
  printLedger("B's ledger after POST verification", snapB2.txs)
  check("B now verified with the same two rows",
    snapB2.isVerified && snapB2.txs.length === 2 && snapB2.leaves === expected,
    JSON.stringify({ v: snapB2.isVerified, n: snapB2.txs.length, l: snapB2.leaves }))

  // ── 8. The ledger invariant ────────────────────────────────────────────────
  // ── 7b. Password reset, through the pages, with no JavaScript ─────────────
  // The same rule as the Confirm button: every step is a plain form a browser
  // submits on its own. Forgot page → email → reset page → new password works.
  console.log("\n[7b] password reset through /auth/forgot and /auth/reset-password (forms only)")

  const forgotPage = await fetch(`${BASE}/auth/forgot`, { headers: { accept: "text/html" } })
  const forgotForm = parseForm(await forgotPage.text())
  check("the forgot page carries a plain POST form",
    forgotPage.status === 200 && forgotForm?.action === "/api/auth/forgot-password" && forgotForm.method === "post",
    JSON.stringify(forgotForm))
  const asked = await submitForm("/api/auth/forgot-password", { ...forgotForm?.fields, email: emailA })
  check("submitting it answers 303 to 'check your email'",
    asked.status === 303 && asked.location.includes("/auth/forgot?status=sent"), `status=${asked.status} location=${asked.location}`)

  const resetLink = resetLinkFor(emailA)
  check("a reset email arrived with a link to the reset page", resetLink !== null)
  if (!resetLink) throw new Error("no reset link captured — cannot continue")
  const resetPath = resetLink.slice(new URL(resetLink).origin.length)
  const resetPage = await fetch(`${BASE}${resetPath}`, { headers: { accept: "text/html" } })
  const resetForm = parseForm(await resetPage.text())
  check("the reset page carries a plain POST form with the token",
    resetPage.status === 200 && resetForm?.action === "/api/auth/reset-password" &&
    resetForm.fields.token === new URL(resetLink).searchParams.get("token"), JSON.stringify(resetForm))
  if (!resetForm) throw new Error("no reset form on the page — cannot continue")

  const NEW_PASSWORD = "a-new-horse-battery"
  const mismatch = await submitForm(resetForm.action, { ...resetForm.fields, password: NEW_PASSWORD, confirm: "something-else" })
  check("mismatched passwords go back to the form, token kept, password not in the URL",
    mismatch.status === 303 && mismatch.location.includes("error=mismatch") &&
    mismatch.location.includes(`token=${resetForm.fields.token}`) && !mismatch.location.includes(NEW_PASSWORD),
    mismatch.location)

  const saved = await submitForm(resetForm.action, { ...resetForm.fields, password: NEW_PASSWORD, confirm: NEW_PASSWORD })
  check("a matching pair answers 303 to 'password updated'",
    saved.status === 303 && saved.location.endsWith("/auth/reset-password?status=saved"), saved.location)
  const newLogin = await req("/api/auth/token", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ email: emailA, password: NEW_PASSWORD }),
  })
  check("the new password signs in", newLogin.status === 200 && typeof newLogin.json.accessToken === "string",
    `status=${newLogin.status}`)
  const oldLogin = await req("/api/auth/token", {
    method: "POST", headers: jsonHeaders, body: JSON.stringify({ email: emailA, password: PASSWORD }),
  })
  check("the old password no longer does", oldLogin.status === 401, `status=${oldLogin.status}`)
  const resetAgain = await submitForm(resetForm.action, { ...resetForm.fields, password: NEW_PASSWORD, confirm: NEW_PASSWORD })
  check("the spent reset link lands on 'didn't work'",
    resetAgain.status === 303 && resetAgain.location.endsWith("/auth/reset-password?status=invalid"), resetAgain.location)

  console.log("\n[8] ledger invariant")

  const after = await ledgerTotals()
  console.log(`Ledger after:  SUM(User.leaves)=${after.userLeaves}  ` +
              `SUM(positive rows)=${after.positiveRows}  SUM(all rows)=${after.allRows}`)
  const mine = await runTotals()
  console.log(`This run's accounts: leaves=${mine.userLeaves}  positive rows=${mine.positiveRows}  all rows=${mine.allRows}`)
  check("this run's accounts were touched by credits only (positive rows == all rows == leaves)",
    mine.userLeaves === mine.positiveRows && mine.positiveRows === mine.allRows,
    `${mine.userLeaves} / ${mine.positiveRows} / ${mine.allRows}`)
  check("SUM(User.leaves) equals the sum of ALL LeafTransaction rows",
    after.userLeaves === after.allRows, `${after.userLeaves} vs ${after.allRows}`)
  check(`this run moved both sides by the same ${2 * expected}`,
    after.userLeaves - before.userLeaves === 2 * expected &&
    after.allRows - before.allRows === 2 * expected,
    `leaves +${after.userLeaves - before.userLeaves}, rows +${after.allRows - before.allRows}`)

  // ── Cleanup ────────────────────────────────────────────────────────────────
  // The test accounts are removed so the invariant above stays true of a
  // database that contains only real users. Cascades take the ledger rows,
  // task completions and any remaining tokens with them.
  await prisma.user.deleteMany({ where: { email: { startsWith: P } } })
  const cleaned = await ledgerTotals()
  console.log(`\nCleaned up. Ledger restored: SUM(User.leaves)=${cleaned.userLeaves}  ` +
              `SUM(positive rows)=${cleaned.positiveRows}`)
  check("removing the test accounts restores the starting totals",
    cleaned.userLeaves === before.userLeaves && cleaned.positiveRows === before.positiveRows,
    `${cleaned.userLeaves}/${cleaned.positiveRows} vs ${before.userLeaves}/${before.positiveRows}`)

  sink.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exitCode = 1
}

/** Logs in over the native token endpoint and returns the access token. */
async function bearerFor(email: string): Promise<string> {
  const res = await req("/api/auth/token", {
    method: "POST", headers: jsonHeaders,
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const token = res.json.accessToken
  if (typeof token !== "string") {
    throw new Error(`could not obtain a bearer token: ${res.status} ${JSON.stringify(res.json)}`)
  }
  return token
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect(); process.exit(process.exitCode ?? 0) })
