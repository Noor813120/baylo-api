"use client"

import { Suspense, useState } from "react"
import { useSearchParams } from "next/navigation"
import { VERIFY_CREDIT_LEAVES } from "@/lib/task-constants"
import {
  BackToApp,
  LandingBody,
  LandingHeading,
  LandingHelp,
  LandingShell,
  PrimaryAction,
  StatusMark,
} from "../_components/EmailLanding"

/**
 * Where the verification email's link lands.
 *
 * OPENING THIS PAGE VERIFIES NOTHING. The token sits in the address bar and
 * stays unspent until the person presses "Confirm my email", which POSTs it to
 * /api/auth/verify-email. That is the whole point of the extra tap: mail
 * scanners and link previews open every link in a message, and a link that
 * verified on open would be spent — and the account verified — by a machine
 * before the person saw it. Same reason /api/auth/verify-email's GET only
 * redirects here.
 *
 * Every outcome the POST can have is a state below, each with one action.
 */

type State =
  | { kind: "confirm" }
  | { kind: "confirming" }
  | { kind: "verified"; leaves: number }
  | { kind: "already" }
  | { kind: "expired" }
  | { kind: "invalid" }
  | { kind: "server" }

const RESEND_HINT = (
  <>
    Open the Baylo app and tap <strong style={{ color: "#14140F" }}>Resend email</strong> on the verify reminder to get a
    new link.
  </>
)

function VerifyEmailContent() {
  const params = useSearchParams()
  const token = (params.get("token") ?? "").trim()
  const sentTo = params.get("sent") === "1" ? params.get("email") : null

  const [state, setState] = useState<State>(token ? { kind: "confirm" } : { kind: "invalid" })

  async function confirm() {
    setState({ kind: "confirming" })
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      })
      const data = (await res.json().catch(() => ({}))) as {
        alreadyVerified?: boolean
        leavesAwarded?: number
        code?: string
      }
      if (res.ok) {
        setState(data.alreadyVerified ? { kind: "already" } : { kind: "verified", leaves: data.leavesAwarded ?? 0 })
      } else if (data.code === "EXPIRED_TOKEN") {
        setState({ kind: "expired" })
      } else if (res.status === 400) {
        setState({ kind: "invalid" })
      } else {
        setState({ kind: "server" })
      }
    } catch {
      setState({ kind: "server" })
    }
  }

  // The web signup's own "we sent it" screen. No token, nothing to confirm.
  if (!token && sentTo !== null) {
    return (
      <>
        <StatusMark tone="neutral" glyph="mail" />
        <LandingHeading>Check your email</LandingHeading>
        <LandingBody>
          We sent a link to {sentTo ? <strong style={{ color: "#14140F" }}>{sentTo}</strong> : "your email"}. Open it and
          tap the button to get your {VERIFY_CREDIT_LEAVES} welcome Leaves.
        </LandingBody>
        <BackToApp />
      </>
    )
  }

  switch (state.kind) {
    case "confirm":
    case "confirming":
      return (
        <>
          <StatusMark tone="neutral" glyph="mail" />
          <LandingHeading>Confirm your email</LandingHeading>
          <LandingBody>Confirm your email to get your {VERIFY_CREDIT_LEAVES} welcome Leaves.</LandingBody>
          <PrimaryAction onClick={confirm} busy={state.kind === "confirming"}>
            {state.kind === "confirming" ? "Confirming…" : "Confirm my email"}
          </PrimaryAction>
          <LandingHelp>This link expires 24 hours after it was sent.</LandingHelp>
        </>
      )
    case "verified":
      return (
        <>
          <StatusMark tone="ok" glyph="check" />
          <LandingHeading>You&rsquo;re verified</LandingHeading>
          <LandingBody>
            Your email is verified.
            {state.leaves > 0 ? ` ${state.leaves} welcome Leaves are in your balance.` : ""}
          </LandingBody>
          <BackToApp />
        </>
      )
    case "already":
      return (
        <>
          <StatusMark tone="ok" glyph="check" />
          <LandingHeading>Already verified</LandingHeading>
          <LandingBody>
            This email was already confirmed, so there&rsquo;s nothing else to do. Your welcome Leaves were added the
            first time.
          </LandingBody>
          <BackToApp />
        </>
      )
    case "expired":
      return (
        <>
          <StatusMark tone="bad" glyph="clock" />
          <LandingHeading>This link has expired</LandingHeading>
          <LandingBody>Verification links last 24 hours. {RESEND_HINT}</LandingBody>
          <BackToApp label="Open the Baylo app" />
        </>
      )
    case "invalid":
      return (
        <>
          <StatusMark tone="bad" glyph="alert" />
          <LandingHeading>This link didn&rsquo;t work</LandingHeading>
          <LandingBody>
            It has already been used or isn&rsquo;t complete. If you already confirmed your email, you&rsquo;re all set.
            If not, open the Baylo app and tap <strong style={{ color: "#14140F" }}>Resend email</strong> on the verify
            reminder to get a new link.
          </LandingBody>
          <BackToApp label="Open the Baylo app" />
        </>
      )
    case "server":
      return (
        <>
          <StatusMark tone="bad" glyph="alert" />
          <LandingHeading>Something went wrong</LandingHeading>
          <LandingBody>We couldn&rsquo;t check your link just now. That&rsquo;s on our side. Try again in a moment.</LandingBody>
          <PrimaryAction onClick={confirm}>Try again</PrimaryAction>
          <LandingHelp>Still not working? {RESEND_HINT}</LandingHelp>
        </>
      )
  }
}

export default function VerifyEmailPage() {
  return (
    <LandingShell>
      <Suspense fallback={null}>
        <VerifyEmailContent />
      </Suspense>
    </LandingShell>
  )
}
