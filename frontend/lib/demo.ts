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
 *  the same template with the default name don't collide on (cluster, ns, name). */
export function withDemoSuffix(name: string, isDemo: boolean, rand: () => number = Math.random): string {
  if (!isDemo) return name;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return `${name}-${s}`;
}
