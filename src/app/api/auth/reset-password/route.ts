import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import prisma from "@/lib/prisma"
import { parseBody, resetPasswordSchema } from "@/lib/validation"
import { hashResetToken } from "@/lib/reset-token"
import { revokeUserFamilies } from "@/lib/auth-tokens"
import { crossSiteRefusal, formField, isFormPost, seeOther } from "@/lib/form-post"

/**
 * Sets a new password from a reset link. Two encodings, one core:
 *   JSON  { token, password }            answered JSON (unchanged).
 *   form  token, password, confirm       the reset page's plain HTML form
 *                                        (works without JavaScript); answered
 *                                        303 to /auth/reset-password's state.
 */

type ResetOutcome = "saved" | "invalid" | "expired"

/**
 * The one place a reset token is checked and spent. The token is deleted only
 * after the password is written, so a failure before that leaves the link
 * usable for another try.
 */
async function resetPassword(token: string, password: string): Promise<ResetOutcome> {
  // Only the hash is stored (schema v2), so the presented token is hashed and
  // looked up; a hash of any other token type is not a reset link.
  const record = await prisma.authToken.findUnique({ where: { tokenHash: hashResetToken(token) } })
  if (!record || record.type !== "PASSWORD_RESET") return "invalid"
  if (record.expiresAt < new Date()) return "expired"

  const hashed = await bcrypt.hash(password, 12)

  await prisma.user.update({
    where: { id: record.userId },
    data: { password: hashed },
  })

  await prisma.authToken.delete({ where: { id: record.id } })

  // Every device is signed out. A reset is what someone does when they think
  // the password is known to someone else, and a session that person already
  // holds would otherwise outlive the new password by up to thirty days. The
  // caller here holds no session to keep: they came in through an email link.
  await revokeUserFamilies(record.userId)

  return "saved"
}

export async function POST(req: NextRequest) {
  if (isFormPost(req)) return formPost(req)

  // resetPasswordSchema applies the same 8-character minimum as registration.
  // This route previously checked only that a password was present, so the one
  // flow that exists specifically to replace a compromised password was also
  // the one flow that would accept a single character.
  const parsed = await parseBody(req, resetPasswordSchema)
  if (!parsed.ok) return parsed.response
  const { token, password } = parsed.data

  const outcome = await resetPassword(token, password)
  // `code` lets a caller say which it was. Both stay 400, with one message.
  if (outcome === "invalid") {
    return NextResponse.json({ error: "Reset link is invalid or has expired", code: "INVALID_TOKEN" }, { status: 400 })
  }
  if (outcome === "expired") {
    return NextResponse.json({ error: "Reset link is invalid or has expired", code: "EXPIRED_TOKEN" }, { status: 400 })
  }
  return NextResponse.json({ ok: true })
}

/**
 * The reset page's form. A form error (too short, mismatch) goes back to the
 * form with the token kept — the password itself is never put in a URL, so
 * the fields come back empty. A server failure keeps the token too: the token
 * is spent only after the new password is written.
 */
async function formPost(req: NextRequest): Promise<NextResponse> {
  const refused = crossSiteRefusal(req)
  if (refused) return refused

  const page = "/auth/reset-password"
  let token = "", password = "", confirm = ""
  try {
    const form = await req.formData()
    token = formField(form, "token").trim()
    password = formField(form, "password")
    confirm = formField(form, "confirm")
  } catch {
    return seeOther(req, page, { status: "invalid" })
  }

  if (!token || token.length > 200) return seeOther(req, page, { status: "invalid" })
  if (!resetPasswordSchema.safeParse({ token, password }).success) return seeOther(req, page, { token, error: "short" })
  if (password !== confirm) return seeOther(req, page, { token, error: "mismatch" })

  try {
    const outcome = await resetPassword(token, password)
    return seeOther(req, page, { status: outcome })
  } catch (err) {
    console.error("[reset-password form]", err instanceof Error ? err.message : "unknown error")
    return seeOther(req, page, { status: "server", token })
  }
}
