package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"kubeport/cmd/seed-demo/fixtures"
	"kubeport/internal/store"
	"kubeport/internal/template"
)

// draftNotes is what demo-admin sees on the editable v2 of every seeded
// template (spec §4.1).
const draftNotes = "데모용 초안 — 자유롭게 수정해 보세요"

// templateSeeder writes the demo catalog straight to the database.
//
// It deliberately does not go through POST /v1/templates. The seeder runs as
// demo-admin so that the catalog it creates is demo-owned — that is what makes
// it visible to demo visitors and collectable by resetDB — but demo accounts
// are barred from authoring into the shared catalog (see denyDemo in
// api/routes.go). Opening that gate just so the reset CronJob can seed would
// hand the same power to anyone who reads the demo password off the landing
// page, which is the thing the gate exists to prevent.
//
// Releases stay on the HTTP API: creating one applies manifests to the demo
// cluster, and that side effect is the point of seeding them.
type templateSeeder struct {
	st    *store.Store
	owner store.User
}

// Run brings every fixture to the shape the demo expects: a published v1 that
// the catalog deploys, plus a later draft for demo-admin to edit. Idempotent —
// a fully seeded catalog produces no writes.
func (t *templateSeeder) Run(ctx context.Context) error {
	for _, f := range fixtures.All() {
		// The handler validates on write and nothing does down here, so a
		// fixture that stopped parsing would otherwise reach the catalog as an
		// entry nobody can deploy.
		if err := template.ValidateSpec(f.ResourcesYAML, f.UISpecYAML); err != nil {
			return fmt.Errorf("fixture %s: %w", f.Name, err)
		}

		existing, err := t.st.GetTemplateByName(ctx, f.Name)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			if err := t.create(ctx, f); err != nil {
				return fmt.Errorf("create template %s: %w", f.Name, err)
			}
			log.Printf("template %s created", f.Name)
		case err != nil:
			return fmt.Errorf("lookup template %s: %w", f.Name, err)
		default:
			// templates.name is globally unique, so a real user's template can
			// carry a fixture name. Repairing it would publish their draft and
			// graft demo YAML onto it — the HTTP path this replaced got a 403
			// here, and going around the API must not lose that refusal.
			if existing.OwnerUserID != t.owner.ID {
				return fmt.Errorf("template %s exists but belongs to another owner (%x); "+
					"refusing to modify it", f.Name, existing.OwnerUserID.Bytes)
			}
			log.Printf("template %s exists, skipping", f.Name)
			// A partially seeded template — created but never published, or its
			// draft deleted by a demo visitor — must still end up in the seeded
			// shape.
			if err := t.repair(ctx, existing, f); err != nil {
				return fmt.Errorf("repair template %s: %w", f.Name, err)
			}
		}
	}
	return nil
}

// create inserts the template with v1 published and v2 draft in one
// transaction, so a failure halfway cannot leave a template with no version.
func (t *templateSeeder) create(ctx context.Context, f fixtures.Template) error {
	return t.st.WithTx(ctx, func(q *store.Queries) error {
		tpl, err := q.InsertTemplateV2(ctx, store.InsertTemplateV2Params{
			Name:        f.Name,
			DisplayName: f.DisplayName,
			Description: store.PgText(f.Description),
			Tags:        f.Tags,
			OwnerUserID: t.owner.ID,
			// Global (no owning team) — same as what the seeder used to POST.
		})
		if err != nil {
			return err
		}
		if err := t.publishNewVersion(ctx, q, tpl.ID, 1, f); err != nil {
			return err
		}
		_, err = t.insertVersion(ctx, q, tpl.ID, 2, "draft", f)
		return err
	})
}

// repair re-establishes the two invariants on a template that already exists:
// the catalog can deploy it (current_version_id points at a published version)
// and there is a draft to edit.
//
// The test is the post-condition itself, not "is v1 a draft". A demo visitor
// can deprecate v1 — status changes without moving current_version_id — and a
// version-shaped check would call that healthy and leave the catalog entry
// undeployable, which is #104 again with a green exit code.
func (t *templateSeeder) repair(ctx context.Context, tpl store.GetTemplateByNameRow, f fixtures.Template) error {
	versions, err := t.st.ListTemplateVersions(ctx, f.Name)
	if err != nil {
		return err
	}

	var current, firstDraft *store.TemplateVersion
	for i, v := range versions {
		if v.ID == tpl.CurrentVersionID {
			current = &versions[i]
		}
		if v.Status == "draft" && firstDraft == nil {
			firstDraft = &versions[i]
		}
	}

	// Every published version must be the fixture. Any other was published by
	// someone else — a visitor before the #294 gate existed, or on an install
	// that opted in — and any published version can be deployed, current or
	// not. A reset keeps versions a non-demo release still points at, so those
	// can be here; the release keeps running, but nothing new deploys from
	// them (#306).
	for i := range versions {
		v := &versions[i]
		if v.Status != "published" || (v.ResourcesYaml == f.ResourcesYAML && v.UiSpecYaml == f.UISpecYAML) {
			continue
		}
		if _, err := t.st.SetTemplateVersionStatus(ctx, store.SetTemplateVersionStatusParams{
			ID: v.ID, Status: "deprecated",
		}); err != nil {
			return err
		}
		v.Status = "deprecated"
		log.Printf("template %s v%d deprecated: not the fixture's content", f.Name, v.Version)
	}

	if current == nil || current.Status != "published" {
		// Never publish a draft that is already there. Demo visitors can rewrite
		// any draft, and publishing is what puts content in front of every other
		// visitor: a draft published here would bypass the gate on the publish
		// route (#294). What goes back into the catalog is the fixture: a
		// deprecated version is brought back only when it still is the
		// fixture's content. One a visitor published before the gate existed
		// is immutable but not ours, and a reset that could not delete the demo
		// versions (a non-demo release holds one) must not revive it (#306).
		if current != nil && current.Status == "deprecated" &&
			current.ResourcesYaml == f.ResourcesYAML && current.UiSpecYaml == f.UISpecYAML {
			if _, err := t.st.SetTemplateVersionStatus(ctx, store.SetTemplateVersionStatusParams{
				ID: current.ID, Status: "published",
			}); err != nil {
				return err
			}
			log.Printf("template %s v%d undeprecated", f.Name, current.Version)
		} else if err := t.st.WithTx(ctx, func(q *store.Queries) error {
			next, err := q.NextTemplateVersion(ctx, tpl.ID)
			if err != nil {
				return err
			}
			log.Printf("template %s had no publishable version, adding v%d", f.Name, next)
			return t.publishNewVersion(ctx, q, tpl.ID, next, f)
		}); err != nil {
			return err
		}
	}

	if firstDraft != nil {
		log.Printf("template %s already has a draft, skipping", f.Name)
		return nil
	}
	// Read-then-insert inside one transaction: a demo visitor creating a draft
	// between the two would otherwise fail the unique index and kill the job.
	if err := t.st.WithTx(ctx, func(q *store.Queries) error {
		next, err := q.NextTemplateVersion(ctx, tpl.ID)
		if err != nil {
			return err
		}
		_, err = t.insertVersion(ctx, q, tpl.ID, next, "draft", f)
		return err
	}); err != nil {
		if isUniqueViolation(err) {
			log.Printf("template %s: another writer created the draft, skipping", f.Name)
			return nil
		}
		return err
	}
	log.Printf("template %s draft created", f.Name)
	return nil
}

// isUniqueViolation reports the collision the handler translates into 409
// ("a draft already exists for this template"). Down here it means a
// concurrent seeder or a demo visitor got there first, which is not a failure.
func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

// publishNewVersion writes the fixture as a published version and points the
// template at it. The row goes in as published rather than as a draft that is
// then published: the one draft a template may have can be a visitor's, and
// the fixture is the only content published from here.
func (t *templateSeeder) publishNewVersion(ctx context.Context, q *store.Queries, templateID pgtype.UUID, version int32, f fixtures.Template) error {
	ver, err := t.insertVersion(ctx, q, templateID, version, "published", f)
	if err != nil {
		return err
	}
	// Stamps published_at, as PublishVersion in the API does.
	if _, err := q.SetTemplateVersionStatus(ctx, store.SetTemplateVersionStatusParams{
		ID: ver.ID, Status: "published",
	}); err != nil {
		return err
	}
	return q.UpdateTemplateCurrentVersion(ctx, store.UpdateTemplateCurrentVersionParams{
		ID:               templateID,
		CurrentVersionID: ver.ID,
	})
}

func (t *templateSeeder) insertVersion(ctx context.Context, q *store.Queries, templateID pgtype.UUID, version int32, status string, f fixtures.Template) (store.TemplateVersion, error) {
	params := store.InsertTemplateVersionV2Params{
		TemplateID:      templateID,
		Version:         version,
		ResourcesYaml:   f.ResourcesYAML,
		UiSpecYaml:      f.UISpecYAML,
		Status:          status,
		CreatedByUserID: t.owner.ID,
		AuthoringMode:   "yaml",
	}
	if status == "draft" {
		params.Notes = store.PgText(draftNotes)
	}
	return q.InsertTemplateVersionV2(ctx, params)
}
