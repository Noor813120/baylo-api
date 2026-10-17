import { NextResponse, type NextRequest } from "next/server"
import { publicBaseUrl } from "@/lib/public-url"

/**
 * Plain HTML form posts to the auth routes the emailed-link pages use
 * (verify-email, reset-password, forgot-password).
 *
 * Those pages work WITHOUT JavaScript: each action is a <form method="post">
 * and the route answers 303 to the page's result state, instead of the JSON the
 * app and the old client-side pages read. The JSON transport on the same routes
 * is untouched — this only adds the second one.
 */

/** True for a browser form submission rather than a JSON call. */
export function isFormPost(req: NextRequest): boolean {
  const type = (req.headers.get("content-type") ?? "").toLowerCase()
  return type.startsWith("application/x-www-form-urlencoded") || type.startsWith("multipart/form-data")
}

/**
 * Refuses a form post that did not come from one of our own pages.
 *
 * A JSON POST from another site needs a CORS preflight, which these routes
 * never grant, so the JSON transport was never reachable cross-site. A plain
 * form post is a "simple" request and IS — any page could auto-submit one, and
 * for forgot-password that means mailing a stranger on our SMTP quota. Every
 * browser sends Origin on a form POST; it must name the host the request was
 * sent to. A missing Origin is refused too: the only clients that omit it are
 * not browsers, and they have the JSON transport.
 */
export function crossSiteRefusal(req: NextRequest): NextResponse | null {
  const origin = req.headers.get("origin")
  const host = req.headers.get("host")
  try {
    if (origin && host && new URL(origin).host === host.toLowerCase()) return null
  } catch {
    // An unparseable Origin is refused below.
  }
  return NextResponse.json({ error: "Cross-site form posts are refused", code: "CROSS_SITE" }, { status: 403 })
}

/** 303 See Other to a page path on the origin the person is using. */
export function seeOther(req: NextRequest, path: string, query: Record<string, string>): NextResponse {
  const target = new URL(path, publicBaseUrl(req) || req.url)
  for (const [k, v] of Object.entries(query)) if (v) target.searchParams.set(k, v)
  return NextResponse.redirect(target, 303)
}

/** One field of a submitted form as sent (NOT trimmed — passwords), or "" when absent. */
export function formField(form: FormData, name: string): string {
  const v = form.get(name)
  return typeof v === "string" ? v : ""
}
