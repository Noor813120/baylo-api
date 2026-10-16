"use client"

import { Suspense, useState, type CSSProperties } from "react"
import { useSearchParams } from "next/navigation"
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
 * Where the password-reset email's link lands. Same shell as the verify page.
 *
 * Like that page, opening it spends nothing: the token is only presented with
 * the new password, by the form's POST to /api/auth/reset-password. The API
 * answers `code: EXPIRED_TOKEN | INVALID_TOKEN` on a 400 so the page can say
 * which; anything else that is not a 400 is "something went wrong", and the
 * link is still good for another try.
 *
 * A reset signs out every device (see the API route), so "saved" sends the
 * person back to the app to sign in rather than to the retired web login.
 */

type State =
  | { kind: "form"; error?: string }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "expired" }
  | { kind: "invalid" }
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
  marginBottom: 16,
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: landing.muted,
  margin: "0 0 6px",
}

function ResetContent() {
  const params = useSearchParams()
  const token = (params.get("token") ?? "").trim()

  const [state, setState] = useState<State>(token ? { kind: "form" } : { kind: "invalid" })
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [show, setShow] = useState(false)

  async function save(e?: React.FormEvent) {
    e?.preventDefault()
    if (password.length < 8) return setState({ kind: "form", error: "Use at least 8 characters." })
    if (password !== confirm) return setState({ kind: "form", error: "The two passwords don't match." })

    setState({ kind: "saving" })
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token, password }),
      })
      const data = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
      if (res.ok) setState({ kind: "saved" })
      else if (data.code === "EXPIRED_TOKEN") setState({ kind: "expired" })
      else if (data.code === "INVALID_TOKEN") setState({ kind: "invalid" })
      else if (res.status === 400) setState({ kind: "form", error: data.error ?? "Check the password and try again." })
      else setState({ kind: "server" })
    } catch {
      setState({ kind: "server" })
    }
  }

  switch (state.kind) {
    case "form":
    case "saving":
      return (
        <>
          <StatusMark tone="neutral" glyph="key" />
          <LandingHeading>Choose a new password</LandingHeading>
          <LandingBody>Use at least 8 characters. You&rsquo;ll be signed out on every device.</LandingBody>
          <form onSubmit={save} noValidate>
            <label htmlFor="pw" style={labelStyle}>New password</label>
            <input
              id="pw"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={fieldStyle}
            />
            <label htmlFor="pw2" style={labelStyle}>Confirm password</label>
            <input
              id="pw2"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={fieldStyle}
            />
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: landing.body, margin: "-4px 0 20px" }}>
              <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
              Show passwords
            </label>
            {state.kind === "form" && state.error ? (
              <p role="alert" style={{ fontSize: 14, lineHeight: "20px", color: landing.urgent, margin: "0 0 16px" }}>
                {state.error}
              </p>
            ) : null}
            <PrimaryAction type="submit" busy={state.kind === "saving"}>
              {state.kind === "saving" ? "Saving…" : "Save new password"}
            </PrimaryAction>
          </form>
        </>
      )
    case "saved":
      return (
        <>
          <StatusMark tone="ok" glyph="check" />
          <LandingHeading>Password updated</LandingHeading>
          <LandingBody>Your new password is saved. Sign in with it in the Baylo app.</LandingBody>
          <BackToApp />
        </>
      )
    case "expired":
    case "invalid":
      return (
        <>
          <StatusMark tone="bad" glyph={state.kind === "expired" ? "clock" : "alert"} />
          <LandingHeading>{state.kind === "expired" ? "This link has expired" : "This link didn’t work"}</LandingHeading>
          <LandingBody>
            {state.kind === "expired"
              ? "Reset links last 30 minutes and work once."
              : "It has already been used or isn’t complete."}{" "}
            Ask for a new one and we&rsquo;ll email it right away.
          </LandingBody>
          <PrimaryAction href="/auth/forgot">Get a new reset link</PrimaryAction>
        </>
      )
    case "server":
      return (
        <>
          <StatusMark tone="bad" glyph="alert" />
          <LandingHeading>Something went wrong</LandingHeading>
          <LandingBody>
            We couldn&rsquo;t save your password just now. That&rsquo;s on our side. Your link still works, so try again
            in a moment.
          </LandingBody>
          <PrimaryAction onClick={() => void save()}>Try again</PrimaryAction>
        </>
      )
  }
}

export default function ResetPasswordPage() {
  return (
    <LandingShell>
      <Suspense fallback={null}>
        <ResetContent />
      </Suspense>
    </LandingShell>
  )
}
