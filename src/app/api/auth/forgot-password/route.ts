import { NextRequest, NextResponse } from "next/server"
import crypto from "crypto"
import prisma from "@/lib/prisma"
import { sendPasswordResetEmail } from "@/lib/mailer"
import { publicBaseUrl } from "@/lib/public-url"
import { clientIp, enforceRateLimit } from "@/lib/rate-limit-config"
import { forgotPasswordSchema, parseBody } from "@/lib/validation"
import { hashResetToken } from "@/lib/reset-token"
import { crossSiteRefusal, formField, isFormPost, seeOther } from "@/lib/form-post"

/**
 * Mails a password-reset link. Two encodings, one core:
 *   JSON  { email }  answered JSON (unchanged).
 *   form  email      the /auth/forgot page's plain HTML form (works without
 *                    JavaScript); answered 303 to that page's state.
 * Both answer "sent" whether or not the address has an account.
 */

/**
 * Limited on BOTH axes. Per-email alone lets one caller flood many different
 * mailboxes from one machine; per-IP alone lets a distributed caller flood a
 * single victim. Each sends mail on our SMTP quota, so both are capped.
 */
function rateLimited(req: NextRequest, email: string): NextResponse | null {
  return (
    enforceRateLimit("forgotPassword", `email:${email}`) ??
    enforceRateLimit("forgotPassword", `ip:${clientIp(req)}`)
  )
}

/** Issues a token and mails the link, if the account exists. Throws on failure. */
async function sendReset(req: NextRequest, email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) return

  // Delete any existing reset token for this account. AuthToken (schema v2)
  // keys it on the user, not the email, and stores only its SHA-256.
  await prisma.authToken.deleteMany({ where: { userId: user.id, type: "PASSWORD_RESET" } })

  const token = crypto.randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000) // 30 min

  await prisma.authToken.create({
    data: { type: "PASSWORD_RESET", userId: user.id, tokenHash: hashResetToken(token), expiresAt },
  })

  const resetUrl = `${publicBaseUrl(req)}/auth/reset-password?token=${token}`
  await sendPasswordResetEmail(email, resetUrl, user.name)
}

export async function POST(req: NextRequest) {
  if (isFormPost(req)) return formPost(req)

  const parsed = await parseBody(req, forgotPasswordSchema)
  if (!parsed.ok) return parsed.response
  const { email } = parsed.data

  const limited = rateLimited(req, email)
  if (limited) return limited

  try {
    await sendReset(req, email)
    // Always return 200 — don't reveal whether account exists
    return NextResponse.json({ ok: true })
  } catch (err) {
    // The exception stays server-side. Returning err.message handed the caller
    // SMTP host details and internal failure text.
    console.error("forgot-password error:", err instanceof Error ? err.message : "unknown error")
    return NextResponse.json({ error: "Could not send the reset email" }, { status: 500 })
  }
}

async function formPost(req: NextRequest): Promise<NextResponse> {
  const refused = crossSiteRefusal(req)
  if (refused) return refused

  const page = "/auth/forgot"
  let raw = ""
  try {
    raw = formField(await req.formData(), "email").trim()
  } catch {
    return seeOther(req, page, { error: "invalid" })
  }

  const parsed = forgotPasswordSchema.safeParse({ email: raw })
  if (!parsed.success) return seeOther(req, page, { error: "invalid", email: raw.slice(0, 200) })
  const { email } = parsed.data

  if (rateLimited(req, email)) return seeOther(req, page, { error: "rate", email })

  try {
    await sendReset(req, email)
    return seeOther(req, page, { status: "sent", email })
  } catch (err) {
    console.error("forgot-password form error:", err instanceof Error ? err.message : "unknown error")
    return seeOther(req, page, { status: "server", email })
  }
}
