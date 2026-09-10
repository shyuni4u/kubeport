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
