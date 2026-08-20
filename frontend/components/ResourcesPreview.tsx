"use client";

import { useMemo } from "react";
import YAML from "yaml";

type Props = {
  renderedYaml: string | null;
  pending: boolean;
};

type Resource = { kind: string; name: string };

export function ResourcesPreview({ renderedYaml, pending }: Props) {
  const resources = useMemo<Resource[]>(() => {
    if (!renderedYaml) return [];
    try {
      const docs = YAML.parseAllDocuments(renderedYaml);
      return docs
        .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string } } | null)
        .filter(
          (x): x is { kind: string; metadata?: { name?: string } } =>
            !!x && typeof x.kind === "string",
        )
        .map((x) => ({ kind: x.kind, name: x.metadata?.name ?? "(unnamed)" }));
    } catch {
      return [];
    }
  }, [renderedYaml]);

  return (
    <aside className="flex flex-col gap-3 rounded-md bg-muted/40 p-4">
      <h2 className="text-sm font-medium">만들어질 리소스</h2>
      {pending && <p className="text-xs text-muted-foreground">렌더링 중…</p>}
      {!pending && resources.length === 0 && (
        <p className="text-xs text-muted-foreground">폼을 채우면 미리보기가 여기 표시됩니다.</p>
      )}
      {resources.length > 0 && (
        <ul className="flex flex-col gap-1">
          {resources.map((r, idx) => (
            <li
              key={`${r.kind}-${r.name}-${idx}`}
              className="flex items-center justify-between text-sm"
            >
              <span className="font-mono text-xs text-muted-foreground">{r.kind}</span>
              <span>{r.name}</span>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
