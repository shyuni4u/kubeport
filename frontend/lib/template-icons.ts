import { Box, Database, Globe, Server, type LucideIcon } from "lucide-react";

const MAP: Record<string, LucideIcon> = {
  web: Globe,
  frontend: Globe,
  database: Database,
  db: Database,
  backend: Server,
  api: Server,
};

export function iconFor(tags: readonly string[] | undefined | null): LucideIcon {
  if (!tags) return Box;
  for (const t of tags) {
    const hit = MAP[t.toLowerCase()];
    if (hit) return hit;
  }
  return Box;
}
