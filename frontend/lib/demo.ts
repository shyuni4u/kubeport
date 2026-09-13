import { SINGLE_INSTANCE_RULES, type ReleaseNameRules } from "./release-name";

export function isDemoEmail(
  email: string | null | undefined,
  domain: string = process.env.DEMO_EMAIL_DOMAIN ?? "demo.kubeport",
): boolean {
  if (!email || !domain) return false;
  return email.toLowerCase().endsWith("@" + domain.toLowerCase());
}

/** The namespace a demo session should deploy into, or undefined for anyone
 *  else. DEMO_NAMESPACE is rendered by the chart only with demo mode on, and
 *  demo accounts' RBAC covers that namespace alone — so starting them anywhere
 *  else opened the deploy form on a permission denial (#179). */
export function demoNamespaceFor(
  email: string | null | undefined,
  namespace: string | undefined = process.env.DEMO_NAMESPACE,
  domain?: string,
): string | undefined {
  if (!isDemoEmail(email, domain)) return undefined;
  const ns = namespace?.trim();
  return ns ? ns : undefined;
}

/** Appends a 4-char lowercase suffix for demo users so two visitors deploying
 *  the same template with the default name don't collide on (cluster, ns, name).
 *
 *  The result prefills the deploy form, which accepts only a lowercase DNS-1123
 *  label (#182). Template names are not held to that — nothing validates their
 *  format — so the template name is folded into one first. Otherwise a template
 *  called `WebApp` would open the form on a red error the visitor never typed.
 *  The same goes for a multi-instance template's `rules` (#190): a shorter
 *  limit, and a letter first when a Service takes the name. */
export function withDemoSuffix(
  name: string,
  isDemo: boolean,
  rand: () => number = Math.random,
  rules: ReleaseNameRules = SINGLE_INSTANCE_RULES,
): string {
  if (!isDemo) return name;
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const alphabet = letters + "0123456789";
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (rules.letterFirst) base = base.replace(/^[^a-z]+/, "");
  let s = "";
  for (let i = 0; i < 4; i++) {
    // With no base, the suffix is the whole name and its first character leads.
    const pool = rules.letterFirst && !base && i === 0 ? letters : alphabet;
    s += pool[Math.floor(rand() * pool.length)];
  }
  // Room for "-" and the suffix.
  base = base.slice(0, Math.max(0, rules.maxLength - (s.length + 1))).replace(/-+$/, "");
  return base ? `${base}-${s}` : s;
}
