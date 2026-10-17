import nodemailer from "nodemailer"
import { VERIFY_CREDIT_LEAVES } from "@/lib/task-constants"
import { escapeHtml, renderEmailHtml, renderEmailText, strong, type EmailContent } from "@/lib/email-layout"

const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_SMTP_HOST,
  port: Number(process.env.EMAIL_SMTP_PORT ?? 587),
  secure: false,
  connectionTimeout: 8000,
  greetingTimeout:   8000,
  socketTimeout:     10000,
  auth: {
    user: process.env.EMAIL_SMTP_USER,
    pass: process.env.EMAIL_SMTP_PASS,
  },
})

/*
 * Every message here is built from the one layout in lib/email-layout.ts —
 * see the note at the top of that file for the design and its rules.
 *
 * The build* functions are pure and exported so a message can be rendered
 * without sending it (scripts/preview-emails.ts). The send* functions are the
 * only callers that touch SMTP, and their signatures are unchanged.
 *
 * The recipient's name goes in the plain-text part's greeting only: the HTML
 * is a heading and ONE line, and the line is about the action, not the person.
 */

export type BuiltEmail = { subject: string; html: string; text: string }

const FROM = () => process.env.EMAIL_FROM ?? "Baylo <no-reply@baylo.ph>"

const hi = (name?: string | null) => (name ? `Hi ${name},` : "Hi there,")

function build(subject: string, content: EmailContent, textLines: string[]): BuiltEmail {
  return { subject, html: renderEmailHtml(content), text: renderEmailText(content, textLines) }
}

// ── Email verification ────────────────────────────────────────────────────────

/**
 * The verification email. `verifyUrl` opens the confirm page; nothing is spent
 * until the person presses the button there — see app/auth/verify-email.
 *
 * The Leaves figure is VERIFY_CREDIT_LEAVES, never a literal: this copy has
 * drifted from the ledger once already ("50" while 60 was credited). It names
 * the total that lands and does not explain how it is made up.
 */
export function buildVerificationEmail(verifyUrl: string, name?: string | null): BuiltEmail {
  const line = `Confirm your email to get your ${VERIFY_CREDIT_LEAVES} welcome Leaves.`
  return build(
    "Confirm your Baylo email",
    {
      title: "Confirm your Baylo email",
      preheader: line,
      heading: "Confirm your email",
      line: escapeHtml(line),
      cta: { url: verifyUrl, label: "Confirm my email" },
      small: "Expires in 24 hours.",
      footer: "You got this because you signed up for Baylo. Didn't sign up? Ignore this email.",
    },
    [hi(name), "", line, verifyUrl],
  )
}

export async function sendVerificationEmail(to: string, verifyUrl: string, name?: string | null) {
  const m = buildVerificationEmail(verifyUrl, name)
  await transporter.sendMail({ from: FROM(), to, subject: m.subject, html: m.html, text: m.text })
}

// ── Password reset ────────────────────────────────────────────────────────────

export function buildPasswordResetEmail(resetUrl: string, name?: string | null): BuiltEmail {
  const line = "Tap below to choose a new password for your Baylo account."
  return build(
    "Reset your Baylo password",
    {
      title: "Reset your Baylo password",
      preheader: "Choose a new password for your Baylo account.",
      heading: "Reset your password",
      line: escapeHtml(line),
      cta: { url: resetUrl, label: "Choose a new password" },
      small: "Expires in 30 minutes.",
      footer: "You got this because a password reset was requested. Didn't ask? Ignore this email.",
    },
    [hi(name), "", "Choose a new password for your Baylo account here:", resetUrl],
  )
}

export async function sendPasswordResetEmail(to: string, resetUrl: string, name?: string | null) {
  const m = buildPasswordResetEmail(resetUrl, name)
  await transporter.sendMail({ from: FROM(), to, subject: m.subject, html: m.html, text: m.text })
}

// ── Swap confirmation code ────────────────────────────────────────────────────

/**
 * The handoff code. Sent by POST /api/trades/[id]/confirm/start each time a
 * fresh pair is issued; the app shows the same code behind "Show my code"
 * when it can, and names this email as the backup when it cannot.
 *
 * TEMPLATE ONLY. How codes are generated, checked, expired and issued lives in
 * the confirm/start and confirm/submit routes and is not this file's business.
 * `items` stays in the signature and in the plain-text part, so the caller is
 * untouched.
 *
 * No button: the code IS the content, and there is nowhere to go.
 */
export function buildSwapCodeEmail(
  code: string,
  recipientName: string | null | undefined,
  otherUserName: string,
  items: { yours: string; theirs: string },
): BuiltEmail {
  return build(
    `Your Baylo swap code: ${code}`,
    {
      title: "Your Baylo swap code",
      preheader: `Your swap code for meeting ${otherUserName}. Read it to them when you meet.`,
      heading: "Your swap code",
      line: `Read this code to ${strong(otherUserName)} when you meet. They type it into the app.`,
      code,
      small: "Expires in 15 minutes and works once.",
      footer: "You got this because your swap reached its meetup step. Not meeting anyone? Ignore this email.",
    },
    [
      hi(recipientName),
      "",
      `Your code: ${code}`,
      "",
      `Read it to ${otherUserName} when you meet to swap ${items.yours} for ${items.theirs}. They type it into the app.`,
    ],
  )
}

export async function sendSwapConfirmationCode(
  to: string,
  name: string | null | undefined,
  code: string,
  otherUserName: string,
  items: { yours: string; theirs: string },
) {
  const m = buildSwapCodeEmail(code, name, otherUserName, items)
  await transporter.sendMail({ from: FROM(), to, subject: m.subject, html: m.html, text: m.text })
}
