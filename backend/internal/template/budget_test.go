package template_test

import (
	"runtime"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/template"
)

// One field whose path is a few hundred bytes used to allocate gigabytes.
//
// maxArrayIndex bounded ONE array segment at 1024, but a path may hold as many
// array segments as it likes and each one grows a fresh 1025-slot slice whose
// every slot gets a container placeholder — while the walk descends into
// exactly one of them. So the cost multiplies down the path while the path
// itself grows by 8 bytes a step.
//
// Measured before the budget landed (go test, this package): 801 bytes of path
// text left 196MB on the heap, 4KB left 1.9GB. The backend pod's limit is
// 256Mi with replicaCount 1, so one request took the only replica down.
//
// 20 segments stays well inside maxPathDepth, so what refuses this is the
// container budget and not the depth cap.
func TestSerializeUIMode_RejectsArrayGrowthBudget(t *testing.T) {
	path := strings.Repeat("a[1024].", 20) + "x"
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				path: {Mode: "fixed", FixedValue: "v"},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "too many")
}

// The same exhaustion with no array index anywhere, and it is NOT the same
// resource being spent. 8000 plain segments creates only 8000 containers —
// inside any sane container budget — but the YAML encoder indents, so a
// document nested N deep costs ~N² bytes of output: 16KB of path text
// measured at 64MB of resources.yaml, which the encoder then copies.
//
// Depth therefore has its own limit. A budget that counted containers alone
// would have let this through.
func TestSerializeUIMode_RejectsDeepPath(t *testing.T) {
	path := strings.Repeat("a.", 8000) + "x"
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				path: {Mode: "fixed", FixedValue: "v"},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "deeper than")
}

// The depth limit has to bite before the walk builds the document, or capping
// depth accomplishes nothing: the refusal must be cheap.
func TestSerializeUIMode_DeepPathRefusalStaysSmall(t *testing.T) {
	path := strings.Repeat("a.", 200000) + "x"
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				path: {Mode: "fixed", FixedValue: "v"},
			}},
		},
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _, err := template.SerializeUIMode(ui)
	runtime.ReadMemStats(&after)
	require.Error(t, err)
	require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(64<<20),
		"refusing a 400KB path should not cost the document it describes")
}

// The budget is per CALL, not per field or per resource — otherwise a body
// carrying N fields, each individually under budget, multiplies right back up.
// maxRequestBody (4MiB) leaves room for a great many such fields.
func TestSerializeUIMode_BudgetIsSharedAcrossFields(t *testing.T) {
	fields := map[string]template.UIField{}
	for i := 0; i < 200; i++ {
		// Each field on its own grows ~1025 slots — well inside any per-field
		// allowance, and 200× over the per-request one.
		fields["f"+strings.Repeat("x", i)+"[1024].k"] = template.UIField{Mode: "fixed", FixedValue: "v"}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: fields},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "too many")
}

// ...and across resources, for the same reason: one request may carry many.
func TestSerializeUIMode_BudgetIsSharedAcrossResources(t *testing.T) {
	var resources []template.UIResource
	for i := 0; i < 200; i++ {
		resources = append(resources, template.UIResource{
			APIVersion: "v1", Kind: "ConfigMap", Name: "m" + strings.Repeat("x", i),
			Fields: map[string]template.UIField{"a[1024].k": {Mode: "fixed", FixedValue: "v"}},
		})
	}
	_, _, err := template.SerializeUIMode(template.UIModeTemplate{Resources: resources})
	require.Error(t, err)
	require.Contains(t, err.Error(), "too many")
}

// maxPathDepth is unexported; this is the worst a caller can do while staying
// under it, which is what the refusal cost should be measured against.
const maxDepthForTest = 128

// A refusal has to be cheap, or refusing is itself the denial of service. The
// walk stops at the budget, so the peak is the budget's worth of containers
// and not the path's.
func TestSerializeUIMode_RefusalStaysSmall(t *testing.T) {
	path := strings.Repeat("a[1024].", maxDepthForTest) + "x"
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				path: {Mode: "fixed", FixedValue: "v"},
			}},
		},
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _, err := template.SerializeUIMode(ui)
	runtime.ReadMemStats(&after)
	require.Error(t, err)

	// The refusal costs the BUDGET's worth of containers, not the path's, so
	// this bound tracks maxNewContainers rather than the 4KB of path text.
	// Two orders of magnitude under the 1.9GB this path used to reach.
	const cap = 32 << 20
	require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(cap),
		"a refused path should not allocate its way to the refusal")
}

// Charging only the walk left the VALUE as a way around the whole budget.
// setJSONPathAbsolute's last step is `mp[key] = v`, and v is whatever the
// request's JSON decoded to — UIField.FixedValue is `any`. So a two-segment
// path could hang an arbitrarily deep object off the document, and the encoder
// indented it the same as any other nesting: value depth 2000 under `data.k`
// produced 4MB of YAML, and a 4MiB body of them produced gigabytes. The path
// limits could not see any of it. Found by security review of this change.
func TestSerializeUIMode_ChargesNestedFixedValue(t *testing.T) {
	var v any = "x"
	for i := 0; i < 500; i++ {
		v = map[string]any{"a": v}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				"data.k": {Mode: "fixed", FixedValue: v},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "nests deeper")
}

// A wide value is the same hole in the other direction — no depth at all.
func TestSerializeUIMode_ChargesWideFixedValue(t *testing.T) {
	wide := make([]any, 20000)
	for i := range wide {
		wide[i] = map[string]any{"a": "b"}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				"data.k": {Mode: "fixed", FixedValue: wide},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "too many")
}

// An exposed field's default takes the same route into the document, so it
// has to be charged the same way.
func TestSerializeUIMode_ChargesNestedUISpecDefault(t *testing.T) {
	var v any = "x"
	for i := 0; i < 500; i++ {
		v = map[string]any{"a": v}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: map[string]template.UIField{
				"data.k": {Mode: "exposed", UISpec: &template.UISpecEntry{
					Path: "data.k", Label: "K", Type: "string", Default: v,
				}},
			}},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "nests deeper")
}

// Counting containers does not bound output. Values carry no containers at
// all, so a few short paths holding long strings costs nothing anywhere else
// and still writes megabytes: the object budget sees ~2, the depth limit sees
// 2, the path-byte limit sees a few KB.
func TestSerializeUIMode_BoundsOutputSize(t *testing.T) {
	big := strings.Repeat("x", 4096)
	fields := map[string]template.UIField{}
	for i := 0; i < 1000; i++ {
		fields["data.k"+itoa(i)] = template.UIField{Mode: "fixed", FixedValue: big}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: fields},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "bytes of YAML")
}

// The byte cap watches the document, and an exposed field with no default
// writes nothing to it — so a template of nothing but exposed fields used to
// sail straight past. Measured that way, 3.7MiB of body produced 7.2MiB of
// ui-spec and 821MB of allocation with the resources cap untouched. Both
// outputs now draw on the one allowance.
func TestSerializeUIMode_BoundsUISpecOutputSize(t *testing.T) {
	values := make([]string, 200)
	for i := range values {
		values[i] = strings.Repeat("v", 64)
	}
	fields := map[string]template.UIField{}
	for i := 0; i < 1000; i++ {
		p := "data.k" + itoa(i)
		fields[p] = template.UIField{Mode: "exposed", UISpec: &template.UISpecEntry{
			Path: p, Label: "K", Type: "string", Values: values,
		}}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: fields},
		},
	}
	_, _, err := template.SerializeUIMode(ui)
	require.Error(t, err)
	require.Contains(t, err.Error(), "bytes of YAML")
}

// Field-path text is the work the byte cap cannot see: CanonicalPath runs over
// every path before the encoder starts, and it scales with the body. A 3.77MiB
// body of paths spent 748ms and was then refused by the byte cap — 622ms of it
// before the cap could look. Refusing must be cheaper than accepting.
func TestSerializeUIMode_BoundsPathTextBeforeCanonicalizing(t *testing.T) {
	prefix := ""
	for i := 0; i < 120; i++ {
		prefix += "a."
	}
	fields := map[string]template.UIField{}
	for i := 0; i < 16000; i++ {
		fields[prefix+"k"+itoa(i)] = template.UIField{Mode: "fixed", FixedValue: "v"}
	}
	ui := template.UIModeTemplate{
		Resources: []template.UIResource{
			{APIVersion: "v1", Kind: "ConfigMap", Name: "m", Fields: fields},
		},
	}
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	_, _, err := template.SerializeUIMode(ui)
	runtime.ReadMemStats(&after)
	require.Error(t, err)
	require.Contains(t, err.Error(), "field paths total")
	require.Less(t, after.TotalAlloc-before.TotalAlloc, uint64(32<<20),
		"the refusal must not canonicalize the paths it is refusing")
}

// The guard must not refuse manifests anyone actually writes. This is a
// deliberately oversized one — 5 Deployments, each with 10 containers carrying
// 50 env vars and 10 volume mounts — well past anything in this product, and
// still inside the budget with room over.
func TestSerializeUIMode_AllowsAnOversizedRealTemplate(t *testing.T) {
	var resources []template.UIResource
	for r := 0; r < 5; r++ {
		fields := map[string]template.UIField{}
		for c := 0; c < 10; c++ {
			base := "spec.template.spec.containers[" + itoa(c) + "]"
			fields[base+".image"] = template.UIField{Mode: "fixed", FixedValue: "nginx"}
			// Structured values too — a real manifest's fields are not all
			// scalars, and chargeValue must not refuse ordinary ones.
			fields[base+".resources"] = template.UIField{Mode: "fixed", FixedValue: map[string]any{
				"limits":   map[string]any{"cpu": "500m", "memory": "256Mi"},
				"requests": map[string]any{"cpu": "50m", "memory": "64Mi"},
			}}
			fields[base+".args"] = template.UIField{Mode: "fixed", FixedValue: []any{"-c", "run", "--flag"}}
			for e := 0; e < 50; e++ {
				fields[base+".env["+itoa(e)+"].name"] = template.UIField{Mode: "fixed", FixedValue: "K"}
				fields[base+".env["+itoa(e)+"].value"] = template.UIField{Mode: "fixed", FixedValue: "V"}
			}
			for m := 0; m < 10; m++ {
				fields[base+".volumeMounts["+itoa(m)+"].mountPath"] = template.UIField{Mode: "fixed", FixedValue: "/x"}
			}
		}
		resources = append(resources, template.UIResource{
			APIVersion: "apps/v1", Kind: "Deployment", Name: "web" + itoa(r), Fields: fields,
		})
	}
	_, _, err := template.SerializeUIMode(template.UIModeTemplate{Resources: resources})
	require.NoError(t, err)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
