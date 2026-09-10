import { apiFetch } from "@/lib/api-server";
import { releaseReadFailed } from "@/lib/release-read";
import { LogsPanel } from "@/components/LogsPanel";

export default async function ReleaseLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ instance?: string | string[] }>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) releaseReadFailed(res.status, id);
  const d = (await res.json()) as { id: string; instances: { name: string }[] };
  // `?instance=` comes from the instance row's "Logs →" link. Only honour it
  // when it names a known instance — anything else falls back to "all".
  const requested = Array.isArray(sp.instance) ? sp.instance[0] : sp.instance;
  const initialInstance =
    requested && d.instances.some((i) => i.name === requested) ? requested : "all";
  return (
    <LogsPanel releaseId={d.id} instances={d.instances} initialInstance={initialInstance} />
  );
}
