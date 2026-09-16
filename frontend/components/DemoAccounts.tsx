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
    <section aria-labelledby="demo-heading" className="w-full rounded-xl border bg-card p-4 text-left text-card-foreground sm:p-6">
      <h2 id="demo-heading" className="text-lg font-semibold">{t("demoTitle")}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{t("demoLoginHelp")}</p>
      {passwordHint && (
        <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-muted px-4 py-3">
          <dt className="text-sm font-medium">{t("demoPasswordLabel")}</dt>
          <dd className="min-w-0 break-all select-all font-mono text-lg font-semibold">{passwordHint}</dd>
        </dl>
      )}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {accounts.map((a) => (
          <div key={a.email} className="min-w-0 rounded-lg border p-4">
            <dl>
              <dt className="text-sm text-muted-foreground">{t("demoAccountLabel")}</dt>
              {/* select-all: one click selects the whole address for copying. */}
              <dd className="mt-1 break-all select-all font-mono text-sm font-medium">{a.email}</dd>
            </dl>
            <a href={a.href} className="mt-3 flex min-h-11 items-center justify-center rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {a.label}
            </a>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-muted-foreground">{t("demoNote")}</p>
    </section>
  );
}
