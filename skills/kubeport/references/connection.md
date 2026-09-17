# Connecting to an installation

Requires Node.js 22+ and network access from the agent's execution environment to
the installation. This package does not connect through kubeport.enzo.kr, open a
port-forward, install an MCP server, or send telemetry. Private installations can
stay private; run the agent on their network/VPN.

The target must include kubeport's `/cli`, `/api/auth/cli-token`, and
`/api/cli/v1/*` routes. Older versions need an upgrade. No additional database
migration, OAuth client, or IdP callback registration is required. The existing
installation must have working browser OIDC login and `PUBLIC_ORIGIN` or
`OIDC_REDIRECT_URI` configured. HTTPS is required except for loopback development.

## Interactive login

```sh
node /path/to/kubeport/scripts/kubeport.mjs login --url https://kubeport.example.org
```

The command prints the local installation's `/cli` link. Open it, check the
account in the user menu, create a token and paste it at the terminal prompt.
Input is hidden. Noninteractive stdin is accepted for secret-manager integration;
do not put literal tokens in shell history or source files.

Credentials live in `~/.kubeport/credentials.json`. The helper creates a private
directory/file (0700/0600 on POSIX); on Windows it inherits the user's home ACL.
Use a private user profile and do not relocate the file into a shared/synced repo.
`KUBEPORT_CONFIG` selects another private file, useful for isolated agent sessions
or multiple installations. A login replaces the selected file's previous account.

For an already provisioned execution environment, set `KUBEPORT_URL` and
`KUBEPORT_TOKEN` through its secret settings. An environment token overrides the
stored credential; its URL must name that token's installation. Run `whoami` to
verify the identity. Do not print the environment or credential file to the agent.

## Lifetime and revocation

The token is an encrypted reference to the current browser session, bound to the
installation origin and valid for at most one hour. It grants the same rights
as that session, including writes; it is not a read-only key. The server loads
the session and refreshes its OIDC token as needed before invoking the existing
Go API. Kubernetes still receives the user's OIDC token and enforces its RBAC.

The browser session may expire sooner (especially demo sessions), or the IdP may
require another sign-in. A 401 requires a new login/token. This first version is
for interactive agent work, not unattended CI or permanent service identities.

Browser logout revokes every CLI token tied to **that session**. Signing out of
another browser/session does not. `logout` deletes only the helper's local file;
it does not revoke an environment token or any other copy. A new token does not
invalidate an older one. Encryption-key rotation invalidates all such tokens.

## Additional commands

```sh
node /path/to/kubeport/scripts/kubeport.mjs api GET '/v1/templates?status=published'
node /path/to/kubeport/scripts/kubeport.mjs api GET '/v1/releases?cluster=dev&limit=20&offset=0'
node /path/to/kubeport/scripts/kubeport.mjs api GET '/v1/templates/web/versions'
```

The API prefix in this command stays `/v1/`; the helper maps it to
`/api/cli/v1/`. It rejects external URLs, path traversal and redirects. It never
forwards a connection token to Kubernetes or to the cookie-only `/api/v1` route.
