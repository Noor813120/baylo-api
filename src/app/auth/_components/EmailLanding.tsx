import localFont from "next/font/local"
import type { ReactNode } from "react"
import { PAGE_PHOTO_URL } from "@/lib/brand-media"

/**
 * The shell the emailed links land in: /auth/verify-email,
 * /auth/reset-password and /auth/forgot.
 *
 * ── THE APP'S WELCOME SCREEN, ON THE WEB ─────────────────────────────────────
 *
 * baylo-mobile's sign-in screen is a photo band (the Welcome video) with the
 * white wordmark over a flat tint, and an off-white sheet with 28 px rounded
 * top corners overlapping it by 28 px. This is that layout: a still of the same
 * footage (lib/brand-media.ts), the same tokens (`tokens.js`), the same faces
 * (Bricolage Grotesque, Public Sans — bundled from the app's own OFL files, so
 * nothing is fetched at runtime) and the forest-green 52 px / 10 px button.
 * The photo grows to fill whatever height the sheet leaves, so no screen has an
 * empty area.
 *
 * ── NO JAVASCRIPT REQUIRED ───────────────────────────────────────────────────
 *
 * Every page built on this is a SERVER component and every action is a plain
 * <form method="post"> to a route that answers 303 to the result state. Nothing
 * here depends on the page hydrating. That is not a nicety: from a phone, the
 * dev server's /_next scripts can be refused (allowedDevOrigins, 17 Oct 2026),
 * an in-app browser can block them, a slow connection can drop them — and a
 * Confirm button wired to onClick was simply dead when that happened.
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
  urgent: "#B0553A",
  urgentWash: "#FBEEE9",
  urgentLine: "#F0D8CE",
} as const

/** The app's home. `baylo` is in baylo-mobile's app.json `scheme`. */
export const APP_DEEP_LINK = "baylo://"

export function LandingShell({ children }: { children: ReactNode }) {
  return (
    <div className={sans.className} style={{ background: landing.ink, minHeight: "100svh", color: landing.ink }}>
      <div
        style={{
          maxWidth: 480,
          margin: "0 auto",
          minHeight: "100svh",
          display: "flex",
          flexDirection: "column",
          background: landing.surface,
          overflowX: "hidden",
        }}
      >
        <div
          style={{
            position: "relative",
            flex: "1 0 281px",
            backgroundColor: "#3E3A33",
            backgroundImage: `url("${PAGE_PHOTO_URL}")`,
            backgroundSize: "cover",
            backgroundPosition: "center 30%",
          }}
        >
          {/* The flat tint the app lays over its band, so the wordmark reads on any frame. */}
          <div aria-hidden style={{ position: "absolute", inset: 0, background: "rgba(20,20,15,0.40)" }} />
          <span
            className={display.className}
            style={{ position: "absolute", top: 44, left: 16, fontSize: 24, letterSpacing: "-0.48px", color: "#FAFAF7" }}
          >
            Baylo
          </span>
        </div>
        <main
          style={{
            position: "relative",
            marginTop: -28,
            background: landing.surface,
            borderRadius: "28px 28px 0 0",
            padding: "26px 24px 32px",
          }}
        >
          {children}
        </main>
      </div>
    </div>
  )
}

export function LandingHeading({ children }: { children: ReactNode }) {
  return (
    <h1 className={display.className} style={{ fontSize: 27, lineHeight: "32.4px", margin: "0 0 10px", color: landing.ink }}>
      {children}
    </h1>
  )
}

export function LandingBody({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 15, lineHeight: "23.25px", color: landing.body, margin: "0 0 28px" }}>{children}</p>
}

/** Bold ink inside a LandingBody. */
export function Em({ children }: { children: ReactNode }) {
  return <strong style={{ color: landing.ink }}>{children}</strong>
}

/** The muted line under the action. */
export function LandingHelp({ children }: { children: ReactNode }) {
  return <p style={{ fontSize: 13, lineHeight: "19.5px", color: landing.muted, margin: "14px 0 0", textAlign: "center" }}>{children}</p>
}

/** The app's terracotta panel, for a form error. */
export function LandingAlert({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      style={{
        fontSize: 13,
        lineHeight: "19.5px",
        color: landing.urgent,
        background: landing.urgentWash,
        border: `1px solid ${landing.urgentLine}`,
        borderRadius: 12,
        padding: "12px 14px",
        margin: "0 0 20px",
      }}
    >
      {children}
    </p>
  )
}

const action = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
  height: 52,
  borderRadius: 10,
  border: "none",
  background: landing.forest,
  color: landing.onForest,
  fontFamily: "inherit",
  fontSize: 16,
  fontWeight: 700,
  textDecoration: "none",
  cursor: "pointer",
  boxSizing: "border-box",
} as const

/** The one action, as a link. */
export function ActionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} style={action}>
      {children}
    </a>
  )
}

/** The one action, as the submit button of the surrounding <form>. */
export function SubmitButton({ children }: { children: ReactNode }) {
  return (
    <button type="submit" style={action}>
      {children}
    </button>
  )
}

export function TextField({
  id,
  name,
  label,
  type = "text",
  defaultValue,
  autoComplete,
}: {
  id: string
  name: string
  label: string
  type?: "text" | "email" | "password"
  defaultValue?: string
  autoComplete?: string
}) {
  return (
    <>
      <label htmlFor={id} style={{ display: "block", fontSize: 12, fontWeight: 600, color: landing.muted, margin: "0 0 6px" }}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        defaultValue={defaultValue}
        autoComplete={autoComplete}
        autoCapitalize={type === "email" ? "none" : undefined}
        required
        style={{
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
          margin: "0 0 16px",
        }}
      />
    </>
  )
}

/** "Go back to the Baylo app", and what to do if the link does not open it. */
export function BackToApp({ label = "Go back to the Baylo app" }: { label?: string }) {
  return (
    <>
      <ActionLink href={APP_DEEP_LINK}>{label}</ActionLink>
      <LandingHelp>If the app doesn&rsquo;t open, open Baylo from your home screen.</LandingHelp>
    </>
  )
}

/** One query parameter, as a string. */
export function param(sp: Record<string, string | string[] | undefined>, key: string): string {
  const v = sp[key]
  return (Array.isArray(v) ? v[0] : v ?? "").trim()
}
