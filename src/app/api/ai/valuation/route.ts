import Anthropic from "@anthropic-ai/sdk"
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"

import {
  AI_FALLBACK_MESSAGES,
  AI_VALUATION_MAX_SEARCHES,
  AI_VALUATION_SOURCE,
  AI_VALUATION_SYSTEM_PROMPT,
  aiAllowed,
  aiValuationUserMessage,
  decideAiValuation,
  issueTicket,
  parseAiValuationAnswer,
  verifiedListings,
  type AiFallbackReason,
} from "@/lib/ai-valuation"
import { anthropic, HAIKU_MODEL } from "@/lib/anthropic"
import { resolveSession } from "@/lib/api-auth"
import { enforceRateLimit } from "@/lib/rate-limit-config"
import { categoryLabel, conditionLabel } from "@/lib/v1/taxonomy"
import { categorySchema, conditionSchema, parseBody } from "@/lib/validation"
import { valuate } from "@/lib/valuation-server"
import type { Valuation } from "@/lib/valuation"

export const dynamic = "force-dynamic"
// Searches plus the answer can take most of the app's 30-second wait.
export const maxDuration = 30

/**
 * POST /api/ai/valuation -- the AI-assisted official Leaves suggestion.
 *
 * Claude finds current online listings for the item and their peso asking
 * prices. The server keeps the ones the search really returned, takes the
 * median price, finds its level for the category (@/lib/price-levels), and
 * gives the level's fixed point in the range GET /api/v1/valuation computes for
 * the same category and condition. Same price, same Leaves, every time.
 *
 * Input is the title, category and condition only. The photo is NOT sent: the
 * search needs words, and a photo would add cost and a privacy question for no
 * better answer.
 *
 * ── TWO OUTCOMES, BOTH 200 ──────────────────────────────────────────────────
 *
 *   status "ai"        At least two verified priced listings. Comes with the
 *                      price summary, the level and the whole level table, up
 *                      to 3 source links with their prices, and a TICKET the
 *                      client sends with POST /api/items so the listing is
 *                      created with exactly this number.
 *
 *   status "fallback"  No AI suggestion, and `reason` says why. `baseline` is
 *                      the deterministic suggestion the listing will get if it
 *                      is created without a ticket. Clients must show it as
 *                      Baylo's standard estimate, never as an AI result.
 *
 * An Anthropic outage is a 503 (code AI_UNAVAILABLE) rather than a 200
 * fallback, for the reason /api/ai/identify gives: an outage that answers 200
 * is an outage nobody notices. Clients treat it as a fallback all the same.
 *
 * Sources and the explanation are returned once and never stored.
 */

const requestSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  category: categorySchema,
  condition: conditionSchema,
})

/** All of Claude's time for one valuation. The app gives up at 30 seconds. */
const VALUATION_DEADLINE_MS = 26_000

function baselineOf(v: Valuation) {
  return {
    suggestedLeaves: v.suggestedLeaves,
    min: v.min,
    max: v.max,
    allowed: v.allowed,
    valuationSource: v.valuationSource,
    sampleSize: v.sampleSize,
  }
}

function fallback(reason: AiFallbackReason, baseline: Valuation) {
  return NextResponse.json({
    status: "fallback" as const,
    reason,
    message: AI_FALLBACK_MESSAGES[reason],
    baseline: baselineOf(baseline),
  })
}

export async function POST(req: NextRequest) {
  const session = await resolveSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, { status: 401 })
  }
  const userId = session.user.id

  const limited = enforceRateLimit("aiValuation", userId)
  if (limited) return limited

  const parsed = await parseBody(req, requestSchema)
  if (!parsed.ok) return parsed.response
  const { title, category, condition } = parsed.data

  // The guardrail. Same function, same range the create handler falls back to.
  const baseline = await valuate(category, condition)

  // Every block of the turn, across pause_turn continuations.
  const content: Anthropic.ContentBlock[] = []
  let stopReason: string | null = null
  const startedAt = Date.now()
  try {
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: aiValuationUserMessage({
          title,
          categoryLabel: categoryLabel(category),
          conditionLabel: conditionLabel(condition),
        }),
      },
    ]
    // A turn with several searches can come back as pause_turn: the server
    // stopped mid-turn and the answer is not written yet. Send the partial
    // turn back and it carries on. Bounded, and inside the app's 30-second
    // request timeout.
    for (let round = 0; round < 3; round++) {
      const remaining = VALUATION_DEADLINE_MS - (Date.now() - startedAt)
      if (remaining < 4_000) break
      const message = await anthropic().messages.create(
        {
          model: HAIKU_MODEL,
          max_tokens: 2048,
          system: AI_VALUATION_SYSTEM_PROMPT,
          messages,
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: AI_VALUATION_MAX_SEARCHES,
              user_location: {
                type: "approximate",
                city: "Lapu-Lapu City",
                region: "Central Visayas",
                country: "PH",
                timezone: "Asia/Manila",
              },
            },
          ],
        },
        { timeout: remaining, maxRetries: 0 },
      )
      content.push(...message.content)
      stopReason = message.stop_reason
      if (message.stop_reason !== "pause_turn") break
      messages.push({ role: "assistant", content: message.content })
    }
  } catch (error) {
    console.error(
      "[ai-valuation] Claude call failed:",
      error instanceof Anthropic.APIError ? `status ${error.status}` : "",
      error instanceof Error ? error.message : "unknown error",
    )
    return NextResponse.json(
      {
        error: AI_FALLBACK_MESSAGES.AI_UNAVAILABLE,
        code: "AI_UNAVAILABLE",
        baseline: baselineOf(baseline),
      },
      { status: 503 },
    )
  }

  // Joined with nothing: a cited answer arrives as several text blocks, and a
  // block boundary can fall inside the JSON.
  const textBlocks = content.filter((b): b is Anthropic.TextBlock => b.type === "text")
  const answer = parseAiValuationAnswer(textBlocks.map((b) => b.text).join(""))

  const resultBlocks = content.filter(
    (b): b is Anthropic.WebSearchToolResultBlock => b.type === "web_search_tool_result",
  )
  const searchResults = resultBlocks.flatMap((b) => (Array.isArray(b.content) ? b.content : []))
  // A failed search comes back as an error object in place of the results
  // list (max_uses_exceeded, too_many_requests, unavailable...). Before this
  // it read as "no results" with nothing in the logs.
  const searchErrors = resultBlocks.flatMap((b) =>
    Array.isArray(b.content) ? [] : [(b.content as { error_code?: string }).error_code ?? "unknown"],
  )
  const listings = verifiedListings(answer?.listings ?? [], searchResults)

  const decision = decideAiValuation(answer, listings, category, { min: baseline.min, max: baseline.max })
  if (!decision.ok) {
    // What a fallback actually was, so "no prices found" can be told apart
    // from "prices found but their URLs did not match" and from a search
    // error. No title (user text) and no URLs, only counts.
    console.warn(
      `[ai-valuation] fallback: ${decision.reason} (${category}/${condition})`,
      JSON.stringify({
        stop: stopReason,
        ms: Date.now() - startedAt,
        searches: resultBlocks.length,
        results: searchResults.length,
        searchErrors,
        claimed: answer?.listings.length ?? null,
        verified: listings.length,
        note: answer?.note.slice(0, 200) ?? null,
      }),
    )
    return fallback(decision.reason, baseline)
  }

  const ticket = issueTicket({
    userId,
    title,
    category,
    condition,
    suggestedLeaves: decision.suggestedLeaves,
    min: baseline.min,
    max: baseline.max,
  })
  if (!ticket) {
    // No AUTH_SECRET means no verifiable ticket, and an AI number the create
    // handler cannot verify must not be shown as the listing's value.
    console.error("[ai-valuation] AUTH_SECRET is not set; cannot issue a valuation ticket")
    return fallback("AI_UNAVAILABLE", baseline)
  }

  return NextResponse.json({
    status: "ai" as const,
    valuation: {
      suggestedLeaves: decision.suggestedLeaves,
      min: baseline.min,
      max: baseline.max,
      allowed: aiAllowed(decision.suggestedLeaves),
      valuationSource: AI_VALUATION_SOURCE,
      sampleSize: decision.market.listingCount,
    },
    market: decision.market,
    level: {
      ...decision.level,
      categoryLabel: categoryLabel(category),
      ...decision.table,
    },
    note: decision.note,
    sources: decision.sources,
    checkedAt: new Date().toISOString(),
    ticket: ticket.ticket,
    expiresAt: ticket.expiresAt,
    baseline: baselineOf(baseline),
  })
}
