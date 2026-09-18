import { redirect } from "next/navigation";
import { apiFetch } from "@/lib/api-server";
import { roleFromGroups } from "@/lib/role";
import { isDemoEmail } from "@/lib/demo";
import { ClusterWorkspace } from "./ClusterWorkspace";

export async function ClusterPage({
  area,
}: {
  area: "settings" | "nodes" | "storage" | "network";
}) {
  const res = await apiFetch("/v1/me");
  if (!res.ok) redirect("/");
  const me = await res.json();
  const admin = roleFromGroups(me.groups) === "admin";
  if (area === "nodes" && !admin) redirect("/clusters");
  return (
    <ClusterWorkspace area={area} admin={admin} demo={isDemoEmail(me.email)} />
  );
}
