import { VERIFY_CREDIT_LEAVES } from "@/lib/task-constants"
import {
  BackToApp,
  Em,
  LandingBody,
  LandingHeading,
  LandingHelp,
  LandingShell,
  SubmitButton,
  param,
} from "../_components/EmailLanding"

/**
 * Where the verification email's link lands.
 *
 * OPENING THIS PAGE VERIFIES NOTHING. The token sits in the address bar and in
 * a hidden field, unspent, until the person presses "Confirm my email" — a
 * plain form POST to /api/auth/verify-email, which redeems it and answers 303
 * back here with `?status=`. Mail scanners and link previews open every link
 * in a message; a link that verified on open would be spent, and the account
 * verified, by a machine before the person saw it.
 *
 * A SERVER COMPONENT WITH NO CLIENT CODE. The button works whether or not the
 * page hydrates — see the note in _components/EmailLanding.tsx.
 *
 * `status` and `leaves` in the URL are display only: anyone can type them, and
 * all they change is which sentence this page prints. The account changes only
 * through the POST.
 */

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }

const RESEND = (
  <>
    open the Baylo app and tap <Em>Resend email</Em> on the verify reminder
  </>
)

function ConfirmForm({ token, label }: { token: string; label: string }) {
  return (
    <form method="post" action="/api/auth/verify-email">
      <input type="hidden" name="token" value={token} />
      <SubmitButton>{label}</SubmitButton>
    </form>
  )
}

export default async function VerifyEmailPage({ searchParams }: Props) {
  const sp = await searchParams
  const status = param(sp, "status")
  const token = param(sp, "token")

  let content
  switch (status) {
    case "verified": {
      const leaves = Number.parseInt(param(sp, "leaves"), 10)
      content = (
        <>
          <LandingHeading>You&rsquo;re verified</LandingHeading>
          <LandingBody>
            Your email is verified.
            {leaves > 0 && leaves <= 10_000 ? ` ${leaves} welcome Leaves are in your balance.` : ""}
          </LandingBody>
          <BackToApp />
        </>
      )
      break
    }
    case "already":
      content = (
        <>
          <LandingHeading>Already verified</LandingHeading>
          <LandingBody>
            This email was already confirmed, so there&rsquo;s nothing else to do. Your welcome Leaves were added the
            first time.
          </LandingBody>
          <BackToApp />
        </>
      )
      break
    case "expired":
      content = (
        <>
          <LandingHeading>This link has expired</LandingHeading>
          <LandingBody>Verification links last 24 hours. To get a new one, {RESEND}.</LandingBody>
          <BackToApp label="Open the Baylo app" />
        </>
      )
      break
    case "server":
      content = (
        <>
          <LandingHeading>Something went wrong</LandingHeading>
          <LandingBody>We couldn&rsquo;t check your link just now. That&rsquo;s on our side. Try again in a moment.</LandingBody>
          {token ? <ConfirmForm token={token} label="Try again" /> : null}
          <LandingHelp>Still not working? To get a new link, {RESEND}.</LandingHelp>
        </>
      )
      break
    default:
      if (status !== "invalid" && token) {
        content = (
          <>
            <LandingHeading>Confirm your email</LandingHeading>
            <LandingBody>Confirm your email to get your {VERIFY_CREDIT_LEAVES} welcome Leaves.</LandingBody>
            <ConfirmForm token={token} label="Confirm my email" />
            <LandingHelp>This link expires 24 hours after it was sent.</LandingHelp>
          </>
        )
      } else if (status !== "invalid" && param(sp, "sent") === "1") {
        // The web signup's own "we sent it" screen. Nothing to confirm here.
        const email = param(sp, "email")
        content = (
          <>
            <LandingHeading>Check your email</LandingHeading>
            <LandingBody>
              We sent a link to {email ? <Em>{email}</Em> : "your email"}. Open it and tap the button to get your{" "}
              {VERIFY_CREDIT_LEAVES} welcome Leaves.
            </LandingBody>
            <BackToApp />
          </>
        )
      } else {
        content = (
          <>
            <LandingHeading>This link didn&rsquo;t work</LandingHeading>
            <LandingBody>
              It has already been used or isn&rsquo;t complete. If you already confirmed your email, you&rsquo;re all
              set. If not, {RESEND}.
            </LandingBody>
            <BackToApp label="Open the Baylo app" />
          </>
        )
      }
  }

  return <LandingShell>{content}</LandingShell>
}
