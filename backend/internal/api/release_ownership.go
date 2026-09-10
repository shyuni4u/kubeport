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
func (h *Handlers) checkOwnership(c *gin.Context, cli K8sApplier, op, namespace, release string, rendered []byte) bool {
	check, err := cli.CheckApply(c.Request.Context(), namespace, release, rendered)
	var mismatch *k8s.NamespaceMismatchError
	switch {
	case errors.As(err, &mismatch):
		// The template is what is wrong, not the cluster, and the message says
		// what to change in it (#137).
		writeError(c, http.StatusBadRequest, "validation-error", mismatch.Error())
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
		log.Printf("ownership unverified id=%s ns=%q release=%q objects=%q (caller may write them but not read them)",
			requestIDFrom(c), namespace, release, strings.Join(refs, ", "))
	}
	if len(check.Conflicts) > 0 {
		writeError(c, http.StatusConflict, "resource-conflict", conflictDetail(check.Conflicts),
			withConflicts(check.Conflicts))
		return false
	}
	return true
}

// ProblemConflict is one entry of a resource-conflict Problem's `conflicts`.
// Owner is "" when kubeport did not create the object.
type ProblemConflict struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Owner     string `json:"owner"`
}

// withConflicts lists every conflicting object. Unlike detail it is not capped:
// it is bounded by the template's own size, and a client acting on it needs all
// of them.
func withConflicts(conflicts []k8s.Conflict) problemOption {
	return func(p *Problem) {
		p.Conflicts = make([]ProblemConflict, len(conflicts))
		for i, cf := range conflicts {
			p.Conflicts[i] = ProblemConflict{Kind: cf.Kind, Name: cf.Name, Namespace: cf.Namespace, Owner: cf.Owner}
		}
	}
}

// conflictDetail names the objects a release would have taken and what holds
// them, so the person deploying can find that release, or learn the object is
// not kubeport's at all.
//
// Naming the owner discloses nothing new. CheckApply reports a conflict only
// for an object the caller could read, labels included; one it cannot read is
// unverified and never appears here.
func conflictDetail(conflicts []k8s.Conflict) string {
	parts := make([]string, 0, maxConflictsNamed+1)
	for i, cf := range conflicts {
		if i == maxConflictsNamed {
			parts = append(parts, fmt.Sprintf("and %d more", len(conflicts)-i))
			break
		}
		if cf.Owner == "" {
			parts = append(parts, cf.ObjectRef.String()+" (not created by kubeport)")
			continue
		}
		parts = append(parts, fmt.Sprintf("%s (release %s)", cf.ObjectRef.String(), strconv.Quote(cf.Owner)))
	}
	return "objects this template creates already exist in namespace " + strconv.Quote(conflicts[0].Namespace) +
		" and belong to something else: " + strings.Join(parts, ", ") +
		". A different release name will not help; deploy into another namespace, or remove what holds them first."
}
