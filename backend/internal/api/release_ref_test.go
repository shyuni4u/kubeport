package api

import (
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/internal/store"
)

// #195: a release is NameOnly — its unstamped objects are its own — only while
// the YAML last applied for it carries no id. Once applied with one, a
// same-named release elsewhere is never mistaken for it.
func TestReleaseRef_NameOnlyUntilItsYAMLCarriesTheID(t *testing.T) {
	id := pgtype.UUID{Bytes: [16]byte{0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x33, 0x33, 0x44, 0x44, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55}, Valid: true}
	const uid = "11111111-2222-3333-4444-555555555555"

	legacy := `apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    kubeport.io/release-id: web
  labels:
    kubeport.io/release: web
  name: web
`
	stamped := `apiVersion: apps/v1
kind: Deployment
metadata:
  labels:
    kubeport.io/release: web
    kubeport.io/release-uid: ` + uid + `
  name: web
`
	// Text that only looks like the label — in a ConfigMap value — does not
	// make a release stamped. It errs towards NameOnly, which is what it was.
	lookalike := `apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    kubeport.io/release: web
  name: web
data:
  note: "kubeport.io/release-uid: ` + uid + `"
`

	for name, tc := range map[string]struct {
		yaml     string
		nameOnly bool
	}{
		"applied before the id existed": {legacy, true},
		"applied with the id":           {stamped, false},
		"label text inside a value":     {lookalike, true},
	} {
		t.Run(name, func(t *testing.T) {
			ref := releaseRef(store.GetReleaseByIDRow{ID: id, Name: "web", Namespace: "demo", RenderedYaml: tc.yaml})
			if ref.UID != uid || ref.Name != "web" || ref.Namespace != "demo" {
				t.Fatalf("ref = %+v", ref)
			}
			if ref.NameOnly != tc.nameOnly {
				t.Fatalf("NameOnly = %v, want %v", ref.NameOnly, tc.nameOnly)
			}
		})
	}
}
