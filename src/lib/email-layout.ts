import { EMAIL_BANNER_URL } from "@/lib/brand-media"

/**
 * The one layout every Baylo email is poured into: a small version of the
 * emailed-link landing pages (app/auth/_components/EmailLanding.tsx).
 *
 *   ┌──────────────────────────────┐
 *   │ Baylo        (photo banner)  │  forest-green cell behind the photo, so
 *   │╭────────────────────────────╮│  with images blocked it is a green band
 *   ││ Heading                    ││  with the white wordmark, never a hole
 *   ││ One line.                  ││
 *   ││ [ the one button ]         ││  off-white sheet, rounded top corners
 *   ││ Expires… Button not working? <short link>
 *   ││                            ││
 *   ││ why you got this · ignore  ││  footer: two lines
 *   ││ Baylo · Cebu City · contact││
 *
 * ── LIGHT ONLY, ON PURPOSE ───────────────────────────────────────────────────
 *
 * There is no hand-built dark version. Gmail's apps recolour an email that
 * ships no dark styles by inverting its light fills and lightening dark text,
 * and leave dark fills and images alone. So the design keeps to colours that
 * survive that: the one background is the light sheet (it inverts cleanly),
 * every piece of white text sits on a DARK fill (the banner, the button) that
 * Gmail does not touch, and the code digits are on a solid light-green fill
 * with no thin border to lose.
 *
 * ── THE RULES THESE TEMPLATES KEEP ───────────────────────────────────────────
 *
 * Until 11 Sep 2026 every template inlined public/logo.png as a base64 data
 * URI. Each email carried ~800 KB of HTML, Gmail clipped it at ~102 KB and
 * refuses `data:` images anyway. So: NO inlined images, ever. The one image is
 * the hosted banner (a public URL — Gmail fetches images through its own proxy,
 * which cannot reach a LAN address). Tables and inline styles only, one column,
 * max 480 px. Every piece of text that reaches HTML goes through escapeHtml().
 *
 * Bricolage Grotesque and Public Sans are named first and not loaded: Gmail
 * ignores web fonts, so in Gmail this renders in Segoe UI / Roboto / Arial.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** baylo-mobile tokens.js. */
const C = {
  sheet: "#FAFAF7", // color.surface — the one background
  ink: "#14140F", // color.ink
  body: "#5C5B52", // color.inkSecondary
  muted: "#8C8A7E", // color.inkMuted
  forest: "#1B4D2B", // color.forest — banner fallback and the button
  codeFill: "#DCEFE0", // a solid light green for the code digits
} as const

const DISPLAY = "font-family:'Bricolage Grotesque','Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
const SANS = "font-family:'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"

export function contactAddress(): string {
  return (process.env.EMAIL_CONTACT ?? "").trim() || "bayloplatform@gmail.com"
}

/** EMAIL_BANNER_URL overrides the banner when it is an http(s) URL. */
function bannerUrl(): string {
  const configured = (process.env.EMAIL_BANNER_URL ?? "").trim()
  return /^https?:\/\//i.test(configured) ? configured : EMAIL_BANNER_URL
}

/**
 * The link as people read it: host, path, and the first six characters of a
 * token. The href is always the full URL — only the visible text is cut.
 */
export function shortLink(url: string): string {
  try {
    const u = new URL(url)
    const token = u.searchParams.get("token")
    return `${u.host}${u.pathname}${token ? `?token=${token.slice(0, 6)}…` : u.search}`
  } catch {
    return url
  }
}

/** Bold ink inside the line, for names. Escapes `text`. */
export function strong(text: string): string {
  return `<strong style="color:${C.ink};font-weight:700;">${escapeHtml(text)}</strong>`
}

export type EmailContent = {
  /** <title>. Plain text. */
  title: string
  /** The inbox preview line. Plain text. */
  preheader: string
  /** Plain text. */
  heading: string
  /** The ONE line under the heading. Already-safe HTML (see strong()). */
  line: string
  /** The one button, or none (the swap code has nothing to open). */
  cta?: { url: string; label: string }
  /** Digits to show in cells under the line. */
  code?: string
  /** Plain text before "Button not working?", e.g. "Expires in 24 hours." */
  small: string
  /** Plain text: why you got this, and the ignore line, in one sentence pair. */
  footer: string
}

function codeCells(code: string): string {
  const cells = code
    .split("")
    .map(
      (d) =>
        `<td style="padding:0 6px 0 0;"><div style="width:40px;height:52px;line-height:52px;border-radius:10px;background-color:${C.codeFill};${SANS}font-size:24px;font-weight:700;color:${C.ink};text-align:center;">${escapeHtml(d)}</div></td>`,
    )
    .join("")
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;"><tr>${cells}</tr></table>`
}

export function renderEmailHtml(m: EmailContent): string {
  const banner = escapeHtml(bannerUrl())
  const contact = escapeHtml(contactAddress())
  const href = m.cta ? escapeHtml(m.cta.url) : ""

  const button = m.cta
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 0 0;"><tr>
<td align="center" bgcolor="${C.forest}" style="border-radius:10px;background-color:${C.forest};"><a href="${href}" target="_blank" style="display:block;padding:16px 24px;${SANS}font-size:16px;line-height:20px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(m.cta.label)}</a></td></tr></table>`
    : ""
  const small = m.cta
    ? `${escapeHtml(m.small)} Button not working? <a href="${href}" target="_blank" style="color:${C.forest};text-decoration:underline;word-break:break-all;">${escapeHtml(shortLink(m.cta.url))}</a>`
    : escapeHtml(m.small)

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(m.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:${C.sheet};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(m.preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.sheet}" style="background-color:${C.sheet};"><tr><td align="center" style="padding:16px 12px 28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
  <tr><td bgcolor="${C.forest}" background="${banner}" style="background-color:${C.forest};background-image:url('${banner}');background-size:cover;background-position:center;border-radius:16px 16px 0 0;padding:0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td height="96" valign="top" style="height:96px;padding:20px 24px 0 24px;">
        <span style="${DISPLAY}font-size:26px;line-height:30px;font-weight:700;letter-spacing:-0.5px;color:#FFFFFF;">Baylo</span>
      </td></tr>
      <tr><td height="24" bgcolor="${C.sheet}" style="height:24px;line-height:24px;font-size:0;background-color:${C.sheet};border-radius:24px 24px 0 0;">&nbsp;</td></tr>
    </table>
  </td></tr>
  <tr><td bgcolor="${C.sheet}" style="background-color:${C.sheet};padding:6px 24px 0 24px;">
    <h1 style="margin:0;${DISPLAY}font-size:26px;line-height:31px;font-weight:700;letter-spacing:-0.3px;color:${C.ink};">${escapeHtml(m.heading)}</h1>
    <p style="margin:10px 0 0 0;${SANS}font-size:16px;line-height:24px;color:${C.body};">${m.line}</p>
    ${m.code ? codeCells(m.code) : ""}${button}
    <p style="margin:14px 0 0 0;${SANS}font-size:13px;line-height:19px;color:${C.muted};">${small}</p>
  </td></tr>
  <tr><td style="padding:32px 24px 0 24px;${SANS}font-size:12px;line-height:18px;color:${C.muted};">
    <p style="margin:0 0 4px 0;">${escapeHtml(m.footer)}</p>
    <p style="margin:0;">Baylo &middot; Cebu City &middot; <a href="mailto:${contact}" style="color:${C.muted};text-decoration:underline;">${contact}</a></p>
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`
}

/** The plain-text part: the same words, the full URL, the same footer. */
export function renderEmailText(m: EmailContent, lines: string[]): string {
  return [
    m.heading,
    "",
    ...lines,
    "",
    m.small,
    "",
    m.footer,
    `Baylo · Cebu City · ${contactAddress()}`,
  ].join("\n")
}
