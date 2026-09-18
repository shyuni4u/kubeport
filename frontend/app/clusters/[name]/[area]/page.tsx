import { notFound } from "next/navigation";
import { ClusterPage } from "@/components/ClusterPage";

export default async function Page({ params }: { params: Promise<{ name: string; area: string }> }) {
  const { name, area } = await params;
  if (area !== "nodes" && area !== "storage" && area !== "network") notFound();
  return <ClusterPage area={area} initialCluster={name} />;
}
