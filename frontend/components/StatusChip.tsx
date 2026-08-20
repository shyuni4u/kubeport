import { Badge } from "@/components/ui/badge";

export type StatusVariant = "success" | "warning" | "danger" | "muted";

const variantToBadge: Record<StatusVariant, "success" | "warning" | "destructive" | "muted"> = {
  success: "success",
  warning: "warning",
  danger: "destructive",
  muted: "muted",
};

type Props = {
  variant: StatusVariant;
  children: React.ReactNode;
  className?: string;
};

export function StatusChip({ variant, children, className }: Props) {
  return (
    <Badge variant={variantToBadge[variant]} className={className}>
      {children}
    </Badge>
  );
}

export function statusChipVariantFromRelease(status: string): StatusVariant {
  switch (status) {
    case "healthy":
      return "success";
    case "warning":
    case "cluster-unreachable":
      return "warning";
    case "error":
    case "failed":
    case "resources-missing":
      return "danger";
    case "deprecated":
      return "muted";
    default:
      return "muted";
  }
}
