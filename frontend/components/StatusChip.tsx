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
    // The two drift states Plan 8 detects at read time. Both are recoverable
    // bookkeeping — the DB and the cluster disagree — not an outage, and both
    // are explained by ReleaseStaleBanner, which is amber for either one.
    //
    // `resources-missing` used to be `danger` here, so the page showed a red
    // chip above an amber banner about the same fact and the reader had to
    // guess which severity to believe (#114). Its sibling was already
    // `warning`; this makes the family agree with itself and with the banner.
    case "cluster-unreachable":
    case "resources-missing":
      return "warning";
    case "error":
    case "failed":
      return "danger";
    case "deprecated":
      return "muted";
    default:
      return "muted";
  }
}
