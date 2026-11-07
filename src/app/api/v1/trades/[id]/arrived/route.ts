import { NextRequest } from "next/server"
import { resolveSession } from "@/lib/api-auth"
import prisma from "@/lib/prisma"
import { ok, unauthenticated, notFound, forbidden, conflict, fail } from "@/lib/v1/envelope"
import { withJsonErrors } from "@/lib/v1/with-json-errors"
import { resolveTradeParticipant } from "@/lib/trade-participant"
import { MEETUP_SELECT } from "@/lib/meetup"
import { hasArrived, recordArrival } from "@/lib/arrival"
import { notifyUser } from "@/lib/realtime"

/**
 * POST /api/v1/trades/:id/arrived -- "I'm here" at the meetup hub.
 *
 * Records the caller's arrival (see @/lib/arrival) and answers who is there:
 * `{ arrival: { me, partner } }`. The codes are issued by confirm/start, which
 * now waits for both. The partner hears about it three ways: a push ("… is at
 * <hub>"), the arrival message in their chat, and trade-status-changed so an
 * open trade screen refreshes.
 */
export const POST = withJsonErrors("POST v1/trades/[id]/arrived", arrived)

async function arrived(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSession()
  if (!session?.user?.id) return unauthenticated()
  const { id } = await params

  const trade = await prisma.trade.findUnique({
    where: { id },
    select: { id: true, status: true, senderId: true, receiverId: true, ...MEETUP_SELECT },
  })
  if (!trade || trade.status === null) return notFound("Trade not found")
  const who = await resolveTradeParticipant(session.user.id, req.headers, trade)
  if (!who.ok) {
    return who.kind === "org_refused" ? fail("ORG_CONTEXT_REFUSED", who.message) : forbidden("That trade is not yours")
  }
  if (trade.status !== "ACCEPTED" && trade.status !== "CONFIRMING") {
    return conflict("That trade is not waiting for a handover.")
  }

  const me = who.participantId
  const partnerId = trade.senderId === me ? trade.receiverId : trade.senderId
  const hubName = trade.meetupHub?.name ?? null

  const already = await hasArrived(trade.id, me)
  if (!already) {
    await recordArrival({ tradeId: trade.id, userId: me, partnerId, hubName })
    // The push. The bell row is what triggers it (see @/lib/prisma); a failed
    // notification must not undo an arrival that is already recorded.
    await prisma.notification
      .create({
        data: {
          userId: partnerId,
          type: "MEETUP_AGREED",
          message: hubName ? `is at ${hubName}` : "is at the hub",
          actorId: me,
          entityType: "meetup",
          entityId: trade.id,
        },
      })
      .catch(() => undefined)
    const changed = { tradeId: trade.id, newStatus: trade.status, arrived: me }
    await Promise.all([
      notifyUser(partnerId, "trade-status-changed", changed),
      notifyUser(me, "trade-status-changed", changed),
    ])
  }

  const partner = await hasArrived(trade.id, partnerId)
  return ok({ arrival: { me: true, partner } })
}
