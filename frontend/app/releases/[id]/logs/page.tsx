import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import { LogsPanel } from "@/components/LogsPanel";

export default async function ReleaseLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) notFound();
  const d = (await res.json()) as { id: string; instances: { name: string }[] };
  return <LogsPanel releaseId={d.id} instances={d.instances} />;
}
