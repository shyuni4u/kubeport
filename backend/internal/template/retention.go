package template

// defaultClaimRetention makes the claims a StatefulSet's controller creates go
// when the StatefulSet does (#340).
//
// A release's delete removes what carries its labels, and those claims carry
// none: the controller copies only volumeClaimTemplates' own labels onto them,
// and stamping the release there is not an option — volumeClaimTemplates cannot
// change once the StatefulSet exists, so every update of an existing release
// would be refused. Left to the default (Retain) the claims outlived the
// release, and a later release under the same name mounted the earlier one's
// data.
//
// persistentVolumeClaimRetentionPolicy can change, so an existing release takes
// it on its next update. With Delete the controller makes the StatefulSet the
// claims' owner and the garbage collector removes them — which also reaches a
// caller that may not delete claims itself, as the demo's user account cannot.
//
// A default, not an override: a template that writes whenDeleted, or exposes
// it as a field, keeps the data it asked to keep. whenScaled is left to the
// apiserver's Retain — scaling down is not the release going away.
func defaultClaimRetention(doc map[string]any) {
	if doc["kind"] != "StatefulSet" {
		return
	}
	spec, ok := doc["spec"].(map[string]any)
	if !ok {
		return
	}
	if claims, ok := spec["volumeClaimTemplates"].([]any); !ok || len(claims) == 0 {
		return
	}
	var policy map[string]any
	switch p := spec["persistentVolumeClaimRetentionPolicy"].(type) {
	case nil:
		policy = map[string]any{}
		spec["persistentVolumeClaimRetentionPolicy"] = policy
	case map[string]any:
		policy = p
	default:
		// Not an object: the template's own mistake, left for the apiserver
		// to name rather than written over.
		return
	}
	if v, set := policy["whenDeleted"]; set && v != nil {
		return
	}
	policy["whenDeleted"] = "Delete"
}
