import {
  ActionLink,
  BackToApp,
  LandingAlert,
  LandingBody,
  LandingHeading,
  LandingShell,
  SubmitButton,
  TextField,
  param,
} from "../_components/EmailLanding"

/**
 * Where the password-reset email's link lands. Same shell as the verify page.
 *
 * Opening it spends nothing: the token is only presented with the new
 * password, by a plain form POST to /api/auth/reset-password that answers 303
 * back here. A SERVER COMPONENT WITH NO CLIENT CODE — the form works whether
 * or not the page hydrates (see _components/EmailLanding.tsx).
 *
 * A reset signs out every device (see the API route), so "saved" sends the
 * person back to the app to sign in rather than to the retired web login.
 */

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const FORM_ERROR: Record<string, string> = {
  short: "Use at least 8 characters.",
  mismatch: "The two passwords don’t match.",
}

function ResetForm({ token, error, retry }: { token: string; error?: string; retry?: boolean }) {
  return (
    <form method="post" action="/api/auth/reset-password">
      {error ? <LandingAlert>{error}</LandingAlert> : null}
      <input type="hidden" name="token" value={token} />
      <TextField id="password" name="password" label="New password" type="password" autoComplete="new-password" />
      <TextField id="confirm" name="confirm" label="Confirm password" type="password" autoComplete="new-password" />
      <div style={{ height: 4 }} />
      <SubmitButton>{retry ? "Try again" : "Save new password"}</SubmitButton>
    </form>
  )
}

export default async function ResetPasswordPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = param(sp, "status")
  const token = param(sp, "token")

  let content
  if (status === "saved") {
    content = (
      <>
        <LandingHeading>Password updated</LandingHeading>
        <LandingBody>Your new password is saved. Sign in with it in the Baylo app.</LandingBody>
        <BackToApp />
      </>
    )
  } else if (status === "expired" || status === "invalid" || !token) {
    content = (
      <>
        <LandingHeading>{status === "expired" ? "This link has expired" : "This link didn’t work"}</LandingHeading>
        <LandingBody>
          {status === "expired"
            ? "Reset links last 30 minutes and work once."
            : "It has already been used or isn’t complete."}{" "}
          Ask for a new one and we&rsquo;ll email it right away.
        </LandingBody>
        <ActionLink href="/auth/forgot">Get a new reset link</ActionLink>
      </>
    )
  } else if (status === "server") {
    content = (
      <>
        <LandingHeading>Something went wrong</LandingHeading>
        <LandingBody>
          We couldn&rsquo;t save your password just now. That&rsquo;s on our side. Your link still works, so try again.
        </LandingBody>
        <ResetForm token={token} retry />
      </>
    )
  } else {
    content = (
      <>
        <LandingHeading>Choose a new password</LandingHeading>
        <LandingBody>Use at least 8 characters. You&rsquo;ll be signed out on every device.</LandingBody>
        <ResetForm token={token} error={FORM_ERROR[param(sp, "error")]} />
      </>
    )
  }

  return <LandingShell>{content}</LandingShell>
}
