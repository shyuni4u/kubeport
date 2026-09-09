"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/role";

type Props = { role: Role; withLabel?: boolean; className?: string };

const palette: Record<Role, string> = {
  admin:
    "bg-purple-50 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  user: "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
};

// "Admin" / "User" are the role names themselves — the same word in both
// locales, and the value the backend uses. Only the trailing explanation is
// translated (#40).
const shortLabel: Record<Role, string> = {
  admin: "Admin",
  user: "User",
};

export function RoleBadge({ role, withLabel = false, className }: Props) {
  const t = useTranslations("shell.role");
  return (
    <Badge className={cn("border-transparent", palette[role], className)}>
      {withLabel
        ? `${shortLabel[role]} · ${t(role === "admin" ? "adminDesc" : "userDesc")}`
        : shortLabel[role]}
    </Badge>
  );
}
