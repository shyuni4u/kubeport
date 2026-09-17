import { execFileSync } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { Pool } from "pg";

// This harness is deliberately local-only. It never uses the current kubectl
// context, stops a node, or changes the shared kind registration/RBAC.
export function recoveryHarness(baseURL: string) {
  const web = new URL(baseURL);
  if (web.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(web.hostname)) {
    throw new Error("Recovery E2E requires a local HTTP application");
  }
  const dbURL = process.env.KBP_E2E_DATABASE_URL ?? "postgres://kubeport:kubeport@localhost:5432/kubeport";
  const db = new URL(dbURL);
  if (!["localhost", "127.0.0.1"].includes(db.hostname) || db.pathname !== "/kubeport") {
    throw new Error("Recovery E2E requires the local kubeport database");
  }
  const kube = (...args: string[]) => execFileSync("kubectl", [
    "--context", "kind-kubeport", "--request-timeout=15s", ...args,
  ], { encoding: "utf8", timeout: 25_000, stdio: ["pipe", "pipe", "pipe"] });
  const config = JSON.parse(kube("config", "view", "--raw", "--minify", "--flatten", "-o", "json"));
  const cluster = config.clusters[0].cluster;
  const target = new URL(cluster.server);
  if (target.protocol !== "https:" || !["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("kind-kubeport must point to a local HTTPS API");
  }
  const namespace = `e2e-recovery-${Date.now().toString(36)}-${process.pid}`;
  const sockets = new Set<Socket>();
  let disconnected = false;
  const proxy = createServer((client) => {
    if (disconnected) { client.destroy(); return; }
    const upstream = connect(Number(target.port || 443), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => { client.destroy(); upstream.destroy(); });
    }
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  const pool = new Pool({ connectionString: dbURL, connectionTimeoutMillis: 5_000 });
  let clusterID: string | undefined;
  let namespaceCreated = false;

  function apply(object: unknown) {
    execFileSync("kubectl", ["--context", "kind-kubeport", "--request-timeout=15s", "apply", "-f", "-"], {
      input: JSON.stringify(object), encoding: "utf8", timeout: 25_000, stdio: ["pipe", "pipe", "pipe"],
    });
  }
  function logPermission(allowed: boolean) {
    apply({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: { name: "release-user", namespace }, rules: [
      { apiGroups: [""], resources: ["pods", "services", "configmaps", ...(allowed ? ["pods/log"] : [])], verbs: ["get", "list", "watch", "create", "patch", "update", "delete"] },
      { apiGroups: ["apps"], resources: ["deployments", "replicasets"], verbs: ["get", "list", "watch", "create", "patch", "update", "delete"] },
    ] });
  }

  return {
    namespace, kube, logPermission,
    async start() {
      // Verify the DB before creating anything; cleanup needs it because there
      // is intentionally no public cluster-delete endpoint.
      await pool.query("SELECT 1");
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("No proxy port");
      kube("create", "namespace", namespace);
      namespaceCreated = true;
      logPermission(true);
      apply({ apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: { name: "release-user", namespace },
        subjects: [{ kind: "User", name: "demo-user@demo.kubeport", apiGroup: "rbac.authorization.k8s.io" }],
        roleRef: { kind: "Role", name: "release-user", apiGroup: "rbac.authorization.k8s.io" } });
      kube("create", "rolebinding", "release-admin", "--clusterrole=admin", "--user=admin@example.com", "-n", namespace);
      return {
        name: namespace, api_url: `https://127.0.0.1:${address.port}`,
        ca_bundle: Buffer.from(cluster["certificate-authority-data"], "base64").toString(),
        oidc_issuer_url: "https://host.docker.internal:5556", default_namespace: namespace,
      };
    },
    registered(id: string) { clusterID = id; },
    disconnect() { disconnected = true; for (const socket of sockets) socket.destroy(); },
    reconnect() { disconnected = false; },
    async close() {
      // Attempt every cleanup even when an earlier one fails. Restrict DB
      // deletion to the exact test-created cluster id AND unique name.
      const errors: unknown[] = [];
      if (namespaceCreated) {
        try { kube("delete", "namespace", namespace, "--wait=false", "--ignore-not-found"); } catch (e) { errors.push(e); }
      }
      try {
        if (clusterID) {
          const remaining = await pool.query("SELECT id FROM releases WHERE cluster_id = $1", [clusterID]);
          if (remaining.rowCount) throw new Error("Test release cleanup failed; refusing to remove its cluster registration");
          await pool.query("DELETE FROM clusters WHERE id = $1 AND name = $2", [clusterID, namespace]);
        }
      } catch (e) { errors.push(e); }
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await pool.end();
      if (errors.length) throw new AggregateError(errors, "Recovery harness cleanup failed");
    },
  };
}
