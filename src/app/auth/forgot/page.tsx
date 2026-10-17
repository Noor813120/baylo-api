import {
  BackToApp,
  Em,
  LandingAlert,
  LandingBody,
  LandingHeading,
  LandingShell,
  SubmitButton,
  TextField,
  param,
} from "../_components/EmailLanding"

/**
 * Asks for a password-reset email. Reached from the reset page's "Get a new
 * reset link", so it wears the same shell as the pages the emails land on.
 *
 * A SERVER COMPONENT WITH NO CLIENT CODE: a plain form POST to
 * /api/auth/forgot-password, answered 303 back here with `?status=` or
 * `?error=`. "Sent" is shown whether or not the address has an account — the
 * API answers the same either way, so this page cannot be used to test which
 * emails are registered, and the copy says "if" for the same reason.
 */

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const FORM_ERROR: Record<string, string> = {
  invalid: "Enter the email address on your Baylo account.",
  rate: "Too many reset emails for now. Try again in an hour.",
}

function ForgotForm({ email, error, retry }: { email: string; error?: string; retry?: boolean }) {
  return (
    <form method="post" action="/api/auth/forgot-password">
      {error ? <LandingAlert>{error}</LandingAlert> : null}
      <TextField id="email" name="email" label="Email" type="email" autoComplete="email" defaultValue={email} />
      <div style={{ height: 4 }} />
      <SubmitButton>{retry ? "Try again" : "Send reset link"}</SubmitButton>
    </form>
  )
}

export default async function ForgotPasswordPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = param(sp, "status")
  const email = param(sp, "email")

  let content
  if (status === "sent") {
    content = (
      <>
        <LandingHeading>Check your email</LandingHeading>
        <LandingBody>
          If {email ? <Em>{email}</Em> : "that address"} has a Baylo account, a reset link is on its way. It expires in
          30 minutes.
        </LandingBody>
        <BackToApp />
      </>
    )
  } else if (status === "server") {
    content = (
      <>
        <LandingHeading>Something went wrong</LandingHeading>
        <LandingBody>We couldn&rsquo;t send the email just now. That&rsquo;s on our side. Try again in a moment.</LandingBody>
        <ForgotForm email={email} retry />
      </>
    )
  } else {
    content = (
      <>
        <LandingHeading>Reset your password</LandingHeading>
        <LandingBody>Enter the email on your Baylo account and we&rsquo;ll send you a link to choose a new one.</LandingBody>
        <ForgotForm email={email} error={FORM_ERROR[param(sp, "error")]} />
      </>
    )
  }

  return <LandingShell>{content}</LandingShell>
}
