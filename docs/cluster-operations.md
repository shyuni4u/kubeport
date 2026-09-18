# Cluster operations

The signed-in home is a 30-second release dashboard. It shows kubeport releases
within the existing visibility rules (all accessible releases for app admins,
own releases for users, demo-owned releases for demo admins). Counts and filters
cover the current 20-row page. Failed reads stay distinguishable from healthy
resources. `/help` keeps the product introduction available.

## Connections and identity

`/clusters` provides registration, connection settings and a caller-specific
access check. Only non-demo app admins can read or update endpoint/CA/issuer
settings. The endpoint and cluster name are immutable after registration;
changing them would silently retarget existing releases. CA, display name,
default namespace and issuer metadata can be updated with optimistic concurrency.
The issuer field documents the connection; it does not configure the remote API
server or add a trusted login provider to kubeport.

Existing Kubernetes on bare metal or EC2 can be connected if the backend can
reach its API, validate its CA and forward an OIDC ID token the API trusts
(issuer, audience and claim mappings). Kubernetes RBAC remains authoritative.
There is no VM provisioning or Kubernetes installation workflow.

EKS offers [external OIDC user authentication](https://docs.aws.amazon.com/eks/latest/userguide/authenticate-oidc-identity-provider.html).
Configure the same user identity provider/audience and matching RBAC there.
AWS IAM token generation and kubeconfig `exec` plugins are not implemented.
An IRSA issuer is not a user login provider. Live EKS compatibility has **not**
been validated; the tested production environment is k3s.

An **app admin** can manage templates, teams and cluster connection records.
A **cluster operator** is a user granted the corresponding Kubernetes rights;
being an app admin does not grant those rights. Node changes and publishing
foundations require both app admin and Kubernetes permissions. Namespaced app,
PVC and route creation uses the caller's own rights. Public demo accounts are
denied all new infrastructure endpoints, including reads of shared topology.

## Nodes

`/nodes` shows readiness, scheduling state, pods, allocatable CPU/memory,
requests/limits, PDBs, taints and placement constraints. Actual usage is a
separate `metrics.k8s.io` section and remains unavailable if metrics-server or
permission is missing. Lists are capped at 500 objects, with explicit partial
result warnings. Allocation totals include init peaks, restartable init
sidecars and Pod overhead; they are planning estimates, not scheduler verdicts
(in-place resize, extended resources and topology require further inspection).
Absent limits are not a guarantee of bounded consumption.

Cordon/uncordon use a resource-version precondition. The assisted drain flow is
cordon → inspect remaining capacity and constraints → request individual Pod
evictions → watch termination and replacement state. It is not an unattended
bulk drain. Evictions use `policy/v1`, honor PDBs and carry the Pod UID as a
delete precondition. Mirror Pods, DaemonSets, unmanaged Pods, emptyDir and
hostPath are refused. No force-delete fallback is available. See the
[Kubernetes drain guide](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/).
Kubernetes audit and backend operation logs record actor, target and outcome.

## Storage

`/storage` shows StorageClasses, PVs, namespace PVCs, Deployments and warning
events. A cluster operator prepares the actual storage provisioner and static
PVs. The UI offers dynamic RWO filesystem PVC creation and single-replica
Deployment creation using an existing PVC. Directly created apps are shown in
the Deployment list, not in the template Release list. They use Recreate,
non-root security, no service-account token mount, and CPU 100m/1 plus memory
128Mi/512Mi requests/limits. The image and volume permissions must support this.

An existing single-replica Deployment can attach an unused filesystem PVC to a
named container. This restarts it with Recreate and may hide existing image
files under the mount path. A kubeport-managed release must instead expose the
PVC reference in its template, so a later release update cannot erase the mount.
Pending claims are accepted only for WaitForFirstConsumer classes. Block-mode,
deleting and currently referenced volumes are refused. Namespace lists must be
complete and readable to check reuse. External writers can still race these
checks; Kubernetes admission/storage enforcement remains necessary.

PVCs receive no Deployment owner reference and are never deleted by these
operations. A later manual PVC deletion follows the PV reclaim policy, which
can delete underlying data. Arbitrary PV/provisioner creation, RWX/block-mode
forms and volume migration are outside this initial flow.

## Foundations and routing

Non-demo admins with class `patch` permission publish one namespace offering
on an existing StorageClass or IngressClass via the annotation
`kubeport.io/self-service`:

```json
{"namespace":"team-a","max_gi":10}
```

```json
{"namespace":"team-a","domain":"apps.example.org","tls_secret":"apps-tls"}
```

Publishing replaces that class's previous offering. An administrator can revoke
it by sending `foundation: null` to the same publish operation or removing the
annotation with Kubernetes tools. The annotation governs kubeport convenience
forms, not arbitrary Kubernetes clients or template releases; use Admission
and RBAC for a cluster-wide policy.

`/network` initially supports Kubernetes Ingress, not Istio VirtualService or
Gateway API. An operator installs/configures the controller and IngressClass,
DNS and (optionally) a TLS Secret in the offered namespace. Users choose that
class and a local TCP Service port. The backend checks domain boundaries,
namespace and existing overlapping hosts. The global Ingress list must be
readable and complete for conflict checking; other writers still need admission
policy to guarantee host uniqueness. An assigned load-balancer address is not
proof that DNS, TLS, endpoints or HTTP responses are ready. The list shows host
URLs and warning events for follow-up.

## Required Kubernetes access

All access uses the login token, never the backend service account:

- Diagnostics: create `selfsubjectaccessreviews.authorization.k8s.io`.
- Nodes: list nodes, pods and `poddisruptionbudgets.policy`; optional node metrics.
  Cordon needs node patch; eviction needs get node/pod and create `pods/eviction`.
- Storage: list/get StorageClasses, PVCs, PVs and namespace Deployments/events.
  Creating needs PVC or Deployment create; attachment needs Deployment update.
  Reuse checks additionally need namespace Pod/Deployment/StatefulSet list.
- Routing: list/get IngressClasses and namespace Services/Ingresses/events;
  global Ingress list for host conflict checking; namespace Ingress create.
- Publishing: patch the selected StorageClass or IngressClass.

Grant only the namespace and operations each identity should have. Do not grant
`cluster-admin` simply to make every section green. A denied optional section
does not hide other successful sections. Convenience writes are serialized per
registered API URL across kubeport replicas; Kubernetes RBAC and admission
remain the final authority.

API contracts: `backend/api/openapi.yaml`, `/v1/clusters/{name}/settings`,
`/diagnostics`, `/operations`. POST success means accepted, not rollout complete.
