"use client"

import { useState, type CSSProperties } from "react"
import {
  BackToApp,
  LandingBody,
  LandingHeading,
  LandingShell,
  PrimaryAction,
  StatusMark,
  landing,
} from "../_components/EmailLanding"

/**
 * Asks for a password-reset email. Reached from the reset page's "Get a new
 * reset link", so it wears the same shell as the pages the emails land on.
 *
 * "Sent" is shown for any 200, whether or not the address has an account —
 * the API answers 200 either way so this page cannot be used to test which
 * emails are registered, and the copy says "if" for the same reason.
 */

type State =
  | { kind: "form"; error?: string }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "server" }

const fieldStyle: CSSProperties = {
  width: "100%",
  height: 52,
  boxSizing: "border-box",
  borderRadius: 10,
  border: `1px solid ${landing.line}`,
  background: landing.control,
  padding: "0 14px",
  fontFamily: "inherit",
  fontSize: 16,
  color: landing.ink,
  outline: "none",
  marginBottom: 20,
}

export default function ForgotPasswordPage() {
  const [state, setState] = useState<State>({ kind: "form" })
  const [email, setEmail] = useState("")

  async function send(e?: { preventDefault(): void }) {
    e?.preventDefault()
    const address = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      return setState({ kind: "form", error: "Enter the email address on your Baylo account." })
    }

    setState({ kind: "sending" })
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: address }),
      })
      if (res.ok) return setState({ kind: "sent", email: address })
      if (res.status === 429) {
        return setState({ kind: "form", error: "Too many reset emails for now. Try again in an hour." })
      }
      if (res.status === 400) return setState({ kind: "form", error: "Check the email address and try again." })
      setState({ kind: "server" })
    } catch {
      setState({ kind: "server" })
    }
  }

  let content
  switch (state.kind) {
    case "form":
    case "sending":
      content = (
        <>
          <StatusMark tone="neutral" glyph="key" />
          <LandingHeading>Reset your password</LandingHeading>
          <LandingBody>Enter the email on your Baylo account and we&rsquo;ll send you a link to choose a new password.</LandingBody>
          <form onSubmit={send} noValidate>
            <label htmlFor="email" style={{ display: "block", fontSize: 12, fontWeight: 600, color: landing.muted, margin: "0 0 6px" }}>
              Email
            </label>
            <input
              id="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={fieldStyle}
            />
            {state.kind === "form" && state.error ? (
              <p role="alert" style={{ fontSize: 14, lineHeight: "20px", color: landing.urgent, margin: "-4px 0 16px" }}>
                {state.error}
              </p>
            ) : null}
            <PrimaryAction type="submit" busy={state.kind === "sending"}>
              {state.kind === "sending" ? "Sending…" : "Send reset link"}
            </PrimaryAction>
          </form>
        </>
      )
      break
    case "sent":
      content = (
        <>
          <StatusMark tone="ok" glyph="mail" />
          <LandingHeading>Check your email</LandingHeading>
          <LandingBody>
            If <strong style={{ color: landing.ink }}>{state.email}</strong>{" "}has a Baylo account, a reset link is on its
            way. It expires in 30 minutes. Check spam if it isn&rsquo;t there in a minute.
          </LandingBody>
          <BackToApp />
        </>
      )
      break
    case "server":
      content = (
        <>
          <StatusMark tone="bad" glyph="alert" />
          <LandingHeading>Something went wrong</LandingHeading>
          <LandingBody>We couldn&rsquo;t send the email just now. That&rsquo;s on our side. Try again in a moment.</LandingBody>
          <PrimaryAction onClick={() => void send()}>Try again</PrimaryAction>
        </>
      )
      break
  }

  return <LandingShell>{content}</LandingShell>
}
