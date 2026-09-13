package template

import "fmt"

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

// MultiInstanceNameLimit is the longest name the rewrite may give an object. A
// Service's name is a DNS-1035 label, and a workload's name reappears in its
// pods' names with a suffix, so 63 is what holds for every kind renamed.
const MultiInstanceNameLimit = 63

// MultiInstanceMaxObjectName is the longest object name a multi-instance
// template may use, so a release name of at least 32 characters still fits.
const MultiInstanceMaxObjectName = 30

// releaseLabel is the label stampLabels writes on every object and pod
// template; the selectors of a multi-instance template also match on it.
const releaseLabel = "kubeport.io/release"

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
func renameForRelease(docs []map[string]any, release string) error {
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
		if len(renamed) > MultiInstanceNameLimit {
			return fmt.Errorf("%s %q would be named %q, longer than %d characters; use a release name of at most %d characters",
				kind, old, renamed, MultiInstanceNameLimit, MultiInstanceNameLimit-len(old)-1)
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
		}
		if kind == "StatefulSet" {
			r.rename(spec, "serviceName", "Service")
		}
		selectRelease(kind, spec, release)
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
func selectRelease(kind string, spec map[string]any, release string) {
	if spec == nil {
		return
	}
	switch kind {
	case "Service":
		if sel, ok := spec["selector"].(map[string]any); ok && len(sel) > 0 {
			sel[releaseLabel] = release
		}
	case "Deployment", "StatefulSet", "DaemonSet":
		if sel, ok := spec["selector"].(map[string]any); ok {
			ensureMap(sel, "matchLabels")[releaseLabel] = release
		}
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
