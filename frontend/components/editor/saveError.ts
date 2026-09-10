// Maps a failed template save/create response to an admin-readable sentence.
// The backend detail is kept for 400 (it's the YAML / ui-spec validation
// message the author needs) and for the generic fallback; 409 and 403 get a
// portal-concept explanation instead of a raw JSON body.
//
// `t` is a `useTranslations("templates.editor")` instance.
import { problemTitle } from "@/lib/problem";

type Translator = (key: string, values?: Record<string, string | number>) => string;

// `creating` marks POST /v1/templates — a brand-new template rather than a
// version of an existing one. It changes what a demo refusal means (#180).
export async function saveErrorMessage(
  t: Translator,
  res: Response,
  { creating = false }: { creating?: boolean } = {},
): Promise<string> {
  const detail = (await res.text().catch(() => "")).trim();
  switch (res.status) {
    case 409:
      return t("errors.draftExists");
    case 403:
      // Two refusals share the status. A demo account is refused as
      // `demo-restricted` — it holds the admin group, so "no permission"
      // sent the author looking for a role they already have (#180).
      //
      // And the demo gate refuses two different things. Creating a template
      // is off for demo accounts unless the install turns it on; editing is
      // refused only for templates the demo did not create. Telling someone
      // on the new-template screen that they "can only edit demo templates"
      // named a rule that was not what stopped them.
      if (problemTitle(detail) === "demo-restricted") {
        return creating ? t("errors.demoCreateRestricted") : t("errors.demoRestricted");
      }
      return t("errors.forbidden");
    case 400:
      return t("errors.invalid", { detail });
    case 429:
      // The authoring routes are rate limited (issue #135), so this is
      // reachable on a real save. Without a case here it fell through to
      // `generic`, which prints the status and the Problem document — and
      // the one thing the author needs to know is that waiting fixes it.
      return t("errors.rateLimited");
    default:
      return t("errors.generic", { status: res.status, detail });
  }
}
