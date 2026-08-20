import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Role } from "@/lib/role";

type Props = { role: Role; withLabel?: boolean; className?: string };

const palette: Record<Role, string> = {
  admin:
    "bg-purple-50 text-purple-800 dark:bg-purple-950 dark:text-purple-200",
  user: "bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200",
};

const shortLabel: Record<Role, string> = {
  admin: "Admin",
  user: "User",
};

const longLabel: Record<Role, string> = {
  admin: "Admin · 템플릿 작성",
  user: "User · 카탈로그 소비",
};

export function RoleBadge({ role, withLabel = false, className }: Props) {
  return (
    <Badge className={cn("border-transparent", palette[role], className)}>
      {withLabel ? longLabel[role] : shortLabel[role]}
    </Badge>
  );
}
