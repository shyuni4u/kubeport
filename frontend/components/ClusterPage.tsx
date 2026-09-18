import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api-server";
import { roleFromGroups } from "@/lib/role";
import { isDemoEmail } from "@/lib/demo";
import { ClusterWorkspace } from "./ClusterWorkspace";

export async function ClusterPage({
  area,
  initialCluster,
}: {
  area: "settings" | "nodes" | "storage" | "network";
  initialCluster?: string;
}) {
  const res = await apiFetch("/v1/me");
  if (!res.ok) redirect("/");
  const me = await res.json();
  const admin = roleFromGroups(me.groups) === "admin";
  if (area === "nodes" && !admin)
    redirect(initialCluster ? `/clusters/${encodeURIComponent(initialCluster)}` : "/clusters");
  return (
    <ClusterWorkspace key={`${initialCluster ?? ""}:${area}`} area={area} initialCluster={initialCluster} admin={admin} demo={isDemoEmail(me.email)} />
  );
}
