/**
 * The one layout every Baylo email is poured into.
 *
 * ── WHY IT LOOKS LIKE THIS ───────────────────────────────────────────────────
 *
 * The colours, the 10 px button radius and the type pairing are the mobile
 * app's (baylo-mobile `src/theme/tokens.js`): the off-white `surface` card on
 * the warmer `control` ground, `ink` headings, `inkSecondary` body, and the
 * deep `forest` green for the one action. Not the bright `green` the app uses
 * for its primary button: forest under off-white type is legible at email
 * sizes and survives Gmail's dark-mode recolouring; the bright green with dark
 * type does not.
 *
 * Bricolage Grotesque and Public Sans are NAMED first in each stack and are
 * not loaded: Gmail ignores web fonts, so in Gmail this renders in Segoe UI,
 * Roboto or Arial. That is the stack doing its job, not a bug.
 *
 * ── THE RULES THESE TEMPLATES KEEP ───────────────────────────────────────────
 *
 * Until 11 Sep 2026 every template inlined public/logo.png as a base64 data
 * URI, twice. Each email carried ~800 KB of HTML, Gmail clipped it at ~102 KB
 * inside the first <img>, and refuses `data:` images anyway — a Gmail user saw
 * a broken header, no button and a bare URL. So:
 *
 *   - NO inlined images, ever. The logo is a hosted image (Cloudinary by
 *     default, EMAIL_LOGO_URL to override, http(s) only) and the wordmark beside it is TEXT, so the header still
 *     reads "Baylo" with images blocked. The logo must be on a PUBLIC host:
 *     Gmail fetches images through its own proxy, which cannot reach a LAN
 *     address, so a logo served from the dev laptop never loads in Gmail.
 *   - Tables and inline styles only. The <style> block carries nothing but
 *     the dark-mode overrides, for the clients that honour them; everything
 *     still reads correctly where it is stripped.
 *   - One column, max 480 px, fluid below it, 16 px side gutter on a phone.
 *   - Every piece of text that reaches HTML goes through escapeHtml(), the
 *     URLs included — a `&` in a query string still has to be `&amp;`.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** baylo-mobile tokens.js, light set. */
export const EMAIL_COLOR = {
  ground: "#F1EFE8", // color.control
  card: "#FAFAF7", // color.surface
  ink: "#14140F", // color.ink
  body: "#5C5B52", // color.inkSecondary
  muted: "#8C8A7E", // color.inkMuted
  line: "#E2E0D6", // color.controlLine
  divider: "#EDEBE3", // color.divider
  forest: "#1B4D2B", // color.forest
  onForest: "#FAFAF7",
  wash: "#EAF6EC", // color.greenWash
} as const

/** baylo-mobile tokens.js, dark set — only where a client asks for dark. */
const DARK = {
  ground: "#111311",
  card: "#171A17",
  ink: "#F4F5F0",
  body: "#B6BDB3",
  muted: "#929B91",
  line: "#343A34",
  link: "#72D681",
} as const

export const DISPLAY_FONT = "font-family:'Bricolage Grotesque','Segoe UI',Roboto,Helvetica,Arial,sans-serif;"
export const SANS_FONT = "font-family:'Public Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"

const C = EMAIL_COLOR

export function contactAddress(): string {
  return (process.env.EMAIL_CONTACT ?? "").trim() || "bayloplatform@gmail.com"
}

/**
 * The project logo, uploaded once to Baylo's Cloudinary (a public delivery URL,
 * not a credential). public/email/baylo-leaf-96.png is the source file.
 */
export const DEFAULT_EMAIL_LOGO_URL =
  "https://res.cloudinary.com/dm7ctbxq7/image/upload/v1792168950/baylo/email/baylo-leaf-96.png"

/**
 * The logo to show: EMAIL_LOGO_URL when it is an http(s) URL, else the default.
 * Anything else in the variable (a data URI, a file path) is ignored — see the
 * note at the top. The wordmark beside it is text either way.
 */
function hostedLogo(): string {
  const configured = (process.env.EMAIL_LOGO_URL ?? "").trim()
  return /^https?:\/\//i.test(configured) ? configured : DEFAULT_EMAIL_LOGO_URL
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

/** A body paragraph. `html` must already be safe. */
export function paragraph(html: string, marginTop = 12): string {
  return `<p class="b-body" style="margin:${marginTop}px 0 0 0;${SANS_FONT}font-size:16px;line-height:24px;color:${C.body};">${html}</p>`
}

/** Bold ink inside a paragraph, for names and item titles. Escapes `text`. */
export function strong(text: string): string {
  return `<strong class="b-ink" style="color:${C.ink};font-weight:700;">${escapeHtml(text)}</strong>`
}

/**
 * The one call-to-action: a bulletproof full-width button (a table cell with
 * a background, which every client paints) and the same URL beneath it,
 * shortened for reading, still the full link underneath.
 */
export function button(url: string, label: string): string {
  const href = escapeHtml(url)
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0 0;">
  <tr><td align="center" bgcolor="${C.forest}" style="border-radius:10px;background-color:${C.forest};">
    <a href="${href}" target="_blank" style="display:block;padding:16px 24px;${SANS_FONT}font-size:16px;line-height:20px;font-weight:700;color:${C.onForest};text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
  </td></tr>
</table>
<p class="b-muted" style="margin:16px 0 0 0;${SANS_FONT}font-size:13px;line-height:19px;color:${C.muted};">Button not working? Use this link:<br>
<a href="${href}" target="_blank" class="b-link" style="color:${C.forest};text-decoration:underline;word-break:break-all;">${escapeHtml(shortLink(url))}</a></p>`
}

/** Six (or however many) digit cells, for a code the reader reads aloud. */
export function codeCells(code: string): string {
  const cells = code
    .split("")
    .map(
      (d) =>
        `<td style="padding:0 6px 0 0;"><div class="b-code" style="width:40px;height:52px;line-height:52px;border:1.5px solid ${C.forest};border-radius:10px;background-color:${C.wash};${SANS_FONT}font-size:24px;font-weight:700;color:${C.ink};text-align:center;">${escapeHtml(d)}</div></td>`,
    )
    .join("")
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0 0;"><tr>${cells}</tr></table>`
}

export type EmailContent = {
  /** <title>, and what a client shows when it has nothing better. */
  title: string
  /** The inbox preview line. Plain text. */
  preheader: string
  /** Plain text. */
  heading: string
  /** Already-safe HTML: paragraph(), button(), codeCells(). */
  body: string
  /** Plain text, e.g. "This link expires in 24 hours and works once." */
  expiry: string
  /** Plain text: why this address got this email. */
  reason: string
  /** Plain text: the "you can ignore this" line. */
  ignore: string
}

export function renderEmailHtml(m: EmailContent): string {
  const logo = hostedLogo()
  const contact = escapeHtml(contactAddress())
  const logoCell = `<td style="padding-right:10px;vertical-align:middle;"><img src="${escapeHtml(logo)}" width="36" height="36" alt="Baylo" style="display:block;width:36px;height:36px;border:0;border-radius:9px;${SANS_FONT}font-size:12px;font-weight:700;color:${C.forest};"></td>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(m.title)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .b-ground { background-color:${DARK.ground} !important; }
    .b-card { background-color:${DARK.card} !important; border-color:${DARK.line} !important; }
    .b-ink { color:${DARK.ink} !important; }
    .b-body { color:${DARK.body} !important; }
    .b-muted { color:${DARK.muted} !important; }
    .b-link { color:${DARK.link} !important; }
    .b-rule { border-color:${DARK.line} !important; }
    .b-code { background-color:${DARK.ground} !important; border-color:${DARK.link} !important; color:${DARK.ink} !important; }
  }
  [data-ogsc] .b-card { background-color:${DARK.card} !important; }
  [data-ogsc] .b-ink { color:${DARK.ink} !important; }
  [data-ogsc] .b-body { color:${DARK.body} !important; }
  [data-ogsc] .b-link { color:${DARK.link} !important; }
</style>
</head>
<body class="b-ground" style="margin:0;padding:0;background-color:${C.ground};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(m.preheader)}${"&#847;&zwnj;&nbsp;".repeat(30)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="b-ground" bgcolor="${C.ground}" style="background-color:${C.ground};">
<tr><td align="center" style="padding:24px 16px 32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
    <tr><td style="padding:0 4px 16px 4px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        ${logoCell}
        <td class="b-ink" style="vertical-align:middle;${DISPLAY_FONT}font-size:22px;line-height:26px;font-weight:700;letter-spacing:-0.4px;color:${C.ink};">Baylo</td>
      </tr></table>
    </td></tr>
    <tr><td class="b-card" bgcolor="${C.card}" style="background-color:${C.card};border:1px solid ${C.line};border-radius:16px;padding:28px 24px;">
      <h1 class="b-ink" style="margin:0;${DISPLAY_FONT}font-size:26px;line-height:31px;font-weight:700;letter-spacing:-0.3px;color:${C.ink};">${escapeHtml(m.heading)}</h1>
      ${m.body}
      <p class="b-body b-rule" style="margin:24px 0 0 0;padding-top:16px;border-top:1px solid ${C.divider};${SANS_FONT}font-size:14px;line-height:20px;color:${C.body};">${escapeHtml(m.expiry)}</p>
    </td></tr>
    <tr><td class="b-muted" style="padding:20px 4px 0 4px;${SANS_FONT}font-size:12px;line-height:18px;color:${C.muted};">
      <p style="margin:0 0 8px 0;">${escapeHtml(m.reason)} ${escapeHtml(m.ignore)}</p>
      <p style="margin:0 0 8px 0;"><strong class="b-body" style="color:${C.body};">Baylo</strong> &middot; Cebu City, Philippines &middot; Questions? <a href="mailto:${contact}" class="b-link" style="color:${C.forest};">${contact}</a></p>
      <p style="margin:0;">This email was sent from a no-reply address. Replies aren&rsquo;t read.</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`
}

/** The plain-text part: the same words, the full URL, the same footer. */
export function renderEmailText(lines: string[], m: Pick<EmailContent, "expiry" | "reason" | "ignore">): string {
  return [
    ...lines,
    "",
    m.expiry,
    "",
    `${m.reason} ${m.ignore}`,
    "",
    `Baylo · Cebu City, Philippines · Questions? ${contactAddress()}`,
    "This email was sent from a no-reply address. Replies aren't read.",
  ].join("\n")
}
