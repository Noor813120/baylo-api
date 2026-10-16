import localFont from "next/font/local"
import type { CSSProperties, ReactNode } from "react"

/**
 * The shell the emailed links land in: /auth/verify-email and
 * /auth/reset-password.
 *
 * These are the only web pages most people ever see — the app is Android, and
 * the web is retired for users — so they are drawn in the APP's language, not
 * the old web direction: baylo-mobile's tokens (`src/theme/tokens.js`), its two
 * faces (Bricolage Grotesque for headings, Public Sans for everything else,
 * bundled here from the app's own OFL files so nothing is fetched at runtime),
 * the 52 px / 10 px-radius button, and the same forest green the emails use for
 * their one action. No gradients, no shadows.
 *
 * Mobile-first: one 440 px column, 16 px side gutter, nothing wider than the
 * viewport. One heading, one short message, one action per state.
 */

const display = localFont({
  src: [{ path: "../_fonts/BricolageGrotesque-Bold.ttf", weight: "700", style: "normal" }],
  display: "swap",
  fallback: ["Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
})

const sans = localFont({
  src: [
    { path: "../_fonts/PublicSans-Regular.ttf", weight: "400", style: "normal" },
    { path: "../_fonts/PublicSans-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../_fonts/PublicSans-Bold.ttf", weight: "700", style: "normal" },
  ],
  display: "swap",
  fallback: ["-apple-system", "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif"],
})

/** baylo-mobile tokens.js. */
export const landing = {
  surface: "#FAFAF7",
  control: "#F1EFE8",
  ink: "#14140F",
  body: "#5C5B52",
  muted: "#8C8A7E",
  line: "#E2E0D6",
  forest: "#1B4D2B",
  onForest: "#FAFAF7",
  wash: "#EAF6EC",
  urgent: "#B0553A",
  urgentWash: "#FBEEE9",
} as const

/** The app's home. `baylo` is in baylo-mobile's app.json `scheme`. */
export const APP_DEEP_LINK = "baylo://"

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div
      className={sans.className}
      style={{
        minHeight: "100svh",
        background: landing.surface,
        color: landing.ink,
        padding: "0 16px",
        boxSizing: "border-box",
        overflowX: "hidden",
      }}
    >
      <div style={{ maxWidth: 440, margin: "0 auto", padding: "24px 0 48px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 40 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a 2.6 KB static mark; next/image buys nothing here */}
          <img src="/email/baylo-leaf-96.png" width={32} height={32} alt="" style={{ borderRadius: 8, display: "block" }} />
          <span className={display.className} style={{ fontSize: 22, letterSpacing: "-0.4px", lineHeight: "26px" }}>
            Baylo
          </span>
        </div>
        <main>{children}</main>
      </div>
    </div>
  )
}

type Tone = "ok" | "bad" | "neutral"
type Glyph = "check" | "alert" | "clock" | "mail" | "key"

const GLYPH: Record<Glyph, ReactNode> = {
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  alert: <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m4 7 8 6 8-6" /></>,
  key: <><circle cx="8" cy="15" r="4" /><path d="m11 12 8-8M16 7l2 2" /></>,
}

export function StatusMark({ tone, glyph }: { tone: Tone; glyph: Glyph }) {
  const bg = tone === "ok" ? landing.wash : tone === "bad" ? landing.urgentWash : landing.control
  const fg = tone === "ok" ? landing.forest : tone === "bad" ? landing.urgent : landing.body
  return (
    <div
      aria-hidden
      style={{ width: 56, height: 56, borderRadius: 16, display: "grid", placeItems: "center", marginBottom: 20, background: bg, color: fg }}
    >
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        {GLYPH[glyph]}
      </svg>
    </div>
  )
}

export function LandingHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className={display.className} style={{ fontSize: 27, lineHeight: "32px", letterSpacing: "-0.3px", margin: "0 0 10px", color: landing.ink }}>
      {children}
    </h1>
  )
}

export function LandingBody({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 15, lineHeight: "23px", color: landing.body, margin: "0 0 28px" }}>{children}</p>
}

/** The muted line under the action. */
export function LandingHelp({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 13, lineHeight: "19px", color: landing.muted, margin: "14px 0 0", textAlign: "center" }}>{children}</p>
}

const actionStyle = (busy: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: 52,
  borderRadius: 10,
  border: "none",
  background: busy ? landing.control : landing.forest,
  color: busy ? landing.muted : landing.onForest,
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: 700,
  textDecoration: "none",
  cursor: busy ? "default" : "pointer",
  boxSizing: "border-box",
})

/** The one action: a link (`href`) or a button (`onClick` / `type="submit"`). */
export function PrimaryAction({
  children,
  href,
  onClick,
  type = "button",
  busy = false,
}: {
  children: ReactNode
  href?: string
  onClick?: () => void
  type?: "button" | "submit"
  busy?: boolean
}) {
  if (href) {
    return (
      <a href={href} style={actionStyle(false)}>
        {children}
      </a>
    )
  }
  return (
    <button type={type} onClick={onClick} disabled={busy} aria-busy={busy} style={actionStyle(busy)}>
      {children}
    </button>
  )
}

/** "Go back to the Baylo app", and what to do if the link does not open it. */
export function BackToApp({ label = "Go back to the Baylo app" }: { label?: string }) {
  return (
    <>
      <PrimaryAction href={APP_DEEP_LINK}>{label}</PrimaryAction>
      <LandingHelp>If the app doesn&rsquo;t open, open Baylo from your home screen.</LandingHelp>
    </>
  )
}
