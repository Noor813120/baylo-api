/**
 * Offline checks for AI-assisted valuation (@/lib/ai-valuation) and the write
 * path's use of it (judgeValue in @/lib/valuation-server).
 *
 * No server, no database query, no Anthropic call. Run with
 *   npx tsx scripts/verify-ai-valuation.ts
 * Exits 1 if any check fails.
 */
import {
  AI_TICKET_TTL_MS,
  AI_VALUATION_SOURCE,
  decideAiValuation,
  issueTicket,
  parseAiValuationAnswer,
  verifiedSources,
  verifyTicket,
  type AiSource,
} from "@/lib/ai-valuation"
import { bracketOf } from "@/lib/brackets"
import { valueCap } from "@/lib/trade-rules"
import { overrideBounds, valueItem } from "@/lib/valuation"
import { judgeValue } from "@/lib/valuation-server"

let failures = 0
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failures++
    console.log(`  FAIL ${name}`, detail ?? "")
  }
}

const SECRET = "test-secret-not-real"
const NOW = 1_800_000_000_000
const range = { min: 100, max: 4000 }
const results = [
  { url: "https://shop.example.ph/iphone-13", title: "iPhone 13 128GB - ₱22,000" },
  { url: "https://market.example.com/listing/42", title: "Used iPhone 13" },
  { url: "https://third.example.org/p/9", title: "iPhone 13 mini" },
  { url: "https://fourth.example.org/p/1", title: "iPhone 13 Pro" },
  { url: "http://insecure.example.com/x", title: "insecure" },
]
const two: AiSource[] = verifiedSources(
  ["https://shop.example.ph/iphone-13", "https://market.example.com/listing/42"],
  results,
)

console.log("parsing Claude's answer")
{
  const a = parseAiValuationAnswer(
    'Here you go:\n{"suggestedLeaves": 2400, "explanation": "Listings ask ₱20-24k.", "sourceUrls": ["https://shop.example.ph/iphone-13"]}',
  )
  check("JSON inside surrounding prose is read", a?.suggestedLeaves === 2400, a)
  check("no JSON -> null", parseAiValuationAnswer("I could not find anything.") === null)
  check("broken JSON -> null", parseAiValuationAnswer('{"suggestedLeaves": 12,') === null)
  check(
    "wrong types -> null",
    parseAiValuationAnswer('{"suggestedLeaves":"lots","explanation":"x","sourceUrls":[]}') === null,
  )
  check(
    "missing explanation -> null",
    parseAiValuationAnswer('{"suggestedLeaves":10,"sourceUrls":[]}') === null,
  )
}

console.log("source links")
{
  check("two real search results verify", two.length === 2, two)
  const invented = verifiedSources(
    ["https://made-up.example.net/fake", "https://shop.example.ph/iphone-13"],
    results,
  )
  check("a URL not returned by the search tool is dropped", invented.length === 1 && invented[0].url.includes("shop."), invented)
  check(
    "http:// is dropped even if it was a search result",
    verifiedSources(["http://insecure.example.com/x"], results).length === 0,
  )
  check(
    "javascript: and junk are dropped",
    verifiedSources(["javascript:alert(1)", "not a url"], results).length === 0,
  )
  check(
    "duplicates collapse",
    verifiedSources(["https://shop.example.ph/iphone-13", "https://shop.example.ph/iphone-13"], results).length === 1,
  )
}

console.log("deciding on the answer")
{
  const ok = decideAiValuation({ suggestedLeaves: 2400, explanation: "x", sourceUrls: [] }, two, range)
  check("in range with 2 sources -> AI suggestion", ok.ok && ok.suggestedLeaves === 2400, ok)

  const four = verifiedSources(results.map((r) => r.url), results)
  const capped = decideAiValuation({ suggestedLeaves: 2400, explanation: "x", sourceUrls: [] }, four, range)
  check("at most 3 sources are returned", capped.ok && capped.sources.length === 3, capped)

  const edgeLo = decideAiValuation({ suggestedLeaves: 100, explanation: "x", sourceUrls: [] }, two, range)
  const edgeHi = decideAiValuation({ suggestedLeaves: 4000, explanation: "x", sourceUrls: [] }, two, range)
  check("range is inclusive at both ends", edgeLo.ok && edgeHi.ok)

  const above = decideAiValuation({ suggestedLeaves: 4001, explanation: "x", sourceUrls: [] }, two, range)
  const below = decideAiValuation({ suggestedLeaves: 99, explanation: "x", sourceUrls: [] }, two, range)
  check("above range -> OUT_OF_RANGE (rejected, not clamped)", !above.ok && above.reason === "OUT_OF_RANGE", above)
  check("below range -> OUT_OF_RANGE", !below.ok && below.reason === "OUT_OF_RANGE", below)

  const frac = decideAiValuation({ suggestedLeaves: 250.5, explanation: "x", sourceUrls: [] }, two, range)
  check("non-integer -> INVALID_AI_RESPONSE", !frac.ok && frac.reason === "INVALID_AI_RESPONSE", frac)

  const nul = decideAiValuation({ suggestedLeaves: null, explanation: "x", sourceUrls: [] }, two, range)
  check("Claude says not enough listings -> INSUFFICIENT_SOURCES", !nul.ok && nul.reason === "INSUFFICIENT_SOURCES", nul)

  const one = decideAiValuation({ suggestedLeaves: 500, explanation: "x", sourceUrls: [] }, two.slice(0, 1), range)
  check("only 1 verified source -> INSUFFICIENT_SOURCES", !one.ok && one.reason === "INSUFFICIENT_SOURCES", one)

  const bad = decideAiValuation(null, two, range)
  check("unreadable answer -> INVALID_AI_RESPONSE", !bad.ok && bad.reason === "INVALID_AI_RESPONSE", bad)

  const long = decideAiValuation({ suggestedLeaves: 500, explanation: "y".repeat(600), sourceUrls: [] }, two, range)
  check("explanation trimmed to 300 chars", long.ok && long.explanation.length === 300)
}

console.log("tickets")
{
  const claims = {
    userId: "user_1",
    title: "iPhone 13  128GB",
    category: "ELECTRONICS",
    condition: "GOOD",
    suggestedLeaves: 2400,
    min: 100,
    max: 4000,
  }
  const expect = { userId: "user_1", title: "iphone 13 128gb", category: "ELECTRONICS", condition: "GOOD" }
  const t = issueTicket(claims, NOW, SECRET)!
  check("issued with a secret", !!t)
  check("no secret -> no ticket", issueTicket(claims, NOW, "") === null)

  const v = verifyTicket(t.ticket, expect, NOW + 1000, SECRET)
  check("round-trips; title match ignores case and spacing", v.ok && v.suggestedLeaves === 2400 && v.min === 100 && v.max === 4000, v)

  const expired = verifyTicket(t.ticket, expect, NOW + AI_TICKET_TTL_MS + 1, SECRET)
  check("expired -> EXPIRED", !expired.ok && expired.reason === "EXPIRED", expired)

  const other = verifyTicket(t.ticket, { ...expect, userId: "user_2" }, NOW, SECRET)
  check("someone else's ticket -> WRONG_USER", !other.ok && other.reason === "WRONG_USER", other)

  const retitled = verifyTicket(t.ticket, { ...expect, title: "phone case" }, NOW, SECRET)
  check("different title -> MISMATCH", !retitled.ok && retitled.reason === "MISMATCH", retitled)
  const recat = verifyTicket(t.ticket, { ...expect, category: "GAMING" }, NOW, SECRET)
  check("different category -> MISMATCH", !recat.ok && recat.reason === "MISMATCH", recat)
  const recond = verifyTicket(t.ticket, { ...expect, condition: "NEW" }, NOW, SECRET)
  check("different condition -> MISMATCH", !recond.ok && recond.reason === "MISMATCH", recond)

  const wrongKey = verifyTicket(t.ticket, expect, NOW, "another-secret")
  check("signed with another secret -> BAD_SIGNATURE", !wrongKey.ok && wrongKey.reason === "BAD_SIGNATURE", wrongKey)

  // Raise the number inside the ticket and keep the old signature.
  const [body, sig] = t.ticket.split(".")
  const raised = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  raised.s = 4000
  const forged = `${Buffer.from(JSON.stringify(raised)).toString("base64url")}.${sig}`
  const f = verifyTicket(forged, expect, NOW, SECRET)
  check("edited value with the old signature -> BAD_SIGNATURE", !f.ok && f.reason === "BAD_SIGNATURE", f)

  check("garbage -> MALFORMED", (() => { const r = verifyTicket("nope", expect, NOW, SECRET); return !r.ok && r.reason === "MALFORMED" })())
  check("unset secret verifies nothing", !verifyTicket(t.ticket, expect, NOW, "").ok)
}

console.log("bracket rules on an AI suggestion (server-side)")
{
  const suggested = 2400
  const ai = {
    suggestedLeaves: suggested,
    min: 100,
    max: 4000,
    valuationSource: AI_VALUATION_SOURCE,
    sampleSize: 0,
    allowed: overrideBounds(suggested),
  }
  const none = judgeValue(ai, null)
  check(
    "no value -> the AI suggestion stands, source ai_market, not user-set",
    none.decision === "suggested" && none.data.valueLeaves === suggested &&
      none.data.suggestedLeaves === suggested && none.data.valuationSource === "ai_market" &&
      none.data.valueSetByUser === false,
    none,
  )
  const lower = judgeValue(ai, 300)
  check("lower -> allowed, user-set, live", lower.decision === "lowered" && !lower.needsReview && lower.data.valueSetByUser, lower)

  const cap = valueCap(suggested)
  const withinCap = cap.maxValueWithoutReview ?? suggested
  const raised = judgeValue(ai, withinCap)
  check(
    `raise to the cap (${withinCap}, bracket ${bracketOf(withinCap)}) -> live`,
    raised.decision === "raisedWithinCap" && !raised.needsReview,
    raised,
  )
  if (cap.maxValueWithoutReview !== null) {
    const over = judgeValue(ai, cap.maxValueWithoutReview + 1)
    check("one Leaf past the cap -> needs review", over.decision === "needsReview" && over.needsReview, over)
  }
  check(
    "the bracket follows the AI number, not the standard one",
    judgeValue(ai, null).cap.suggestedBracket === bracketOf(suggested),
  )

  // The standard path is untouched: the same function on valueItem()'s output.
  const standard = valueItem({ category: "ELECTRONICS", condition: "GOOD", comparables: [] })
  const std = judgeValue(standard, null)
  check(
    "standard path still records its own source",
    std.data.valuationSource === "category_band" && std.data.suggestedLeaves === standard.suggestedLeaves,
    std,
  )
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
