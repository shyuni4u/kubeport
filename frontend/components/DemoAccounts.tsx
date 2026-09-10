import { useTranslations } from "next-intl";

export type DemoAccount = {
  /** Button text, already translated ("관리자로 체험"). */
  label: string;
  /** Where the button starts the demo login. */
  href: string;
  /** The account's sign-in email. */
  email: string;
};

type Props = {
  accounts: DemoAccount[];
  /** DEMO_PASSWORD_HINT; empty hides the password line. */
  passwordHint: string;
};

/**
 * The landing page's demo entry: one button per account, with that account's
 * email right under it.
 *
 * The email used to be nowhere on the page (#29). The buttons pass it as
 * `login_hint`, on the assumption that Dex pre-fills its login form from it —
 * but Dex's local connector ignores login_hint, so a first visitor reached an
 * empty login form knowing the password and not the account. Showing the email
 * here is the only thing that gets them through.
 */
export function DemoAccounts({ accounts, passwordHint }: Props) {
  const t = useTranslations("landing");
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-3">
        {accounts.map((a) => (
          <div key={a.email} className="flex flex-col items-center gap-1">
            <a href={a.href} className="rounded-md border px-4 py-2 hover:bg-hover">
              {a.label}
            </a>
            <span className="text-xs text-muted-foreground">
              {t("demoAccountLabel")}{" "}
              {/* select-all: one click selects the whole address for copying. */}
              <span className="select-all font-mono">{a.email}</span>
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("demoNote")}
        {passwordHint && (
          <>
            <br />
            {t("demoCreds", { password: passwordHint })}
          </>
        )}
      </p>
    </div>
  );
}
