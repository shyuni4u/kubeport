package main

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/jackc/pgx/v5"
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
			log.Printf("template %s exists, skipping", f.Name)
			// A partially seeded template — created but never published, or its
			// draft deleted by a demo visitor — must still end up in the seeded
			// shape.
			if err := t.repair(ctx, existing.ID, f); err != nil {
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
// v1 is published (the catalog deploys it) and some later version is a draft.
func (t *templateSeeder) repair(ctx context.Context, templateID pgtype.UUID, f fixtures.Template) error {
	versions, err := t.st.ListTemplateVersions(ctx, f.Name)
	if err != nil {
		return err
	}

	var v1Draft, laterDraft bool
	for _, v := range versions {
		if v.Status != "draft" {
			continue
		}
		if v.Version == 1 {
			v1Draft = true
		} else {
			laterDraft = true
		}
	}

	if v1Draft {
		if err := t.st.WithTx(ctx, func(q *store.Queries) error {
			for _, v := range versions {
				if v.Version != 1 {
					continue
				}
				return publish(ctx, q, v.ID, templateID)
			}
			return nil
		}); err != nil {
			return err
		}
		log.Printf("template %s v1 published", f.Name)
	}

	// Publishing v1 leaves nothing editable behind, so only a draft at a later
	// version counts.
	if laterDraft {
		log.Printf("template %s already has a draft, skipping", f.Name)
		return nil
	}
	next, err := t.st.NextTemplateVersion(ctx, templateID)
	if err != nil {
		return err
	}
	if err := t.st.WithTx(ctx, func(q *store.Queries) error {
		_, err := t.insertVersion(ctx, q, templateID, next, "draft", f)
		return err
	}); err != nil {
		return err
	}
	log.Printf("template %s draft created", f.Name)
	return nil
}

func (t *templateSeeder) publishNewVersion(ctx context.Context, q *store.Queries, templateID pgtype.UUID, version int32, f fixtures.Template) error {
	ver, err := t.insertVersion(ctx, q, templateID, version, "draft", f)
	if err != nil {
		return err
	}
	return publish(ctx, q, ver.ID, templateID)
}

// publish mirrors PublishVersion in the API: flip the version to published and
// point the template at it, in the same transaction.
func publish(ctx context.Context, q *store.Queries, versionID, templateID pgtype.UUID) error {
	pub, err := q.PublishTemplateVersion(ctx, versionID)
	if err != nil {
		return err
	}
	return q.UpdateTemplateCurrentVersion(ctx, store.UpdateTemplateCurrentVersionParams{
		ID:               templateID,
		CurrentVersionID: pub.ID,
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
	if version > 1 {
		params.Notes = store.PgText(draftNotes)
	}
	return q.InsertTemplateVersionV2(ctx, params)
}
