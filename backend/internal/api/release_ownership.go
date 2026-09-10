package api

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"k8s.io/apimachinery/pkg/util/validation"

	"kubeport/internal/k8s"
)

// maxConflictsNamed caps how many conflicting objects a 409 spells out. A
// template renders a handful of objects; this only bounds the message.
const maxConflictsNamed = 5

// releaseTargetProblem checks the namespace and name a release is created with
// against what Kubernetes will accept, before either is stored or sent
// anywhere. It returns "" when both are usable.
//
// The namespace was bound only as `required` (#125), so anything, newlines
// included, was stored, logged and sent to the apiserver to be refused there.
// A namespace is a DNS-1123 label, so every namespace that can exist passes.
//
// The name was bound as an RFC 1123 hostname, which runs to 253 characters.
// It is also written as the kubeport.io/release label value, and a label value
// stops at 63, so a longer name was stored and then refused by the apiserver
// on apply and rolled back as a 502: a cluster error for a typing mistake.
//
// Neither message repeats the value; it can be arbitrarily long.
func releaseTargetProblem(namespace, name string) string {
	if errs := validation.IsDNS1123Label(namespace); len(errs) > 0 {
		return "namespace is not a valid Kubernetes namespace: " + strings.Join(errs, "; ")
	}
	if errs := validation.IsValidLabelValue(name); len(errs) > 0 {
		return "name cannot be used as a release name, because it becomes a label value: " + strings.Join(errs, "; ")
	}
	return ""
}

// checkOwnership asks the cluster whether rendered can be applied as release
// without taking anything over, and answers the request itself when it
// cannot. It reports whether the caller should go on to apply.
func (h *Handlers) checkOwnership(c *gin.Context, cli K8sApplier, op string, ref k8s.ReleaseRef, rendered []byte) bool {
	namespace, release := ref.Namespace, ref.Name
	// An existing release cannot move namespace, so advice that suits a create
	// ("deploy elsewhere") is impossible on an update; and only a create can
	// probe objects the caller may not read (see k8s.CheckApply).
	update := op == "UpdateRelease"
	check, err := cli.CheckApply(c.Request.Context(), ref, rendered, !update)
	var mismatch *k8s.NamespaceMismatchError
	switch {
	case errors.As(err, &mismatch):
		// The template is what is wrong, not the cluster and not the caller's
		// input (#137). Logged because writeError does not log and the access
		// log keeps only the status, so without this the admin who can fix the
		// template never learns why a user's deploys keep failing.
		log.Printf("template pins a foreign namespace id=%s op=%s ns=%q release=%q object=%q pinned=%q",
			requestIDFrom(c), op, namespace, release, mismatch.Object.String(), mismatch.Object.Namespace)
		writeError(c, http.StatusBadRequest, "validation-error", mismatchDetail(mismatch, update),
			withPinnedNamespace(mismatch.Object))
		return false
	case err != nil:
		upstreamError(c, op+": ownership check", err)
		return false
	}
	if len(check.Unverified) > 0 {
		refs := make([]string, len(check.Unverified))
		for i, ref := range check.Unverified {
			refs[i] = ref.String()
		}
		log.Printf("ownership unverified id=%s op=%s ns=%q release=%q objects=%q (caller may write them but not read them)",
			requestIDFrom(c), op, namespace, release, strings.Join(refs, ", "))
	}
	if len(check.Conflicts) > 0 {
		writeError(c, http.StatusConflict, "resource-conflict", conflictDetail(check.Conflicts, update),
			withConflicts(check.Conflicts))
		return false
	}
	return true
}

// mismatchDetail says what to change. NamespaceMismatchError's own message
// also offers deploying into the pinned namespace, which an existing release
// cannot do.
func mismatchDetail(m *k8s.NamespaceMismatchError, update bool) string {
	if !update {
		return m.Error()
	}
	return fmt.Sprintf(
		"%s sets metadata.namespace %q, but this release is in %q and a release cannot change namespace: the template has to drop metadata.namespace",
		m.Object, m.Object.Namespace, m.ReleaseNamespace)
}

// ProblemConflict is one entry of a resource-conflict Problem's `conflicts`.
type ProblemConflict struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	// Owner is the release holding the object, or "" when kubeport did not
	// create it.
	Owner string `json:"owner"`
	// OwnerUnknown is true when the object exists but the caller may not read
	// it, so Owner is empty because nobody could look.
	OwnerUnknown bool `json:"owner_unknown,omitempty"`
	// SameName is true when Owner is the name of the release being deployed,
	// held under another release's id: objects left by an earlier release of
	// that name, or held by a release of that name under another registration
	// of the cluster (#195).
	SameName bool `json:"same_name,omitempty"`
}

// withConflicts lists every conflicting object. Unlike detail it is not capped:
// it is bounded by the template's own size, and a client acting on it needs all
// of them.
func withConflicts(conflicts []k8s.Conflict) problemOption {
	return func(p *Problem) {
		p.Conflicts = make([]ProblemConflict, len(conflicts))
		for i, cf := range conflicts {
			p.Conflicts[i] = ProblemConflict{
				Kind: cf.Kind, Name: cf.Name, Namespace: cf.Namespace,
				Owner: cf.Owner, OwnerUnknown: cf.OwnerUnknown, SameName: cf.SameName,
			}
		}
	}
}

// ProblemObject names one template object, for Problem.PinnedNamespace.
type ProblemObject struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

func withPinnedNamespace(obj k8s.ObjectRef) problemOption {
	return func(p *Problem) {
		p.PinnedNamespace = &ProblemObject{Kind: obj.Kind, Name: obj.Name, Namespace: obj.Namespace}
	}
}

// conflictDetail names the objects a release would have taken and what holds
// them, so the person deploying can find that release, or learn the object is
// not kubeport's at all.
//
// Naming the owner discloses nothing new. CheckApply reports an owner only for
// an object the caller could read, labels included. An object it could not
// read appears only when a dry-run create showed it exists, which the caller's
// own create permission already lets them ask, and then without an owner.
func conflictDetail(conflicts []k8s.Conflict, update bool) string {
	parts := make([]string, 0, maxConflictsNamed+1)
	for i, cf := range conflicts {
		if i == maxConflictsNamed {
			parts = append(parts, fmt.Sprintf("and %d more", len(conflicts)-i))
			break
		}
		switch {
		case cf.SameName:
			parts = append(parts, fmt.Sprintf("%s (left by an earlier release named %s, or held by one of that name under another registration of this cluster)",
				cf.ObjectRef.String(), strconv.Quote(cf.Owner)))
		case cf.Owner != "":
			parts = append(parts, fmt.Sprintf("%s (release %s)", cf.ObjectRef.String(), strconv.Quote(cf.Owner)))
		case cf.OwnerUnknown:
			parts = append(parts, cf.ObjectRef.String()+" (exists, but this account cannot read who holds it)")
		default:
			parts = append(parts, cf.ObjectRef.String()+" (not created by kubeport)")
		}
	}
	advice := " A different release name will not help; deploy into another namespace, or remove what holds them first."
	if update {
		advice = " A release cannot move namespace, so what holds them has to be removed first." +
			" If they were taken from this release before #161, removing the holder also removes this release's workload;" +
			" update this release again afterwards to recreate it."
	}
	return "objects this template creates already exist in namespace " + strconv.Quote(conflicts[0].Namespace) +
		" and belong to something else: " + strings.Join(parts, ", ") + "." + advice
}
