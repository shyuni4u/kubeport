# kubeport Helm chart

Single chart that deploys backend (Go API), frontend (Next.js BFF), an
optional in-cluster Postgres, an Ingress, an optional cert-manager
Certificate, and an `atlas schema apply` initContainer that runs ahead of
the backend container on every Pod start.

Target environments — k3s (Phase 1/2/3 per [ADR 0003](../../../docs/decisions/0003-hosting-oci-always-free.md))
and any conformant Kubernetes cluster with cert-manager + an Ingress
controller. Cloud-neutrality is by design: only `ingress.className`,
`postgres.storage.storageClassName`, the public host, and the OIDC issuer URL
should differ between environments.

## Try it first (any cluster, no Ingress, no cert-manager)

To see the pods come up before committing a domain and an IdP, install with the
values CI uses for its kind smoke test:

```bash
kind create cluster --name kubeport-try     # or use any cluster you already have

helm install kubeport deploy/helm/kubeport \
  --namespace kubeport --create-namespace \
  -f deploy/helm/kubeport/ci/smoke-values.yaml \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set auth.oidcClientSecret=$(openssl rand -hex 24) \
  --set postgres.password=$(openssl rand -hex 24) \
  --wait --timeout 5m

kubectl -n kubeport port-forward svc/kubeport-frontend 3000:3000
# http://localhost:3000 — the landing page renders; login will not complete
```

**The three `--set` lines are not optional.** `ci/smoke-values.yaml` carries
secrets that are committed to this repository — `appEncryptionKeyB64` in it is
32 zero bytes — and that key is what the frontend encrypts users' OIDC access
and refresh tokens with before writing them to the `sessions` table. Installed
as-is, the instance stores real tokens under a key anyone can read here, in a
Postgres whose password is equally public and reachable from any Pod in the
cluster. CI can use those values because its cluster is deleted minutes later;
your cluster may not be.

That matters beyond this throwaway install, because there is a documented route
from here to a real one: "After install" below upgrades a release with
`--reuse-values`, which keeps whatever secrets the install was given. Overriding
them now means that route stays safe. Better still, `helm uninstall` this and
install fresh when you move past evaluating.

`ci/smoke-values.yaml` sets `ingress.enabled=false`, `tls.enabled=false` **and
`tls.certManager.enabled=false`**. That third one is the reason this needs a
values file rather than a flag: `templates/certificate.yaml` keys off
`tls.enabled` and `tls.certManager.enabled` only, so with the chart defaults a
`Certificate` is rendered even when the Ingress is off, and a cluster without
cert-manager's CRDs rejects the install on an object it was never going to use.

Login is the part this path gives up: `oidc.*` points at a real issuer so the
backend's discovery succeeds at startup, but no OAuth client is registered for
`localhost`, so the redirect will not come back. This checks that the chart
installs and the pods reach Ready — for a working login, do the full install
below.

Two more keys are worth knowing before you reach for `--set`, because helm
**silently ignores** an unknown one and leaves you looking for a failure that
never gets logged:

| It is not | It is |
|---|---|
| `postgres.enabled` | `postgres.embedded` |
| `postgres.storageClassName` | `postgres.storage.storageClassName` |

Tear down with `kind delete cluster --name kubeport-try`.

## Quick install (any cluster)

```bash
# 1. Generate secrets locally — never commit them
ENC_KEY=$(openssl rand -base64 32)
PG_PASS=$(openssl rand -hex 24)

# 2. Pre-install cert-manager + a ClusterIssuer (one-time per cluster)
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.1/cert-manager.yaml
kubectl wait --for=condition=Available --timeout=120s deploy -n cert-manager --all

cat <<'YAML' | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    email: you@example.com
    server: https://acme-v02.api.letsencrypt.org/directory
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: traefik
YAML

# 3. Install the chart
helm install kubeport deploy/helm/kubeport \
  --namespace kubeport --create-namespace \
  --set host=demo.kubeport.example \
  --set ingress.className=traefik \
  --set postgres.storage.storageClassName=local-path \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=$GOOGLE_OAUTH_CLIENT_ID \
  --set oidc.audience=$GOOGLE_OAUTH_CLIENT_ID \
  --set-string auth.devAdminEmails=$YOUR_EMAIL \
  --set auth.appEncryptionKeyB64=$ENC_KEY \
  --set auth.oidcClientSecret=$GOOGLE_OAUTH_CLIENT_SECRET \
  --set postgres.password=$PG_PASS
```

### Keeping secrets off the command line

While `helm` runs, the three secret `--set` values above
(`auth.appEncryptionKeyB64`, `auth.oidcClientSecret`, `postgres.password`) are
in its arguments, which any other user on the machine can read with `ps` (#64),
and a secret you typed into a command line — the Google client secret, say —
stays in your shell history. That is fine for a throwaway cluster. For one you
keep, skip step 1's `ENC_KEY`/`PG_PASS`, write each secret to a file outside the
repository, and pass the file:

```bash
# Outside the checkout, so a later `git add -A` cannot pick the files up
d="$(mktemp -d)" && chmod 700 "$d"
# No line ending: --set-file and kubectl --from-file keep a file's bytes exactly,
# and Git Bash's openssl ends its output with CRLF
openssl rand -base64 32 | tr -d '\r\n' > "$d/enc_key"
openssl rand -hex 24    | tr -d '\r\n' > "$d/pg_pass"
# Paste the Google OAuth client secret at the silent prompt — not in history, not in ps
read -rs S && printf '%s' "$S" > "$d/oidc_client_secret" && unset S
```

On Linux, macOS and WSL `chmod 700` makes the directory yours alone. Git Bash
on Windows does not change NTFS permissions: the directory keeps whatever its
parent grants (`icacls "$(cygpath -w "$d")"` shows who), so on a Windows machine
other people use, run these steps in WSL.

**Chart-managed Secret, values from files.** Replace the last three lines of the
install command with:

```bash
  --set-file auth.appEncryptionKeyB64="$d/enc_key" \
  --set-file auth.oidcClientSecret="$d/oidc_client_secret" \
  --set-file postgres.password="$d/pg_pass"
```

This keeps them out of history and `ps`, but helm stores them in every release
revision (`helm get values kubeport -n kubeport --revision N`). A key you later
rotate stays readable in older revisions until they age out (`helm upgrade
--history-max`, 10 by default), to anyone who can read Secrets in the namespace
— or ConfigMaps, with `HELM_DRIVER=configmap`.

**External Secret — the auth values never enter the release.** Create the
Secret first, then install with a reference to it ([Secret modes](#secret-modes)):

```bash
# DATABASE_URL for the embedded Postgres: the same password, and the chart's
# Service name — <release>-postgres, or <release>-kubeport-postgres when the
# release name does not contain "kubeport". With an external Postgres, write
# your own URL to the file instead.
printf 'postgres://kubeport:%s@kubeport-postgres:5432/kubeport?sslmode=disable' "$(cat "$d/pg_pass")" > "$d/database_url"

kubectl create namespace kubeport
kubectl -n kubeport create secret generic kubeport-auth \
  --from-file=APP_ENCRYPTION_KEY_B64="$d/enc_key" \
  --from-file=OIDC_CLIENT_SECRET="$d/oidc_client_secret" \
  --from-file=DATABASE_URL="$d/database_url"
kubectl -n kubeport describe secret kubeport-auth   # key names and byte counts, never values

helm install kubeport deploy/helm/kubeport --namespace kubeport \
  --set auth.create=false --set auth.existingSecret=kubeport-auth \
  --set-file postgres.password="$d/pg_pass" \
  --set host=demo.kubeport.example \
  --set ingress.className=traefik \
  --set postgres.storage.storageClassName=local-path \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=$GOOGLE_OAUTH_CLIENT_ID \
  --set oidc.audience=$GOOGLE_OAUTH_CLIENT_ID \
  --set-string auth.devAdminEmails=$YOUR_EMAIL
```

The non-secret flags are the Quick install's — substitute your values the same
way, and add the image tag pins below. `auth.appEncryptionKeyB64` and
`auth.oidcClientSecret` are left out: with `auth.create=false` the chart does
not read them. The embedded Postgres still takes its own password from
`postgres.password`, so that one value stays in the release; with an external
Postgres set `postgres.embedded=false` and drop that line. `--from-literal` would
put the values back into history and `ps`.

**With `dex.enabled=true`** the Secret needs a fourth key, and Dex and the demo
reset Job read their own secrets from the release, not from your Secret — so
those stay in it, passed as files:

```bash
openssl rand -hex 24 | tr -d '\r\n' > "$d/dex_client_secret"
# kubectl create secret:  --from-file=DEMO_OIDC_CLIENT_SECRET="$d/dex_client_secret"
# helm install:           --set-file dex.clientSecret="$d/dex_client_secret"
#                         --set-file demo.adminPassword=<file> --set-file demo.userPassword=<file>
```

See [Demo mode](#demo-mode-dex) for what the demo passwords must match.

Once the install is done, copy `enc_key` (and `pg_pass`) into your password
manager, then `rm -rf "$d"`. Losing `APP_ENCRYPTION_KEY_B64` makes every stored
session undecryptable, and with an external Secret the cluster holds the only
other copy.

This installs the `latest` tag, which is not a version — see the warning helm
prints after install. Add `--set images.backend.tag=sha-<7>
--set images.frontend.tag=sha-<7>` to pin the commit you meant. That is what
[docs/oci-prod-runbook.md §3](../../../docs/oci-prod-runbook.md) does, and it is
the reason rollback works there.

`ingress.className` and `postgres.storage.storageClassName` above are the k3s
values — substitute your cluster's from the "Cloud-specific values" table below
(GKE `gce`/`standard-rwo`, EKS `alb`/`gp3`, …). Leaving the k3s values on a
managed cluster leaves the PVC `Pending` and the Ingress unassigned.

With `ingress.className=traefik` and TLS on, the chart also creates a Traefik
`Middleware` (`traefik.io/v1alpha1`) that redirects http to https, and each
Ingress serving TLS references it (#268). k3s ships everything this needs. On a
Traefik you installed yourself, check both `kubectl get crd middlewares.traefik.io`
and that its Kubernetes CRD provider is enabled: without the CRD `helm install`
fails with `no matches for kind "Middleware"`; without the provider the install
succeeds but every request to the host answers 404. If either is missing — or
something in front already redirects, or terminates TLS and forwards plain
http — add `--set ingress.httpsRedirect=false`.

`oidc.audience` must equal your client ID, and `auth.devAdminEmails` is what
makes you an admin — see "After install" step 0 for why both matter.

If the browser reaches kubeport on more than one domain, or TLS is terminated
outside the cluster (Cloudflare, an external load balancer) with
`tls.enabled=false`, list every https origin the browser actually sees in
`frontend.publicOrigins`, e.g. `--set 'frontend.publicOrigins={https://kubeport.example.com}'`.
Logout checks the request's Origin against this list (falling back to the
origin of `oidc.redirectUri`); an origin missing from it makes every logout
fail with "Couldn't sign out. You are still signed in".

`values-gcp-phase1.yaml` and `values-oci-phase2.yaml` are presets for this
project's own single-node k3s hosts. Read them for reference, but don't pass them
with `-f` on a different cluster.

## After install — required on every cluster

`helm install` gets the app running and lets people log in. It does **not** yet
let the app deploy anything. The backend forwards each user's own OIDC token to
the target cluster's API server, so that cluster has to accept the token and the
user has to hold RBAC on it. Skip these steps and you reach the catalog with
**zero deployable clusters** — the cluster dropdown is empty and nothing else
looks broken.

The steps below are cluster-agnostic (GKE / EKS / AKS / k3s alike). Full
commands, verification, and the k3s specifics are in `deploy/oci/README.md` §7
([link](../../oci/README.md)) — that file is named for OCI, but §7 is not
OCI-specific.

0. **Create the first in-app admin.** kubeport decides who is an admin by looking
   for a `kubeport-admin` entry in the id_token's `groups` claim. **Google never
   issues a `groups` claim**, so with Google as your IdP you must bootstrap by
   email instead. `auth.devAdminEmails` defaults to empty, which means *nobody* is
   an admin — and step 3 below is admin-only, so it returns
   `403 admin group required` and the cluster dropdown stays empty forever.

   ```bash
   helm upgrade kubeport deploy/helm/kubeport --reuse-values \
     --set-string auth.devAdminEmails="you@example.com"
   ```

   If your IdP does emit groups (Keycloak / Okta / Dex), map a `kubeport-admin`
   group, set `oidc.scopes="openid email profile groups"`, and leave
   `auth.devAdminEmails` empty.

1. **Make the target API server trust your IdP** (§7.1) — an
   `AuthenticationConfiguration` whose `issuer.url` is your OIDC issuer and whose
   `audiences` is your OAuth client ID. Managed clusters use their own mechanism
   instead of a static file (GKE Workload Identity, EKS
   `associate-identity-provider-config`, AKS OIDC integration).

   Two rules matter as soon as the cluster trusts **more than one** issuer, which
   is the case the moment you enable demo mode (Dex is a second issuer):

   - Give each issuer a distinct `claimMappings.username.prefix`. kubeport's demo
     RBAC is bound to `dex:`-prefixed subjects and must match
     `demo.usernamePrefix`. If two issuers share a prefix, one IdP can mint the
     k8s identity of a user from the other — and the demo IdP's passwords are
     published on the landing page by design. If the prefix merely disagrees with
     `demo.usernamePrefix`, the demo RoleBindings silently bind nothing.
   - When mapping `username` from the `email` claim, also require the address to
     be verified:

     ```yaml
     claimValidationRules:
       - claim: email_verified
         requiredValue: "true"
     ```

2. **Bind RBAC for the operator** (§7.3) — the app never grants k8s permissions
   itself, it only reflects them.

   On a single-purpose cluster (k3s demo / dev), the fastest path is a
   cluster-admin binding:

   ```bash
   kubectl create clusterrolebinding kubeport-owner-admin \
     --clusterrole=cluster-admin --user="<operator email>"
   ```

   On a shared or production cluster, do **not** do that — it puts permanent
   cluster-admin on one personal account. kubeport only needs the MVP workload
   resources, and this chart already ships a worked example of that least-privilege
   set: copy the `demo-admin` Role in `templates/demo-rbac.yaml` and change the
   namespace. The only cluster-scoped grant kubeport itself requires is
   `selfsubjectaccessreviews: create`, which is what makes the RBAC panel work.

   Ordinary users need only namespace-scoped Roles; the deploy form's RBAC panel
   shows whatever `SelfSubjectAccessReview` reports for that user.

   Give those Roles `get` on the kinds your templates render, not only
   `create`/`patch`. When a release has no pods — a CronJob between runs, a
   Deployment scaled to zero — kubeport reads each rendered object with the
   viewer's token to tell "nothing running right now" from "deleted outside
   kubeport". If the viewer can `get` none of them, the release stays `unknown`
   instead of `resources missing`, and the admin force-delete banner does not
   appear for that viewer. (The demo `demo-user` Role withholds `get` on Secrets
   on purpose; that is fine as long as some other rendered kind is readable.)

   Because the binding above is on a raw email address, it is only as strong as
   the username prefix and `email_verified` rules in step 1.

3. **Register the cluster as a deploy target** (§7.4) — `POST /v1/clusters`,
   admin only. There is no cluster-registration screen in the admin UI yet.

   | field | required | note |
   |---|---|---|
   | `name` | **yes** | cluster slug; releases reference it by this name |
   | `api_url` | **yes** | validated as a URL |
   | `oidc_issuer_url` | **yes** | validated as a URL |
   | `ca_bundle` | no — but set it | PEM text, not base64. **If omitted the backend falls back to TLS verification disabled** (`NewInsecureWithToken`) and still returns 201, so the response cannot tell you this happened |
   | `default_namespace` | no | deploy form starts on this namespace, or empty without it. Demo sessions (Dex demo accounts) ignore it and start on `demo.namespace`, the only namespace their RBAC covers |
   | `display_name` | no | UI label |

   The Go API is **ClusterIP-only**: the chart's Ingress sends every external path
   to the frontend BFF, and that BFF authenticates from the session cookie and
   ignores any `Authorization` header you send. So there is no public route to
   `/v1` — port-forward to the backend Service instead:

   ```bash
   kubectl -n kubeport port-forward svc/<release>-backend 8080:8080 &

   curl -sS -X POST http://localhost:8080/v1/clusters \
     -H "Authorization: Bearer $ADMIN_ID_TOKEN" \
     -H 'content-type: application/json' -d '{
       "name": "oci-a1",
       "api_url": "https://kubernetes.default.svc",
       "ca_bundle": "-----BEGIN CERTIFICATE-----\n...",
       "oidc_issuer_url": "https://accounts.google.com",
       "default_namespace": "default"
     }'
   ```

   Obtaining `$ADMIN_ID_TOKEN` non-interactively is not currently documented for
   production IdPs ([#34](https://github.com/shyuni4u/kubeport/issues/34)); Google
   has no password grant. Until that is resolved, `deploy/oci/README.md` §7.4 also
   allows inserting the row directly in the DB — it is infrastructure config, not
   PII.

**Verify the whole chain:** log in → publish a template → deploy it from the
catalog → real Pods show up in the release detail. If `POST /v1/clusters` returns
`403 admin group required`, step 0 is missing; if the cluster dropdown is empty,
step 3; if a deploy fails with 401, step 1; with 403 from the cluster, step 2.
Finally, sign out from the top-bar menu — if it says you are still signed in,
see `frontend.publicOrigins` above.

## Upgrade

```bash
helm upgrade kubeport deploy/helm/kubeport \
  --namespace kubeport \
  --reset-then-reuse-values \
  --set images.backend.tag=$NEW_SHA \
  --set images.frontend.tag=$NEW_SHA
```

`--reset-then-reuse-values` (Helm ≥ 3.14) keeps the values you passed at
install time — secrets included — and fills keys a newer chart added with that
chart's defaults. Plain `--reuse-values` also keeps your values but applies the
*old* chart's defaults, so a key the new chart introduced is missing: it renders
empty or fails (see `deploy/oci/README.md` §7.6). Use it only when you know the
chart added no keys. The
backend Pod's `migrate` initContainer runs `atlas schema apply` before the
backend container starts; if migration fails the new Pod never reaches Ready
and rolling upgrade pauses, so old Pods stay live serving traffic.

The frontend Pod has its own `wait-for-backend` initContainer (polls backend
`/healthz`) so it doesn't open DB connections against an un-migrated schema.

The queries in the sections below run against kubeport's database. With the
embedded Postgres (the default):

```bash
kubectl -n kubeport exec -it kubeport-postgres-0 -- psql -U kubeport kubeport
```

The pod is `<release>-postgres-0`, or `<release>-kubeport-postgres-0` when the
release name does not contain `kubeport`. With `postgres.embedded=false`, point
your own `psql` at `postgres.externalUrl`.

### Behaviour changes when upgrading past #187 / #189

A ui-spec `pattern` is checked twice: by the API with Go's RE2 on deploy, and by
the deploy form in the browser, as a JavaScript RegExp, on every keystroke.
Saving now refuses the patterns those two cannot agree on, and the ones that
could freeze the browser:

- **Patterns in RE2-only syntax are refused on save** (400 `validation-error`
  naming the field and what to write instead). `(?i)` and `(?P<name>…)` do not
  compile in the browser, so the form used to drop the pattern without a word;
  `\A`, `\z`, `\pL`, `[[:alpha:]]` and `\x{41}` compile there with a different
  meaning. So does any character outside the Basic Multilingual Plane, such as
  an emoji: without the `u` flag the browser reads it as two halves. Common
  rewrites:

  | RE2-only | Write instead |
  |---|---|
  | `(?i)abc` | `[aA][bB][cC]` |
  | `(?P<name>…)` | `(?<name>…)` |
  | `\A` / `\z` | `^` / `$` |
  | `[[:alpha:]]`, `\pL` | `[a-zA-Z]` (list the characters) |
  | `\x{41}` | `\x41` |
  | `[😀]`, or an emoji anywhere | leave it out, or allow such characters with a negated class such as `[^\x00-\x7F]` |
  | `(a?){25}`, `(a*){3}` — a repeat of something that can be empty | `a{0,25}`, `a*` |

- **Patterns longer than 200 characters, and patterns that can match the same
  text in more than one way inside a repeat, are refused on save** — `(a+)+`,
  `(a|a)*`, `(a{1,20})+`, or three overlapping repeats in a row such as
  `^[a-z0-9]+[-a-z0-9]*[a-z0-9]+$`. Give each repetition a separator nothing
  else in it can match, at either end — `^[a-z]+(-[a-z]+)*$`,
  `^([a-z]+,)*[a-z]+$`, `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` — and start the pattern
  with `^`. A repeat of something that can match nothing, such as `(a?){25}`,
  is refused too. A count of two to four is read as that many copies unless it
  holds `*`, `+` or a count of five or more, so `^(\d{3}-?){2}\d{4}$` is accepted
  while `(a{1,20}){2}` and `(a|a){5}` are judged like `*`. Ways also multiply along the whole pattern, not only inside a
  repeat: a few two-way parts are fine (the common IPv4 pattern built from
  `[01]?[0-9][0-9]?` is accepted), but many are refused; write each part so it
  matches one way, as in `(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])`.
- **Published versions with such a pattern still deploy**, and the API still
  checks values against it, but the deploy form sets the pattern and its format
  hint aside, so a user hears about a mismatch only from the deploy's 400. The
  next version, and any PATCH to a draft, is refused until the pattern is
  rewritten.
- **Drafts saved before the upgrade can still be published unchanged**:
  publishing does not re-check the ui-spec. Open each draft in the editor — the
  preview names a refused pattern — and save it before publishing.

Find stored versions with RE2-only syntax before upgrading:

```sql
SELECT t.name, tv.version, tv.status
  FROM template_versions tv JOIN templates t ON t.id = tv.template_id
 WHERE tv.ui_spec_yaml ~ '(?n)^[ \t]*(-[ \t]+)?pattern:.*(\(\?[^:<]|\(\?<[0-9=!]|\\+([AzQpPa1-9]|x\{)|\[\^?\]|\[[^]]*\[:\^?[a-z]+:\]|\{([0-9]+,)?0[0-9]|(^|[^[])\^[*+?]|\$[*+?]|\\+[bB][*+?{]|[\U00010000-\U0010FFFF]|\\U000[1-9a-fA-F]|\\U0010|\\u[dD][89a-fA-F])';
```

The query reads `pattern:` lines, plain or quoted either way, so a spec written
in flow style or as JSON is not matched. It cannot find a pattern that repeats
ambiguously, one that is too long, or a group name used twice — the save checks
those — and a literal backslash before one of the letters it looks for shows up
as a false match. Open what it lists in the editor, or save it, to see the exact
reason.

### Behaviour changes when upgrading past #268

With `ingress.className=traefik` and `tls.enabled=true`, plain http now
redirects to https (301 for GET, 308 for other methods such as `curl -I`'s
HEAD) on the app host and the Dex host. The chart renders a Traefik
`Middleware` (`traefik.io/v1alpha1`) named `<release>-https-redirect` — or
`<release>-kubeport-https-redirect` when the release name does not contain
`kubeport`, the same rule as the Postgres pod above — and references it from
each Ingress that serves TLS, through
`traefik.ingress.kubernetes.io/router.middlewares`. Middlewares you already list
in that annotation are kept, after the redirect.

- **Before this, http served the whole app.** The HSTS header was sent, but a
  browser ignores HSTS it receives over http, so a first visit stayed on http —
  where the `Secure` auth cookies cannot be stored and login fails with
  `login_error=expired`.
- **Opt out** with `--set ingress.httpsRedirect=false` if:
  - something in front of the cluster **terminates TLS and forwards plain http**
    to Traefik — Cloudflare "Flexible" SSL, an L7 load balancer with an http
    backend. Traefik does not trust that proxy's `X-Forwarded-Proto` by default,
    so every request is redirected again and the site loops
    (`ERR_TOO_MANY_REDIRECTS`). Either opt out, or have the proxy talk https to
    the cluster;
  - something in front already redirects;
  - your Traefik predates the `traefik.io` CRDs (v2.10). The upgrade fails with
    `no matches for kind "Middleware"`.
- **Certificate renewal is unaffected.** cert-manager's HTTP-01 solver gets its
  own route, and Let's Encrypt follows a redirect to https without checking
  the certificate.

Verify after the upgrade:

```bash
# GET, not curl -I: Traefik answers a HEAD with 308 rather than 301
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://<host>/   # 301 https://<host>/
curl -s -o /dev/null -w '%{http_code}\n' https://<host>/                  # the usual answer, not 301/308
# Through whatever the browser really goes through: more than one hop is a loop
curl -sL --max-redirs 3 -o /dev/null -w '%{num_redirects}\n' http://<host>/   # 1
```

### Behaviour changes when upgrading past #143

The frontend now sends an enforced Content-Security-Policy, not only
`frame-ancestors 'none'`. Scripts, styles, fonts and connections from other
origins are blocked, except Monaco's pinned path on `cdn.jsdelivr.net` for the
YAML editor. If a proxy or Ingress in front injects its own scripts (analytics
beacons, bot challenges), upgrade with
`--set-string frontend.securityHeaders.cspMode=report-only`, open the app and
read the violations in the browser console, then either set
`frontend.securityHeaders.contentSecurityPolicy` or go back to `enforce`.
HSTS, nosniff, Referrer-Policy and `frame-ancestors 'none'` are unchanged. See
[Security headers](#security-headers).

### Behaviour changes when upgrading past #253

`dex.enabled=true` with `demo.enabled=false` no longer renders. A
`helm upgrade --reuse-values` of such a release stops at render with
`dex.enabled=true requires demo.enabled=true`, and the running release stays
on its previous revision. Check your release first:

```bash
helm get values kubeport -n kubeport --all | grep -A1 -E '^(dex|demo):'
```

Then add one of these to the upgrade command:

- **You do not use the demo login:** `--set dex.enabled=false`. The Dex
  Deployment, Service, Ingress and Certificate are removed, the backend stops
  accepting Dex-issued tokens, and the landing page drops the demo buttons. A
  `DEMO_OIDC_CLIENT_SECRET` key in an external Secret is no longer read.
- **You want the public demo:** `--set demo.enabled=true` plus the values in
  [Demo mode (Dex)](#demo-mode-dex): `demo.adminPassword`, `demo.userPassword`,
  and `demo.adminEmail`/`demo.userEmail` matching `dex.staticPasswords[].email`
  under `demo.emailDomain`. This also creates the `demo` namespace, its RBAC and
  the reset CronJob.
- **You used the chart's Dex as your own login IdP:** its accounts were never
  demo-scoped, and the landing page printed `demo.passwordHint` for them. Run
  Dex outside this chart and point `oidc.issuer` at it.

### Behaviour changes when upgrading past #161

kubeport now checks, before applying anything, whether a release's objects
already belong to something else. Upgrades change what used to happen silently:

- **A second release of a template with fixed object names, in the same
  namespace, is refused** (409 `resource-conflict`, naming the release holding
  them). It used to take the first release's objects over, and deleting it
  deleted them. Such templates allow one release per namespace for now (#190).
- **Objects kubeport did not create are no longer adopted.** If a template's
  objects already exist in the target namespace without a
  `kubeport.io/release` label, the first deploy is a 409 instead of a takeover.
  Delete or rename them, or deploy elsewhere.
- **Templates that pin `metadata.namespace`** to a namespace other than the
  release's can no longer be deployed or updated (400 `validation-error`, with
  `pinned_namespace` naming the object). They used to be applied there and left
  behind on delete. Find them before upgrading, then publish a version without
  `metadata.namespace`:

  ```sql
  SELECT t.name, tv.version
    FROM template_versions tv JOIN templates t ON t.id = tv.template_id
   WHERE tv.resources_yaml ~ '(?n)^\s+namespace:';
  ```

- **ui-spec fields at `metadata.namespace`, `metadata`, `kind` or `apiVersion`
  are refused on save.** Published versions still deploy; the next draft has to
  drop the field.
- **A release whose objects were already taken before #161** fails to update
  with a 409 naming the release that took them. Deleting that release deletes
  those objects too; update the affected release once more right after, and it
  recreates them.

### Behaviour changes when upgrading past #136

ui-spec fields are now checked the way the contract always described them:

- **A field type other than `string`, `integer`, `boolean`, `enum` or
  `autocomplete` is refused on save**, and so is a field without a type or with
  a blank label. A misspelled type (`int`, `str`) used to skip every check, so
  whatever a caller sent for it went into the manifest. Published versions with
  a blank label still deploy — the form falls back to the path's last key — but
  the next draft has to label every field. Saving reports one field at a time,
  so fix the type, label and path of every field before saving.
- **A published version with such a type cannot be deployed or updated** when
  that field gets a value — sent, or its `default`. The response is 400
  `validation-error` with `template_defect` naming the field, and the deploy
  form tells the user to ask an admin. A field with no value and no default is
  still skipped. Find these versions before upgrading, then publish one with a
  valid type:

  ```sql
  SELECT t.name, tv.version, tv.id
    FROM template_versions tv JOIN templates t ON t.id = tv.template_id
   WHERE tv.ui_spec_yaml ~ '(?n)^\s*(-\s+)?type:(?![ \t]*[''"]?(string|integer|boolean|enum|autocomplete)[''"]?([ \t]+#.*)?[ \t\r]*$)'
      OR (SELECT count(*) FROM regexp_matches(tv.ui_spec_yaml, '(?n)^[ \t]*(-[ \t]+)?path:', 'g'))
         <> (SELECT count(*) FROM regexp_matches(tv.ui_spec_yaml, '(?n)^[ \t]*(-[ \t]+)?type:', 'g'));
  ```

  The second condition finds a field with no `type:` line at all — the case
  most likely to surprise: if it has a `default`, it deployed before the upgrade
  (the form never showed it) and fails every deploy after. The query reads YAML
  line by line, so a spec written in flow style or as JSON is not matched; open
  anything you know was sent that way in the editor.

  Publishing a fixed version does not move existing releases, and a release
  cannot be updated while it stays on the broken version. Update each one to the
  fixed version (its values carry over). To list them, with the `id`s above:

  ```sql
  SELECT r.namespace, r.name AS release, t.name AS template, tv.version
    FROM releases r
    JOIN template_versions tv ON tv.id = r.template_version_id
    JOIN templates t ON t.id = tv.template_id
   WHERE tv.id IN (/* template_versions.id from the query above */);
  ```
- **`integer` fields take whole numbers only**, and `enum` values must be
  scalars. A release whose stored values have `2.5` for an integer field, or a
  list for an enum, fails to update until the value is corrected.

### Behaviour changes when upgrading past #195

A release's objects now carry its database id as a label,
`kubeport.io/release-uid`, next to `kubeport.io/release`. Ownership, delete and
status go by name **and** id, because a name alone was not an identity: a
deleted release frees its name while objects it could not delete still carry
it, and one apiserver registered under two cluster names lets two releases
share a name and namespace.

- **Existing releases keep working unchanged.** A release whose last applied
  YAML has no id counts objects without one as its own by name — for status,
  logs, update and delete — and gains the id the next time it is updated. After
  that, and for every release created after the upgrade, an object without the
  id is not the release's: it was left by an earlier release of that name.
- **The first update of an existing release rolls its pods once.** The id is
  added to pod template labels (never to `spec.selector`, which is immutable).
  A Job's pod template is immutable too, so a Job carries the id on itself only
  and its pods count through the Job that owns them. Deleting a release now
  deletes a Job's pods with it (background propagation) instead of orphaning
  them.
- **A new release no longer adopts objects left by a deleted release of the same
  name.** The create is a 409 `resource-conflict` whose conflicts carry
  `same_name: true`. Clean up the leftovers (`kubectl -n <ns> get all,cm,secret
  -l kubeport.io/release=<name>`) or deploy elsewhere.
- **A cluster whose `api_url` is already registered is refused** (409
  `conflict`, naming the existing cluster), comparing URLs with a trailing slash
  or default port removed. Duplicate registrations made before the upgrade are
  not removed: releases created after the upgrade are told apart by id, but
  objects from before it still match by name until their release is updated —
  so remove the extra registration once its releases are gone. To find them:

  ```sql
  SELECT lower(rtrim(api_url, '/')) AS api_url, array_agg(name) AS clusters
    FROM clusters GROUP BY 1 HAVING count(*) > 1;
  ```

## Uninstall

```bash
helm uninstall kubeport --namespace kubeport
# PVCs are NOT deleted by helm uninstall — clean them up manually if you
# want to discard data:
kubectl --namespace kubeport delete pvc -l app.kubernetes.io/instance=kubeport
```

## Values matrix

### Secret modes

| Mode | Set | Where |
|---|---|---|
| Chart-managed (dev / Phase 1) | `auth.create=true`, plus `auth.appEncryptionKeyB64` / `auth.oidcClientSecret` / `postgres.password` via `--set` | Chart writes a `<release>-auth` Secret with `DATABASE_URL`, `APP_ENCRYPTION_KEY_B64`, `OIDC_CLIENT_SECRET` — plus `DEMO_OIDC_CLIENT_SECRET` when `dex.enabled=true` |
| External (recommended for prod) | `auth.create=false`, `auth.existingSecret=<name>` | You provide a Secret named `<name>` with the same keys; e.g. via `sealed-secrets` or `external-secrets`, or by hand as in [Keeping secrets off the command line](#keeping-secrets-off-the-command-line) |

**With `dex.enabled=true`, the external Secret needs a fourth key:
`DEMO_OIDC_CLIENT_SECRET`, holding the same value as `dex.clientSecret`.**
Both Deployments read this Secret with `envFrom`, so a missing key is not an
error — it is an unset variable — and the demo-reset CronJob names it with
`secretKeyRef`, which fails only when the job first fires. The install, the
rollout and every probe stay green in between; what you see is a demo that
empties itself on schedule and never refills (#118, same symptom as #104).

`helm` cannot check this for you: the Secret is not part of the release, so
nothing can be validated at render time. Confirm it yourself before installing:

```bash
kubectl -n kubeport describe secret <name>
# lists key names and byte counts, never values
# expect: APP_ENCRYPTION_KEY_B64, DATABASE_URL, OIDC_CLIENT_SECRET
#         (+ DEMO_OIDC_CLIENT_SECRET when dex.enabled=true)
```

`describe` rather than `get -o jsonpath='{.data}' | ...`: the values never leave
kubectl at all, so there is no version of this command that is one truncation
away from printing your encryption key into a terminal or a CI log.

### Postgres modes

| Mode | Set | Notes |
|---|---|---|
| Embedded (single-node demo) | `postgres.embedded=true` (default) | StatefulSet + headless Service + PVC. Backups not handled by chart — see ADR 0003 §"Phase 2" |
| External | `postgres.embedded=false`, `postgres.externalUrl=postgres://...` | Use a managed PG (Cloud SQL, RDS) for prod. `externalUrl` is read at chart-render time and baked into the auth Secret unless `auth.create=false` (in which case provide it in your external Secret) |

### Cloud-specific values (Ingress + StorageClass)

| Cluster | `ingress.className` | `postgres.storage.storageClassName` |
|---|---|---|
| k3s (Phase 1/2/3) | `traefik` | `local-path` |
| GKE | `gce` | `standard-rwo` |
| EKS | `alb` (with [ALB controller](https://github.com/kubernetes-sigs/aws-load-balancer-controller)) | `gp3` |
| AKS | `azure-application-gateway` | `default` |
| nginx-ingress (any) | `nginx` | varies |
| kind / minikube (CI smoke) | `nginx` (or disable) | `standard` |

kubeport accepts request bodies up to 4 MiB and answers anything larger with a
JSON `413 payload-too-large`. An Ingress controller with a lower default limit
answers first with its own non-JSON 413. ingress-nginx defaults to 1m — set
`ingress.annotations."nginx.ingress.kubernetes.io/proxy-body-size": "4m"`.
Traefik (k3s) has no default limit.

http → https: with `traefik` and `tls.enabled=true` the chart redirects http
itself (`ingress.httpsRedirect`, default true; see "upgrading past #268"). Other
classes need their controller's own switch, and without it http serves the whole
app. Anything below goes in `ingress.annotations`, which the Dex Ingress shares:

- **nginx-ingress:** nothing to set — it redirects (308) whenever the Ingress
  has TLS.
- **GKE (`gce`):** create a `FrontendConfig` (`apiVersion:
  networking.gke.io/v1beta1`, `spec.redirectToHttps.enabled: true`) in the
  release namespace and set
  `ingress.annotations."networking.gke.io/v1beta1.FrontendConfig"=<its name>`.
- **EKS (`alb`):** `alb.ingress.kubernetes.io/listen-ports: '[{"HTTP": 80},
  {"HTTPS": 443}]'` and `alb.ingress.kubernetes.io/ssl-redirect: '443'`.
- **AKS (`azure-application-gateway`):**
  `appgw.ingress.kubernetes.io/ssl-redirect: "true"` — it defaults to false.

### Backend tuning (optional)

Every one of these may be left empty; the backend then uses the default shown.

| Value | Default | What it does |
|---|---|---|
| `backend.openapiCacheMax` | `64` | Cluster OpenAPI documents kept in memory. |
| `backend.sessionReapInterval` | `""` (1h) | How often expired sessions are deleted (Go duration; under 1m is clamped to 1m). |
| `backend.logStreamsPerCaller` | `""` (16) | Log streams one caller may hold open at once; the next one gets `429 too-many-streams`. Empty, 0, negative or non-integer all mean the default — there is no "unlimited". |
| `backend.logStreamMaxLifetime` | `""` (1h) | How long one log stream stays open before the browser reconnects and is authorized again (Go duration). Also the longest a revoked permission keeps receiving logs. |

**Demo installs:** the Dex demo accounts are shared by every visitor, so
`backend.logStreamsPerCaller` is effectively how many log panes can be open at
once per demo account. The web UI closes a pane's stream after its tab has been
hidden for five minutes. Raise the value if visitors report "Too many log panes
are open".

**Per-caller request budgets are fixed in code, not values.** Each is a token
bucket keyed by OIDC subject: reading a release (`GET /v1/releases/{id}`)
240/min; creating, updating and deleting a release share 30/min
([#232](https://github.com/shyuni4u/kubeport/issues/232)); SSAR, cluster
OpenAPI reads and opening a log stream share 60/min; template preview 120/min;
template saves 60/min. A release detail
page reads twice per render and re-renders every 3–15s while a rollout settles,
so 240/min covers well over a dozen such tabs per identity. On a demo install
every visitor of one Dex account shares that identity: when the budget runs out,
release pages show the error screen and the backend answers `429 rate-limited`
with `X-RateLimit-Limit: 240`. When the write budget runs out instead, the
deploy form shows a generic failure and delete says it could not delete; the
backend answers `429 rate-limited` with `X-RateLimit-Limit: 30` on
`POST /v1/releases` or `PUT`/`DELETE /v1/releases/{id}`, and it works again
within seconds. A write refused before it reaches the cluster (a bad body, a
release that is not yours) does not spend that budget, and the demo reset's
seeder — which runs as the demo user — waits out a 429 rather than failing.
Changing a budget needs a code change (`backend/internal/api/routes.go`).

### Security headers

The frontend sets these at request time, from `frontend.securityHeaders`
(#80, #143), on every response the app produces — pages, `/_next/static`, the
`/api` BFF, 404s and its own login redirect. They are not baked into the image,
so each install can change them. Two kinds of response are answered by Next
before the app and carry none: its internal trailing-slash 308 (e.g.
`/catalog/` → `/catalog`), and its automatic 405 for a method an `/api` route
does not define when the request has a body (such requests skip the proxy, so
that uploads are not buffered before the BFF's own checks). Neither has an HTML
body, and a browser has already received HSTS from any page by then.

| Value | Default | What it does |
|---|---|---|
| `frontend.securityHeaders.enabled` | `true` | `false` sends none of them. For a proxy in front that sets its own. |
| `frontend.securityHeaders.hsts` | `max-age=63072000; includeSubDomains` | `Strict-Transport-Security`. Empty sends no HSTS. |
| `frontend.securityHeaders.frameAncestors` | `"'none'"` | CSP `frame-ancestors` sources. |
| `frontend.securityHeaders.cspMode` | `"enforce"` | `"enforce"`, `"report-only"` (the policy goes out as `Content-Security-Policy-Report-Only`; `frame-ancestors` still enforces) or `"off"` (only `frame-ancestors`). Quote it in a values file — YAML reads a bare `off` as `false`, and the chart refuses anything but these three. |
| `frontend.securityHeaders.contentSecurityPolicy` | `""` | A whole policy replacing the default. Any `frame-ancestors` in it is dropped and `frameAncestors` appended. |

`X-Content-Type-Options: nosniff` and `Referrer-Policy:
strict-origin-when-cross-origin` are always sent while `enabled` is true.
Whitespace and line breaks inside a value are folded into single spaces, so a
long policy can be written as a YAML block.

The default policy allows scripts, styles, fonts, images, workers, form posts
and connections from the app's own origin only, plus Monaco's pinned path,
`https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/` — the YAML editor loads
from there. Inline scripts and styles are still allowed (Next.js needs them
without nonces). `object-src 'none'` and `base-uri 'self'` close the rest. The
exact string is in `frontend/lib/security-headers.ts`.

**CSP keywords keep their single quotes inside the value.** In a values file
write `frameAncestors: "'self' https://portal.example.com"`; on the command
line `--set-string "frontend.securityHeaders.frameAncestors='self' https://portal.example.com"`.
A bare `self` or `none` is read as a host name, not a keyword.

When to change them:

- **A proxy in front already sends HSTS** — set `hsts=""` so the browser does
  not see two, or `enabled=false` if it sends the whole set.
- **Installed on an apex domain with sibling http services** — drop
  `includeSubDomains` (`hsts="max-age=63072000"`). With it, visitors' browsers
  force those siblings onto https for two years, and you cannot undo that.
- **Embedding kubeport in a portal iframe** — list the portal's origin:
  `--set-string "frontend.securityHeaders.frameAncestors=https://portal.example.com"`.
- **A self-hosted editor, analytics or another CDN is blocked** — roll out with
  `cspMode=report-only`, read the reports in the browser console, then set
  `contentSecurityPolicy` to a policy that allows it and go back to `enforce`.

## Schema sync

The chart embeds a copy of `backend/migrations/schema.hcl` at
`deploy/helm/kubeport/files/schema.hcl`. They MUST stay in sync — the CI
workflow `.github/workflows/helm.yml` fails if they diverge.

After editing the source schema:

```bash
make helm-sync
```

Then run `make helm-snapshot-update` to refresh the golden snapshot used
by CI:

```bash
make helm-snapshot-update
git add backend/migrations/schema.hcl deploy/helm/kubeport/files/schema.hcl deploy/helm/kubeport/ci/snapshot.yaml
git commit -m "..."
```

`make helm-snapshot` (without `-update`) only diffs against the existing
snapshot — that's what CI runs; non-zero exit signals an unintended
template change.

## Demo mode (Dex)

Optional self-hosted [Dex](https://dexidp.io/) IdP for a public demo login,
in addition to the primary `oidc.*` IdP (e.g. Google). The backend accepts
tokens from both issuers via `KBP_OIDC_ISSUERS`.

Enable with:

```yaml
dex:
  enabled: true
  host: dex.example.com          # required — needs its own DNS A record
  clientSecret: <random>          # --set-file dex.clientSecret=<file> — see "Keeping secrets off the command line"
  staticPasswords:
    - email: demo-admin@demo.kubeport
      username: demo-admin
      userID: demo-admin-000
      hash: <bcrypt hash>
    - email: demo-user@demo.kubeport
      username: demo-user
      userID: demo-user-000
      hash: <bcrypt hash>

demo:
  enabled: true
  emailDomain: demo.kubeport      # accounts under it are demo accounts to the backend
  adminEmail: demo-admin@demo.kubeport  # one of dex.staticPasswords[].email
  userEmail: demo-user@demo.kubeport    # one of dex.staticPasswords[].email
  adminPassword: <random>         # --set; used by the reset CronJob only
  userPassword: <random>          # --set
  passwordHint: ""                # shown on the landing page — public by design
```

Changing a demo account's email is two edits, not one: `dex.staticPasswords[].email`
is the account Dex accepts, and `demo.adminEmail`/`demo.userEmail` are what the
landing page tells visitors to type, the RBAC subjects, and the reset Job's
logins. Both must sit under `demo.emailDomain`. An account outside it is not a
demo account to the backend: it skips demo scoping while the landing page prints
its password, and `demo.adminEmail` is also appended to `KBP_DEV_ADMIN_EMAILS`,
which makes it a full `kubeport-admin`. The chart refuses to
render when `demo.adminEmail` or `demo.userEmail` is outside the domain or
matches no Dex account (#208, #209).

Generate a static-password bcrypt hash:

```bash
htpasswd -bnBC 10 "" '<password>' | tr -d ':\n'
```

`demo.enabled=true` also creates:

- A `demo` namespace (name from `demo.namespace`) with a `ResourceQuota`,
  `LimitRange`, an egress-only `NetworkPolicy` (DNS + outbound, no
  in-cluster lateral traffic, no LoadBalancer Services, no Ingresses), and
  Pod Security Admission labels — `enforce: {{ demo.podSecurityEnforce }}`
  (default `baseline`), `warn`/`audit: restricted`. `baseline` is the default
  because `restricted` would reject ordinary user templates that do not set
  `runAsNonRoot`/`seccompProfile`; raise it with
  `--set demo.podSecurityEnforce=restricted` for a stricter demo.
- `demo-admin`/`demo-user` `Role`s + `RoleBinding`s scoped to that namespace,
  plus a cluster-scoped `ClusterRole`/`ClusterRoleBinding` granting
  `selfsubjectaccessreviews` (create) — the RBAC panel needs this even for
  non-admin demo users.
- A `demo-reset` `CronJob` (`demo.resetSchedule`, default daily at 21:00 UTC,
  read in `demo.resetTimeZone`) that
  wipes all objects in the demo namespace and re-seeds it via
  `/seed-demo --reset` (shipped in the backend image).
  The demo banner derives its "next reset" from the same value; it understands
  `<minute> <hour|*/N|list> * * *` only and omits the time for any other form.
  `demo.resetTimeZone` only sets the zone the CronJob reads its schedule in.
  It does not change the zone the UI shows times in. Every time the UI shows
  (relative-time tooltips, the demo banner, log line times) is rendered in
  `Asia/Seoul`, and absolute times are labelled with its offset (`UTC+9`). That
  zone is the `TIME_ZONE` constant in `frontend/i18n/request.ts`, not a chart
  value. To show another zone, change it and build your own frontend image.
- The deploy form starts demo sessions in `demo.namespace` (passed to the
  frontend as `DEMO_NAMESPACE`), not in the cluster's `default_namespace`.
  Changing `demo.namespace` moves the namespace, its RBAC, the reset job and
  the form's starting namespace together.
- Demo accounts get the `kubeport-admin` UX, but the backend refuses them with
  403 `demo-restricted` on cluster registration, OpenAPI refresh, team and
  member changes, force-delete, and any release no demo account owns — the UI
  says so on those screens. A template no demo account owns is not a 403:
  reading, changing or deploying it answers 404, as if it did not exist, and
  the line holds the other way too: to a real user who is not an admin a demo
  template does not exist either. A real operator
  (admin, not demo) still can — and that release keeps the demo reset from
  deleting the demo catalog until it is removed. Releases a non-admin created
  from a demo template before this check existed block it the same way. When
  that happens the reset Job still succeeds, but its `seed` container logs
  `WARN: reset: … skipped — referenced by non-demo releases`; delete that
  release (from its detail page or `DELETE /v1/releases/:id`) and the next
  reset clears the demo catalog again — re-running the reset before that
  changes nothing. Creating *new* templates and publishing, deprecating or
  undeprecating versions are also
  refused unless you set `demo.allowTemplateCreate=true`
  (`KBP_DEMO_ALLOW_TEMPLATE_CREATE`); leave it off for a public demo, since
  templates demo visitors author outlive a reset once someone deploys from
  them, and a version a visitor publishes can read other visitors' Secrets
  through pod logs (#294). Drafts stay open. The reset CronJob does not need it.
- `demo.publicHealthCatalog=true` (off by default) makes the unauthenticated
  `/healthz?verbose=1` report `catalog.templates` (demo-owned published
  templates) and `catalog.last_seed` (UTC, the oldest of their `created_at`).
  Alert when `templates` is 0 (a reset wiped and failed to re-seed) or
  `last_seed` is older than your `demo.resetSchedule` interval plus about 2h
  (a reset did not run, or skipped the catalog because a non-demo release
  references a demo template). Leave it off unless the install is a public
  demo — it tells anyone the catalog's size.

Both demo `Role`s enumerate workload resources explicitly — neither can touch
the guardrails (`resourcequotas`, `limitranges`, `networkpolicies`) or use
`pods/exec`. Verify after install:

```bash
kubectl auth can-i delete resourcequota --as=dex:demo-admin@demo.kubeport -n demo   # → no
```

`demo.enabled=true` requires `dex.enabled=true` (the chart fails the render
otherwise) — the demo RBAC subjects are Dex-issued usernames.

The reverse holds too: `dex.enabled=true` requires `demo.enabled=true`. The
chart's Dex is the demo login, and the backend trusts its tokens whenever it is
on, but demo scoping is switched on only by `demo.enabled` — so Dex without demo
mode would be a login whose password the landing page prints, for accounts that
are ordinary users (#253).

`dex.enabled=true` renders a `ClusterIP` Service + Deployment for Dex, plus
an `Ingress`/`Certificate` on `dex.host` (mirrors the main chart's
`ingress.className` / `tls.certManager.*`).

**k3s must trust the Dex issuer** for the RBAC bindings above to resolve —
see [`deploy/oci/README.md` §7.6](../../oci/README.md#76-demo-idp-dex-신뢰-추가). `dex.host` needs
its own DNS record pointing at the cluster ingress, separate from the main
`host`.

## Templates

| Template | When rendered |
|---|---|
| `backend-{deployment,service,configmap}.yaml` | always |
| `frontend-{deployment,service,configmap}.yaml` | always |
| `secret.yaml` | `auth.create=true` |
| `dex-{configmap,secret,deployment,service,ingress,certificate}.yaml` | `dex.enabled=true`, which requires `demo.enabled=true` — the render fails otherwise (#253). Certificate also requires `tls.enabled` + `tls.certManager.enabled` |
| `demo-namespace.yaml`, `demo-rbac.yaml`, `demo-reset-cronjob.yaml` | `demo.enabled=true`, which requires `dex.enabled=true` |
| `postgres-{statefulset,service,secret}.yaml` | `postgres.embedded=true` |
| `ingress.yaml` | `ingress.enabled=true` |
| `https-redirect-middleware.yaml` (Traefik `Middleware`, http → https) | `ingress.httpsRedirect=true` (default) AND `ingress.className=traefik` AND `tls.enabled=true`, AND an Ingress that serves TLS — `ingress.enabled` with cert-manager or `tls.existingSecret`, or `dex.enabled` with cert-manager. Each such Ingress references it (#268) |
| `certificate.yaml` | `tls.enabled=true` AND `tls.certManager.enabled=true` |
| `migration-configmap.yaml` (schema.hcl + atlas.hcl) | `migration.enabled=true` (default true) — mounted by the backend Pod's `migrate` initContainer |

## Local validation

```bash
# Render the default values:
helm template kubeport deploy/helm/kubeport \
  --set oidc.issuer=https://accounts.google.com \
  --set oidc.clientId=local-test \
  --set auth.appEncryptionKeyB64=$(openssl rand -base64 32) \
  --set auth.oidcClientSecret=test \
  --set postgres.password=test

# Lint with the CI fixture values:
make helm-lint

# Diff against the golden snapshot (this is what CI runs):
make helm-snapshot
```

`make helm-snapshot` is version-sensitive: CI pins Helm **v3.20.2**
(`.github/workflows/helm.yml`), and Helm 4 renders an extra blank line before
each `---` separator. On Helm 4 the diff is all-blank-line noise even with an
unmodified chart — that is a local toolchain mismatch, not template drift. Match
the pinned version before trusting the result, and never run
`helm-snapshot-update` to "fix" it.

For a real install on a kind cluster, follow the kind-smoke job in
`.github/workflows/helm.yml` — same flow, same `ci/smoke-values.yaml`.

## See also

- [Plan 9 — Helm chart MVP](../../../docs/superpowers/plans/2026-04-29-plan9-helm-chart.md)
- [ADR 0001](../../../docs/decisions/0001-frontend-deployment-helm-over-vercel.md) — frontend in same Helm chart as backend
- [ADR 0003](../../../docs/decisions/0003-hosting-oci-always-free.md) — 3-Phase hosting decision tree
- [docs/deploy/images.md](../../../docs/deploy/images.md) — multi-arch image build pipeline
