import { StatusChip } from "@/components/StatusChip";

/** Loaded version identity; keeps long names readable on narrow screens. */
export function VersionHeading({ name, version, status, statusLabel }: {
  name: string;
  version: string;
  status: string;
  statusLabel: string;
}) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-3">
      <h1 className="min-w-0 max-w-full break-all text-xl font-semibold">
        {name} <span className="whitespace-nowrap">v{version}</span>
      </h1>
      <StatusChip variant={status === "draft" ? "warning" : status === "published" ? "success" : "muted"}>
        {statusLabel}
      </StatusChip>
    </header>
  );
}
