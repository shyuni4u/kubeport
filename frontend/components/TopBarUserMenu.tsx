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
      {/*
        `min-w-0` is the whole fix for #133, and it has to be here rather than
        on the span: a flex item defaults to `min-width: auto`, which refuses
        to shrink below its content, so the email pushed the button 5.5px past
        a 390px viewport and put a horizontal scrollbar on every page. The
        spacer beside it collapses first; this lets the button take the rest.

        No max-width — the email should use whatever room the header has and
        truncate only when it runs out. The badge keeps its size (`shrink-0`)
        because it is the one part that stays legible at any width.
      */}
      <DropdownMenuTrigger
        render={
          <button className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 hover:bg-hover" />
        }
      >
        <RoleBadge role={role} className="shrink-0" />
        <span className="truncate opacity-80 text-sm">{email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled>
          <RoleBadge role={role} withLabel />
        </DropdownMenuItem>
        {/*
          The trigger can now be too narrow to show the whole address, and a
          `title` would not help the phones that made it narrow (#115). The
          menu has the room, so the full address lives here — otherwise
          truncating would leave a narrow screen with no way to tell which
          account is signed in.
        */}
        <DropdownMenuItem disabled className="text-xs break-all opacity-100">
          {email}
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
