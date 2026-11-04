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
  verifiedSources,
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

/**
 * POST /api/ai/valuation -- the AI-assisted official Leaves suggestion.
 *
 * Claude searches current online listings for the item and recommends a Leaves
 * value inside the range GET /api/v1/valuation computes for the same category
 * and condition. See @/lib/ai-valuation for what Claude may and may not decide.
 *
 * Input is the title, category and condition only. The photo is NOT sent: the
 * search needs words, and a photo would add cost and a privacy question for no
 * better answer.
 *
 * ── TWO OUTCOMES, BOTH 200 ──────────────────────────────────────────────────
 *
 *   status "ai"        Claude's number passed every check. Comes with an
 *                      explanation, 2-3 verified source links, and a TICKET the
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

  let message: Anthropic.Message
  try {
    message = await anthropic().messages.create({
      model: HAIKU_MODEL,
      max_tokens: 700,
      system: AI_VALUATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: aiValuationUserMessage(
            {
              title,
              category,
              categoryLabel: categoryLabel(category),
              condition,
              conditionLabel: conditionLabel(condition),
            },
            baseline,
          ),
        },
      ],
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
    })
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

  const textBlocks = message.content.filter((b): b is Anthropic.TextBlock => b.type === "text")
  const answer = parseAiValuationAnswer(textBlocks.map((b) => b.text).join("\n"))

  const searchResults = message.content.flatMap((b) =>
    b.type === "web_search_tool_result" && Array.isArray(b.content) ? b.content : [],
  )
  const citedUrls = textBlocks.flatMap((b) =>
    (b.citations ?? []).flatMap((c) => (c.type === "web_search_result_location" ? [c.url] : [])),
  )
  const sources = verifiedSources([...(answer?.sourceUrls ?? []), ...citedUrls], searchResults)

  const decision = decideAiValuation(answer, sources, { min: baseline.min, max: baseline.max })
  if (!decision.ok) {
    console.warn(`[ai-valuation] fallback: ${decision.reason} (${category}/${condition})`)
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
      sampleSize: decision.sources.length,
    },
    explanation: decision.explanation,
    sources: decision.sources,
    checkedAt: new Date().toISOString(),
    ticket: ticket.ticket,
    expiresAt: ticket.expiresAt,
    baseline: baselineOf(baseline),
  })
}
