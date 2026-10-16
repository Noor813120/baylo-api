import nodemailer from "nodemailer"
import { VERIFY_CREDIT_LEAVES } from "@/lib/task-constants"
import {
  button,
  codeCells,
  escapeHtml,
  paragraph,
  renderEmailHtml,
  renderEmailText,
  strong,
  type EmailContent,
} from "@/lib/email-layout"

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
 * see the note at the top of that file for why it is tables, inline styles,
 * a hosted logo beside a text wordmark, and never an inlined image.
 *
 * The build* functions are pure and exported so a message can be rendered
 * without sending it (scripts/preview-emails.ts). The send* functions are the
 * only callers that touch SMTP.
 */

export type BuiltEmail = { subject: string; html: string; text: string }

const FROM = () => process.env.EMAIL_FROM ?? "Baylo <no-reply@baylo.ph>"

const hi = (name?: string | null) => (name ? `Hi ${name},` : "Hi there,")

function build(subject: string, content: EmailContent, textLines: string[]): BuiltEmail {
  return { subject, html: renderEmailHtml(content), text: renderEmailText(textLines, content) }
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
  const offer = `Confirm your email to get your ${VERIFY_CREDIT_LEAVES} welcome Leaves.`
  const welcome = name ? `Hi ${name}, welcome to Baylo.` : "Welcome to Baylo."
  return build(
    "Confirm your Baylo email",
    {
      title: "Confirm your Baylo email",
      preheader: offer,
      heading: "Confirm your email",
      body: paragraph(escapeHtml(welcome), 16) +
        paragraph(offer) +
        button(verifyUrl, "Confirm my email"),
      expiry: "This link expires in 24 hours and works once.",
      reason: "You got this email because this address was used to create a Baylo account.",
      ignore: "If you didn't sign up for Baylo, you can ignore this email.",
    },
    ["Confirm your Baylo email", "", welcome, "", `${offer} Open this link:`, verifyUrl],
  )
}

export async function sendVerificationEmail(to: string, verifyUrl: string, name?: string | null) {
  const m = buildVerificationEmail(verifyUrl, name)
  await transporter.sendMail({ from: FROM(), to, subject: m.subject, html: m.html, text: m.text })
}

// ── Password reset ────────────────────────────────────────────────────────────

const RESET_EXPIRY = "30 minutes"

export function buildPasswordResetEmail(resetUrl: string, name?: string | null): BuiltEmail {
  const ask = "We got a request to reset the password for your Baylo account. Choose a new one with the button below."
  return build(
    "Reset your Baylo password",
    {
      title: "Reset your Baylo password",
      preheader: "Choose a new password for your Baylo account.",
      heading: "Reset your password",
      body: paragraph(escapeHtml(hi(name)), 16) + paragraph(ask) + button(resetUrl, "Choose a new password"),
      expiry: `This link expires in ${RESET_EXPIRY} and works once.`,
      reason: "You got this email because a password reset was requested for this address.",
      ignore: "If you didn't ask for this, you can ignore this email. Your password won't change.",
    },
    [
      "Reset your Baylo password",
      "",
      hi(name),
      "",
      "We got a request to reset the password for your Baylo account. Choose a new one here:",
      resetUrl,
    ],
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
      body:
        paragraph(escapeHtml(hi(recipientName)), 16) +
        paragraph(
          `You&rsquo;re meeting ${strong(otherUserName)} to swap ${strong(items.yours)} for ${strong(items.theirs)}. ` +
            `Read this code to ${escapeHtml(otherUserName)} when you meet. They type it into the app.`,
        ) +
        codeCells(code) +
        paragraph(
          `Then ${escapeHtml(otherUserName)} reads their code to you and you type it in. Both correct means the swap is confirmed.`,
          16,
        ),
      expiry: "This code expires in 15 minutes and works once.",
      reason: "You got this email because a swap you're part of reached its meetup step.",
      ignore: "If you aren't meeting anyone, you can ignore this email. Nothing is confirmed without the code.",
    },
    [
      `Your Baylo swap code: ${code}`,
      "",
      hi(recipientName),
      "",
      `You're meeting ${otherUserName} to swap ${items.yours} for ${items.theirs}. Read this code to ${otherUserName} when you meet. They type it into the app.`,
      "",
      `Your code: ${code}`,
      "",
      `Then ${otherUserName} reads their code to you and you type it in. Both correct means the swap is confirmed.`,
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
