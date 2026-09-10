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
import { useLogout } from "@/lib/use-logout";

type Props = { email: string; role: Role };

export function TopBarUserMenu({ email, role }: Props) {
  const t = useTranslations("shell");
  const tl = useTranslations("logout");
  const { pending, failed, logout, dismiss } = useLogout();
  return (
    <>
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
          disabled={pending}
          onClick={() => {
            // An explicit fetch instead of a <form> nested in the menu item:
            // base-ui closes the menu on select and can swallow the native form
            // submit, so the button appeared to do nothing.
            //
            // And it leaves only when the logout worked (#166). This used to
            // navigate to "/" in .finally, so a refused logout — every one,
            // after a domain change the Origin check was not told about —
            // looked exactly like a successful one while the session lived on.
            void logout();
          }}
        >
          {t("logout")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {/*
      Outside the menu, because the menu has already closed by the time the
      answer arrives — a message inside it would never be seen.
    */}
    {failed && (
      <div
        role="alert"
        className="fixed right-4 top-14 z-50 flex max-w-sm items-start gap-3 rounded-md border bg-background px-3 py-2 text-sm text-destructive shadow-md"
      >
        <span>{tl("failed")}</span>
        <button
          type="button"
          onClick={dismiss}
          className="shrink-0 text-xs text-muted-foreground underline"
        >
          {tl("dismiss")}
        </button>
      </div>
    )}
    </>
  );
}
