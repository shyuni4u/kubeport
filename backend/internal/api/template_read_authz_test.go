package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"kubeport/internal/api"
	"kubeport/internal/auth"
	"kubeport/internal/config"
	"kubeport/internal/store"
)

// Template *writes* have always been gated by ensureTemplateEditor, but the
// read path had no authorization at all: any authenticated user could pull the
// full resources.yaml of any template, including drafts that were never
// published. See issue #12.

// newPlainUserRouter authenticates as an ordinary user — no kubeport-admin
// group, no team membership.
func newPlainUserRouter(t *testing.T, s *store.Store, suffix string) http.Handler {
	t.Helper()
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{
			Subject: "outsider-" + suffix,
			Email:   "outsider-" + suffix + "@example.com",
		}},
		Store: s,
	})
}

func TestGetTemplateVersion_DraftRequiresEditor(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter) // v1 starts as draft
	userRouter := newPlainUserRouter(t, s, randSuffix())

	// Never published, so "not found" like the list and GetTemplate answer —
	// a 403 would confirm the name they hide (#238).
	w := do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "resources_yaml")

	// The author still reads their own draft.
	w = do(t, adminRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "resources_yaml")

	// Once published it is catalog content and everyone may read it.
	publishV1(t, adminRouter, tplName)
	w = do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestListTemplateVersions_HidesDraftsFromNonEditors(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedPublishedTemplate(t, adminRouter) // v1 published

	// v2 is an unpublished draft.
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/templates/"+tplName+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	userRouter := newPlainUserRouter(t, s, randSuffix())
	w = do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []int{1}, versionNumbers(t, w.Body.Bytes()))

	w = do(t, adminRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []int{2, 1}, versionNumbers(t, w.Body.Bytes()))
}

func TestPreviewRender_DraftVersionRequiresEditor(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter) // v1 draft
	userRouter := newPlainUserRouter(t, s, randSuffix())

	body, _ := json.Marshal(map[string]any{"values": demoValues})
	w := do(t, userRouter, http.MethodPost, "/v1/templates/"+tplName+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "rendered_yaml")

	w = do(t, adminRouter, http.MethodPost, "/v1/templates/"+tplName+"/render?version=1", bytes.NewReader(body))
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

func TestListTemplates_HidesNeverPublishedTemplatesFromNonEditors(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	draftOnly := seedGlobalTemplate(t, adminRouter)
	published := seedPublishedTemplate(t, adminRouter)

	userRouter := newPlainUserRouter(t, s, randSuffix())
	w := do(t, userRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), published)
	require.NotContains(t, w.Body.String(), draftOnly)

	w = do(t, adminRouter, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), draftOnly)
}

// The demo scope rule already stops a demo admin from *editing* a real
// operator's template (TestDemoAdmin_CannotEditNonDemoOwnedTemplate); reading
// its draft must be blocked by the same rule.
func TestDemoAdmin_CannotReadNonDemoOwnedTemplateDraft(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminRouter)

	// The operator's template is on the other side of the demo line, and never
	// published besides: "not found" either way (#238).
	demoRouter := newDemoAdminRouter(t, s, &fakeK8sApplier{})
	w := do(t, demoRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "resources_yaml")
}

// seedTeamMember creates a user, puts them in the team with the given role and
// returns a router authenticated as them.
func seedTeamMember(t *testing.T, s *store.Store, adminR http.Handler, teamID, role string) http.Handler {
	t.Helper()
	suffix := randSuffix()
	email := role + "-" + suffix + "@example.com"
	subject := "member-" + role + "-" + suffix
	_, err := s.UpsertUser(context.Background(), store.UpsertUserParams{
		OidcSubject: subject, Email: store.PgText(email), DisplayName: store.PgText(role),
	})
	require.NoError(t, err)
	addMember(t, adminR, teamID, email, role)
	return api.NewRouter(config.Config{}, api.Deps{
		Verifier: customVerifier{claims: auth.Claims{Subject: subject, Email: email}},
		Store:    s,
	})
}

// `viewer` exists so a team member can look at the team's templates without
// being able to change them (docs/brainstorming-summary.md §teams). The read
// gate must therefore admit members, not just editors — reusing the mutation
// rule verbatim would have made the role pointless.
func TestGetTemplateVersion_TeamViewerCanReadOwnTeamDraft(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	teamID := createTeam(t, adminR, "readers-"+randSuffix())
	tplName := seedTemplateOwnedBy(t, adminR, teamID) // v1 draft, owned by the team

	viewerR := seedTeamMember(t, s, adminR, teamID, "viewer")
	w := do(t, viewerR, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "resources_yaml")

	// The draft is still listed for them, and the team template still shows up.
	w = do(t, viewerR, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Equal(t, []int{1}, versionNumbers(t, w.Body.Bytes()))

	w = do(t, viewerR, http.MethodGet, "/v1/templates", nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), tplName)

	// A viewer still cannot change it — the mutation rule is unchanged.
	w = do(t, viewerR, http.MethodDelete, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
}

// A member of another team gets nothing — and for a template never published,
// not even confirmation that the name exists (#238).
func TestGetTemplateVersion_OtherTeamMemberDenied(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})

	ownerTeam := createTeam(t, adminR, "owner-"+randSuffix())
	otherTeam := createTeam(t, adminR, "other-"+randSuffix())
	tplName := seedTemplateOwnedBy(t, adminR, ownerTeam)

	outsiderR := seedTeamMember(t, s, adminR, otherTeam, "editor")
	w := do(t, outsiderR, http.MethodGet, "/v1/templates/"+tplName+"/versions/1", nil)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
}

// Once a template has been published its name is catalog content, so a draft
// of a later version may say why it is refused — the reason ("team membership
// required") tells a reader what to do, and confirms nothing new.
func TestGetTemplateVersion_DraftOfPublishedTemplateKeepsItsReason(t *testing.T) {
	s := testStore(t)
	adminRouter := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedPublishedTemplate(t, adminRouter)
	body, _ := json.Marshal(map[string]any{
		"authoring_mode": "yaml",
		"resources_yaml": minimalResources,
		"ui_spec_yaml":   minimalUISpec,
	})
	w := do(t, adminRouter, http.MethodPost, "/v1/templates/"+tplName+"/versions", bytes.NewReader(body))
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())

	userRouter := newPlainUserRouter(t, s, randSuffix())
	w = do(t, userRouter, http.MethodGet, "/v1/templates/"+tplName+"/versions/2", nil)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "unpublished draft")
	require.NotContains(t, w.Body.String(), "resources_yaml")
}

// A never-published template must answer the same way everywhere: hidden from
// the list, and "not found" on the item routes. A 403 there would confirm the
// name the list just hid.
func TestGetTemplate_HidesNeverPublishedFromNonReaders(t *testing.T) {
	s := testStore(t)
	adminR := api.NewRouter(config.Config{}, api.Deps{Verifier: adminVerifier{}, Store: s})
	tplName := seedGlobalTemplate(t, adminR)
	userR := newPlainUserRouter(t, s, randSuffix())

	w := do(t, userR, http.MethodGet, "/v1/templates/"+tplName, nil)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())

	// The version list must not confirm it either.
	w = do(t, userR, http.MethodGet, "/v1/templates/"+tplName+"/versions", nil)
	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())

	// The author is unaffected, and so is a published template.
	w = do(t, adminR, http.MethodGet, "/v1/templates/"+tplName, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	published := seedPublishedTemplate(t, adminR)
	w = do(t, userR, http.MethodGet, "/v1/templates/"+published, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
}

// versionNumbers extracts the `version` field of every row in a
// {"versions": [...]} response, preserving order.
func versionNumbers(t *testing.T, raw []byte) []int {
	t.Helper()
	var resp struct {
		Versions []struct {
			Version int `json:"version"`
		} `json:"versions"`
	}
	require.NoError(t, json.Unmarshal(raw, &resp))
	out := make([]int, 0, len(resp.Versions))
	for _, v := range resp.Versions {
		out = append(out, v.Version)
	}
	return out
}
