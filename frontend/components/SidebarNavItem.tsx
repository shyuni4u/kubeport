"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function SidebarNavItem({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + "/");
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center rounded-md px-3 py-2 text-sm transition-colors",
        // The active item and a hovered item used to paint the *same* fill —
        // `--sidebar-accent`, about 1.11:1 on the white sidebar — so the nav
        // could not say which page you were on, and hovering told you nothing
        // either. Same shape as #110, one screen over.
        active
          ? "bg-selected text-selected-foreground font-semibold"
          : "text-sidebar-foreground/70 hover:bg-hover hover:text-foreground"
      )}
    >
      {label}
    </Link>
  );
}
