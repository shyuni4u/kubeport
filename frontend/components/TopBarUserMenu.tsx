"use client";

import { useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RoleBadge } from "./RoleBadge";
import type { Role } from "@/lib/role";

type Props = { email: string; role: Role };

export function TopBarUserMenu({ email, role }: Props) {
  const t = useTranslations("shell");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent" />
        }
      >
        <RoleBadge role={role} />
        <span className="opacity-80 text-sm">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled>
          <RoleBadge role={role} withLabel />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            // Do the logout as an explicit fetch + hard redirect instead of a
            // <form> nested in the menu item: base-ui closes the menu on select
            // and can swallow the native form submit, so the button appeared to
            // do nothing. The fetch sends the same-origin Origin header the
            // route's CSRF check expects.
            void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
              window.location.assign("/");
            });
          }}
        >
          {t("logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
