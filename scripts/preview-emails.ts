/**
 * Renders every email to disk without sending anything — no SMTP, no database.
 *
 *   npx tsx scripts/preview-emails.ts [outDir]
 *
 * Writes <name>.html and <name>.txt per message to outDir (default: the OS
 * temp directory). Sample names and a fake token only. Reads EMAIL_LOGO_URL and
 * EMAIL_CONTACT from .env so the logo renders as it will in a real inbox.
 */
import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPasswordResetEmail, buildSwapCodeEmail, buildVerificationEmail } from "../src/lib/mailer"

const out = process.argv[2] ?? join(tmpdir(), "baylo-email-preview")
mkdirSync(out, { recursive: true })

const base = "http://10.231.93.88:3000"
const token = "3f2a9c71d0be44e8a51f0c2d9b7e6a13f2a9c71d0be44e8a51f0c2d9b7e6a1"

const messages = {
  verification: buildVerificationEmail(`${base}/auth/verify-email?token=${token}`, "Jamaica"),
  "password-reset": buildPasswordResetEmail(`${base}/auth/reset-password?token=${token}`, "Jamaica"),
  "swap-code": buildSwapCodeEmail("482915", "Jamaica", "Aj", { yours: "Bike helmet", theirs: "Rice cooker" }),
}

for (const [name, m] of Object.entries(messages)) {
  writeFileSync(join(out, `${name}.html`), m.html)
  writeFileSync(join(out, `${name}.txt`), `Subject: ${m.subject}\n\n${m.text}`)
  console.log(`${name}: ${(Buffer.byteLength(m.html) / 1024).toFixed(1)} KB html — ${m.subject}`)
}
console.log(`wrote ${out}`)
