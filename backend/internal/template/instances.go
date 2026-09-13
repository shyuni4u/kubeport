package template

import (
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/util/validation"
)

// A template says, in its ui-spec, how many releases of it one namespace holds
// (#190). Single — also what an absent key means — renders the objects under
// the names the template gives them, so a second release in the namespace is
// refused for taking the first one's objects (#161). Multiple names every
// object after its release, points the template's own references at the new
// names, and adds the release label to the selectors that bind a workload to
// its pods and a Service to its endpoints.
const (
	InstancesSingle   = "single"
	InstancesMultiple = "multiple"
)

// MultiInstanceNameLimit is the longest name the rewrite gives an object of
// most kinds; nameLimit has the exceptions. A Service's name is a DNS-1035
// label and a workload's name reappears in its pods', so 63 holds for them,
// and kubeport keeps the rest to it too rather than the 253 a DNS-1123
// subdomain allows.
const MultiInstanceNameLimit = 63

// cronJobNameLimit is 52: the controller appends an 11-character suffix to
// name each Job, which must still fit a label.
const cronJobNameLimit = 52

func nameLimit(kind string) int {
	if kind == "CronJob" {
		return cronJobNameLimit
	}
	return MultiInstanceNameLimit
}

// nameProblems is what the apiserver would say about name for kind, checked
// before apply so a release name that makes a valid template's names invalid
// is a 400 naming the fix, not a failed apply. The release name's own rules
// are looser — it may start with a digit or hold dots — and a Service's name
// may do neither.
func nameProblems(kind, name string) []string {
	var probs []string
	switch kind {
	case "Service":
		probs = validation.IsDNS1035Label(name)
	case "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "Pod":
		probs = validation.IsDNS1123Label(name)
	default:
		probs = validation.IsDNS1123Subdomain(name)
	}
	if limit := nameLimit(kind); len(name) > limit {
		probs = append(probs, fmt.Sprintf("must be no more than %d characters", limit))
	}
	return probs
}

// MultiInstanceMaxObjectName is the longest object name a multi-instance
// template may use, so a release name of at least 32 characters still fits.
const MultiInstanceMaxObjectName = 30

// releaseLabel and releaseUIDLabel are what stampLabels writes on every object
// and pod template; the selectors of a multi-instance template also match on
// them. The id as well as the name, as ownership, delete and status do (#195):
// a name outlives its release — a force-deleted release can leave pods behind —
// and a later release of the same name must not select them. A selector cannot
// change after it is applied, so this is decided at the first render.
const (
	releaseLabel    = "kubeport.io/release"
	releaseUIDLabel = "kubeport.io/release-uid"
)

func (s UISpec) multiple() bool { return s.Instances == InstancesMultiple }

func checkInstances(v string) error {
	switch v {
	case "", InstancesSingle, InstancesMultiple:
		return nil
	}
	return fmt.Errorf("instances is %q; use single or multiple", v)
}

// validateMultiInstance refuses, at save, what a multi-instance template cannot
// deploy. A field that exposes metadata.name would be prefixed with the
// release name on top of what the user typed, and naming objects is what this
// mode takes over. An object name long enough that most release names push it
// past MultiInstanceNameLimit would only surface as a failed deploy.
func validateMultiInstance(spec UISpec, docs []map[string]any) error {
	for i, f := range spec.Fields {
		_, _, rest, err := parseHead(f.Path)
		if err != nil {
			continue // validatePath reports it
		}
		if canon, err := CanonicalPath(rest); err == nil && canon == "metadata.name" {
			return fmt.Errorf("fields[%d] (path `%s`) exposes metadata.name, but instances: multiple names every object after its release", i, f.Path)
		}
	}
	for _, d := range docs {
		if name := objectName(d); len(name) > MultiInstanceMaxObjectName {
			return fmt.Errorf("%v %q is %d characters; instances: multiple puts the release name in front of it, so keep object names to %d",
				d["kind"], name, len(name), MultiInstanceMaxObjectName)
		}
	}
	return nil
}

// renameForRelease is the rewrite instances: multiple asks for. It runs after
// values are set — ui-spec paths name objects by the template's own names —
// and before labels are stamped.
func renameForRelease(docs []map[string]any, release, uid string) error {
	if release == "" {
		return fmt.Errorf("instances: multiple needs a release name to render")
	}
	names := map[string]map[string]string{} // kind → template name → release's name
	for _, d := range docs {
		kind, _ := d["kind"].(string)
		old := objectName(d)
		if old == "" {
			continue
		}
		renamed := release + "-" + old
		if probs := nameProblems(kind, renamed); len(probs) > 0 {
			return fmt.Errorf("%s %q would be named %q, which Kubernetes refuses (%s); use a release name that starts with a lowercase letter, holds only lowercase letters, digits and '-', and is at most %d characters",
				kind, old, renamed, strings.Join(probs, "; "), nameLimit(kind)-len(old)-1)
		}
		if names[kind] == nil {
			names[kind] = map[string]string{}
		}
		names[kind][old] = renamed
	}

	r := refRewriter{names: names}
	for _, d := range docs {
		kind, _ := d["kind"].(string)
		if meta, ok := d["metadata"].(map[string]any); ok {
			r.rename(meta, "name", kind)
		}
		spec, _ := d["spec"].(map[string]any)
		switch kind {
		case "Deployment", "StatefulSet", "DaemonSet", "Job":
			r.podSpec(mapAt(spec, "template", "spec"))
		case "CronJob":
			r.podSpec(mapAt(spec, "jobTemplate", "spec", "template", "spec"))
		case "Pod":
			r.podSpec(spec)
		case "Ingress":
			r.ingress(spec)
		case "PersistentVolumeClaim":
			r.pvcSource(spec)
		}
		if kind == "StatefulSet" {
			r.rename(spec, "serviceName", "Service")
			// Its claim templates keep their names — the controller builds each
			// pod's claim from them — but a clone source among the template's
			// own claims has been renamed (codex review).
			for _, claim := range mapsIn(spec, "volumeClaimTemplates") {
				r.pvcSource(mapAt(claim, "spec"))
			}
		}
		selectRelease(kind, spec, release, uid)
	}
	return nil
}

// refRewriter points a reference at the release's name for an object, but
// only when the template itself declares that object. A name the template
// does not define — a Secret an operator created, a shared ConfigMap — stays
// as written.
type refRewriter struct {
	names map[string]map[string]string
}

func (r refRewriter) rename(m map[string]any, key, kind string) {
	if m == nil {
		return
	}
	old, ok := m[key].(string)
	if !ok {
		return
	}
	if renamed, ok := r.names[kind][old]; ok {
		m[key] = renamed
	}
}

// podSpec rewrites the references a pod spec makes by name to the kinds
// kubeport applies.
func (r refRewriter) podSpec(ps map[string]any) {
	if ps == nil {
		return
	}
	for _, v := range mapsIn(ps, "volumes") {
		r.rename(mapAt(v, "configMap"), "name", "ConfigMap")
		r.rename(mapAt(v, "secret"), "secretName", "Secret")
		r.rename(mapAt(v, "persistentVolumeClaim"), "claimName", "PersistentVolumeClaim")
		for _, src := range mapsIn(mapAt(v, "projected"), "sources") {
			r.rename(mapAt(src, "configMap"), "name", "ConfigMap")
			r.rename(mapAt(src, "secret"), "name", "Secret")
		}
		// Every volume source that names a Secret for its driver's credentials
		// (codex review). Listed all at once from the pod volume API, so the
		// closed list is closed by construction rather than one field a review.
		r.rename(mapAt(v, "csi", "nodePublishSecretRef"), "name", "Secret")
		for _, src := range []string{"cephfs", "cinder", "flexVolume", "iscsi", "rbd", "scaleIO", "storageos"} {
			r.rename(mapAt(v, src, "secretRef"), "name", "Secret")
		}
		r.rename(mapAt(v, "azureFile"), "secretName", "Secret")
		// A generic ephemeral volume stamps a claim from this template; its
		// clone source is the same reference a PersistentVolumeClaim makes.
		r.pvcSource(mapAt(v, "ephemeral", "volumeClaimTemplate", "spec"))
	}
	for _, key := range []string{"initContainers", "containers"} {
		for _, c := range mapsIn(ps, key) {
			for _, ef := range mapsIn(c, "envFrom") {
				r.rename(mapAt(ef, "configMapRef"), "name", "ConfigMap")
				r.rename(mapAt(ef, "secretRef"), "name", "Secret")
			}
			for _, e := range mapsIn(c, "env") {
				r.rename(mapAt(e, "valueFrom", "configMapKeyRef"), "name", "ConfigMap")
				r.rename(mapAt(e, "valueFrom", "secretKeyRef"), "name", "Secret")
			}
		}
	}
	for _, s := range mapsIn(ps, "imagePullSecrets") {
		r.rename(s, "name", "Secret")
	}
	// A pod's per-pod DNS name lives under the headless Service it names
	// (codex review).
	r.rename(ps, "subdomain", "Service")
}

// pvcSource rewrites a claim cloned from another claim of the template
// (codex review). dataSource and dataSourceRef name their source by kind; only
// a PersistentVolumeClaim in the core group is one of the template's own
// objects — a VolumeSnapshot or a populator's resource is not renamed.
func (r refRewriter) pvcSource(spec map[string]any) {
	for _, key := range []string{"dataSource", "dataSourceRef"} {
		src := mapAt(spec, key)
		if src == nil || src["kind"] != "PersistentVolumeClaim" {
			continue
		}
		if group, ok := src["apiGroup"].(string); ok && group != "" {
			continue
		}
		// dataSourceRef may name a claim in another namespace (codex review).
		// The template's claims live in the release's namespace, so a source
		// that names one is not the template's, whatever it is called.
		if ns, ok := src["namespace"].(string); ok && ns != "" {
			continue
		}
		r.rename(src, "name", "PersistentVolumeClaim")
	}
}

func (r refRewriter) ingress(spec map[string]any) {
	r.rename(mapAt(spec, "defaultBackend", "service"), "name", "Service")
	for _, rule := range mapsIn(spec, "rules") {
		for _, p := range mapsIn(mapAt(rule, "http"), "paths") {
			r.rename(mapAt(p, "backend", "service"), "name", "Service")
		}
	}
	for _, tls := range mapsIn(spec, "tls") {
		r.rename(tls, "secretName", "Secret")
	}
}

// selectRelease narrows the selectors that decide which pods belong to what.
// Two releases of one template keep the labels the template wrote — app: web
// on both — so without the release label a Service sends traffic to every
// release's pods and a Deployment counts them as its own. Pod templates carry
// the release label already (stampLabels). A Service without a selector points
// at endpoints someone else manages and is left alone; a Job's selector is
// generated by the apiserver.
func selectRelease(kind string, spec map[string]any, release, uid string) {
	if spec == nil {
		return
	}
	// The id goes in when the render has one — every render that is applied
	// does. A preview has none and selects by name. In this mode every pod
	// template carries the id, a Job's included (stampLabels).
	scope := func(labels map[string]any) {
		labels[releaseLabel] = release
		if uid != "" {
			labels[releaseUIDLabel] = uid
		}
	}
	switch kind {
	case "Service":
		if sel, ok := spec["selector"].(map[string]any); ok && len(sel) > 0 {
			scope(sel)
		}
	case "Deployment", "StatefulSet", "DaemonSet":
		if sel, ok := spec["selector"].(map[string]any); ok {
			scope(ensureMap(sel, "matchLabels"))
		}
	case "Job":
		selectManualJob(spec, scope)
	case "CronJob":
		selectManualJob(mapAt(spec, "jobTemplate", "spec"), scope)
	}
}

// selectManualJob scopes a Job whose selector the template wrote itself
// (manualSelector: true) to its release (codex review). Otherwise the apiserver
// generates a selector unique to each Job, and the release labels are not
// needed.
func selectManualJob(jobSpec map[string]any, scope func(map[string]any)) {
	if jobSpec == nil || jobSpec["manualSelector"] != true {
		return
	}
	if sel, ok := jobSpec["selector"].(map[string]any); ok {
		scope(ensureMap(sel, "matchLabels"))
	}
}

func objectName(doc map[string]any) string {
	name, _ := mapAt(doc, "metadata")["name"].(string)
	return name
}

// mapAt walks nested maps, returning nil where a key is missing or not a map.
func mapAt(m map[string]any, keys ...string) map[string]any {
	for _, k := range keys {
		if m == nil {
			return nil
		}
		m, _ = m[k].(map[string]any)
	}
	return m
}

// mapsIn returns the maps in the list m[key], skipping anything else.
func mapsIn(m map[string]any, key string) []map[string]any {
	if m == nil {
		return nil
	}
	list, _ := m[key].([]any)
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if mm, ok := item.(map[string]any); ok {
			out = append(out, mm)
		}
	}
	return out
}
