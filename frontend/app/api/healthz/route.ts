import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Public health passthrough.
 *
 * The ingress sends every external request to this BFF; the Go API stays on
 * its in-cluster Service (see `deploy/helm/kubeport/templates/ingress.yaml`).
 * That boundary is deliberate, so the way to let an outside observer read the
 * API's health is to proxy it here rather than to publish the backend.
 *
 * Why anything outside needs to read it: the demo reset CronJob wipes first
 * and re-seeds second, so a failed seed leaves an empty catalog that nothing
 * notices until the next reset (#104 was found only because a browser review
 * happened to run just after a reset). `uptime-ping.yml` already runs every
 * ten minutes; giving it something to assert turns it into the alert channel
 * for #119 without new infrastructure.
 *
 * The catalog count itself is opt-in on the backend
 * (`KBP_HEALTH_PUBLIC_CATALOG`), so on a self-hosted install this returns just
 * `{"status":"ok","version":"<sha>"}` and discloses nothing the public
 * repository does not already.
 *
 * The body also carries the backend's `version` (short git sha). That is how
 * `.github/workflows/deploy.yml` confirms a rollout landed, and how anyone
 * can tell which commit is live without shell access to the node. It is the
 * backend's build, not this frontend's — both are built from the same commit
 * and deployed together, so one value answers the question.
 *
 * No session check: it is a liveness probe, and requiring auth would defeat
 * the point. Nothing here reflects caller-supplied input.
 */
export async function GET() {
  const base = process.env.GO_API_BASE_URL;
  if (!base) {
    return NextResponse.json(
      { status: "degraded", reason: "backend not configured" },
      { status: 503 },
    );
  }
  try {
    const upstream = await fetch(`${base}/healthz?verbose=1`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!upstream.ok) {
      return NextResponse.json({ status: "degraded" }, { status: 503 });
    }
    // Pass the backend's body through verbatim — it is already the contract
    // the cron reads, and re-shaping it here would give us two schemas to
    // keep in step.
    return NextResponse.json(await upstream.json(), { status: 200 });
  } catch {
    // Includes the timeout above. The reason is withheld for the same reason
    // every other unauthenticated error withholds it: this one would carry
    // the in-cluster Service address.
    return NextResponse.json({ status: "degraded" }, { status: 503 });
  }
}
