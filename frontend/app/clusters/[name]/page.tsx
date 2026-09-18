import { ClusterPage } from "@/components/ClusterPage";

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <ClusterPage area="settings" initialCluster={name} />;
}
