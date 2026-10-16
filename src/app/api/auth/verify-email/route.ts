import { NextRequest, NextResponse } from "next/server"
import { consumeVerificationToken, type ConsumeResult } from "@/lib/email-verification"
import { publicBaseUrl } from "@/lib/public-url"
import { parseBody, verifyEmailSchema } from "@/lib/validation"

/**
 * Redeems an email verification token.
 *
 * This is a REAL static segment, not something the NextAuth catch-all handles.
 * `src/app/api/auth/[...nextauth]/route.ts` matches every /api/auth/* path and
 * answers 400 for any action it does not recognise, so a verification route
 * that lived only inside it would look like a working endpoint returning a
 * confusing error. Next's router gives a static segment precedence over a
 * catch-all at the same level, which is why this file — and register,
 * forgot-password, token, refresh and revoke before it — resolve here instead.
 * The GET/POST exports below are what prove it: the catch-all's handlers are
 * never invoked for this path.
 *
 * One transport spends a token, and it is POST { token }: the confirm page's
 * button (app/auth/verify-email) and the native client both send it. GET only
 * forwards to the page — see GET below for why. consumeVerificationToken() is
 * the one place a token is validated and spent.
 */

const REASON_STATUS: Record<"invalid" | "expired", number> = {
  // Both are 400 rather than 404/410: the token is a credential, and the caller
  // learns only that this one is not usable. Distinguishing "never existed"
  // from "already spent" would tell a scanner which guesses were close.
  invalid: 400,
  expired: 400,
}

const REASON_MESSAGE: Record<"invalid" | "expired", string> = {
  invalid: "This verification link is invalid or has already been used",
  expired: "This verification link has expired. Request a new one.",
}

function jsonResult(result: ConsumeResult): NextResponse {
  if (!result.ok) {
    return NextResponse.json(
      {
        error: REASON_MESSAGE[result.reason],
        code: result.reason === "expired" ? "EXPIRED_TOKEN" : "INVALID_TOKEN",
      },
      { status: REASON_STATUS[result.reason] },
    )
  }

  const { flipped, grantAwarded, taskAwarded } = result.verification
  return NextResponse.json({
    ok: true,
    verified: true,
    /**
     * False on the call that actually verified, true if the account was
     * already verified when the token was redeemed. The client uses this to
     * decide whether to celebrate; `leavesAwarded` is 0 in the latter case
     * because markVerified() credits nothing on a repeat.
     */
    alreadyVerified: !flipped,
    leavesAwarded: grantAwarded + taskAwarded,
  })
}

/**
 * A verification link, opened. NEVER spends the token.
 *
 * Links mailed before 17 Oct 2026 point here rather than at the confirm page,
 * and anything can GET a URL: mail scanners pre-open every link in a message,
 * and link previews fetch them too. If a GET redeemed the token, those would
 * verify the account and burn the link before the person saw it. So a GET of
 * any kind — browser, scanner, curl — is sent on to the confirm page with the
 * token intact, and only the POST below (the page's button, or the app)
 * redeems it.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""
  const target = new URL("/auth/verify-email", publicBaseUrl(req) || req.url)
  if (verifyEmailSchema.safeParse({ token }).success) target.searchParams.set("token", token)
  return NextResponse.redirect(target, 303)
}

/**
 * Redeems a token: the confirm page's button, and the native client.
 *
 * A failure inside redemption answers a typed 500 rather than Next's HTML
 * error page, so the confirm page can say "try again" instead of guessing.
 */
export async function POST(req: NextRequest) {
  const parsed = await parseBody(req, verifyEmailSchema)
  if (!parsed.ok) return parsed.response

  try {
    return jsonResult(await consumeVerificationToken(parsed.data.token))
  } catch (err) {
    console.error("[verify-email]", err instanceof Error ? err.message : "unknown error")
    return NextResponse.json(
      { error: "Could not check that link just now", code: "SERVER_ERROR" },
      { status: 500 },
    )
  }
}
