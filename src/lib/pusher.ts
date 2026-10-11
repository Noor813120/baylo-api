import Pusher from "pusher";

/*
 * Server-side Pusher client. Routes never call it directly: they go through
 * notifyUser() in ./realtime, which is the reason a Pusher failure cannot
 * change an HTTP response. See that file.
 */

// The sentinel exists for scripts/scratch-dev-safe.ps1 -PusherSecret unset.
// On Windows an empty environment variable is a deleted one, and Next then
// refills a deleted variable from .env, so "no secret" cannot be expressed by
// clearing it. This maps the sentinel to the genuinely missing secret, which
// makes trigger() throw synchronously exactly as it would on a server whose
// .env lacks the line.
const secret = process.env.PUSHER_SECRET === "__unset__" ? undefined : process.env.PUSHER_SECRET;

const pusherServer = new Pusher({
  appId: process.env.PUSHER_APP_ID!,
  key: process.env.NEXT_PUBLIC_PUSHER_KEY!,
  secret: secret!,
  cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER!,
  useTLS: true,
  // Milliseconds. Without it a network that hangs rather than refusing holds
  // an awaited trigger (and so the route's response) for the OS TCP timeout.
  timeout: 3000,
});

export default pusherServer;
