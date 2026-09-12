import { describe, it, expect } from "vitest";
import { createTranslator } from "next-intl";
import { saveErrorMessage } from "./saveError";
import { findUnlabelledExposedField } from "./useDirtyGuard";
import ko from "@/messages/ko.json";

// next-intl's translator has a narrow key union; saveErrorMessage only needs
// the (key, values) => string call shape.
const t = createTranslator({ locale: "ko", messages: ko, namespace: "templates.editor" }) as unknown as Parameters<
  typeof saveErrorMessage
>[0];

function res(status: number, body = ""): Response {
  return new Response(body, { status });
}

describe("saveErrorMessage", () => {
  it("explains the one-draft-per-template rule on 409", async () => {
    expect(await saveErrorMessage(t, res(409, '{"error":"draft exists"}'))).toBe(
      ko.templates.editor.errors.draftExists,
    );
  });

  it("maps 403 to a permission sentence", async () => {
    expect(await saveErrorMessage(t, res(403))).toBe(ko.templates.editor.errors.forbidden);
  });

  // #180 — a demo admin saving a new template was told it lacked permission,
  // though it holds the admin group; the refusal was the demo gate.
  it("says a demo account is restricted when the 403 is demo-restricted", async () => {
    const msg = await saveErrorMessage(
      t,
      res(403, '{"title":"demo-restricted","status":403,"detail":"demo accounts cannot perform this action"}'),
    );
    expect(msg).toBe(ko.templates.editor.errors.demoRestricted);
    expect(msg).not.toBe(ko.templates.editor.errors.forbidden);
  });

  // On the new-template screen the demo gate refuses creation itself — "can
  // only edit demo templates" would name a rule that did not apply.
  it("says creation is turned off when a new template is refused as demo-restricted", async () => {
    const msg = await saveErrorMessage(t, res(403, '{"title":"demo-restricted","status":403}'), {
      creating: true,
    });
    expect(msg).toBe(ko.templates.editor.errors.demoCreateRestricted);
  });

  it("keeps the permission sentence for a 403 of any other kind", async () => {
    expect(await saveErrorMessage(t, res(403, '{"title":"rbac-denied","status":403}'))).toBe(
      ko.templates.editor.errors.forbidden,
    );
  });

  it("keeps the backend validation detail on 400", async () => {
    expect(await saveErrorMessage(t, res(400, "ui-spec: field[0].path not found\n"))).toBe(
      "검증에 실패했습니다: ui-spec: field[0].path not found",
    );
  });

  // The BFF passes the Go API's Problem document through unchanged, so this —
  // not the plain text above — is what a real 400 looks like. Printed whole,
  // the sentence the author needs was buried inside the JSON.
  it("shows only the Problem's detail on a real 400", async () => {
    const body = JSON.stringify({
      type: "https://kubeport.io/errors/validation-error",
      title: "validation-error",
      status: 400,
      detail: "fields[0] (path `Deployment[web].spec.replicas`) has no label; the deploy form shows it beside the input",
      request_id: "r-1",
    });

    const msg = await saveErrorMessage(t, res(400, body));

    expect(msg).toBe(
      "검증에 실패했습니다: fields[0] (path `Deployment[web].spec.replicas`) has no label; the deploy form shows it beside the input",
    );
    expect(msg).not.toContain("validation-error");
    expect(msg).not.toContain("request_id");
  });

  it("tells the author to wait on 429, rather than printing the Problem", async () => {
    // The authoring routes gained a rate limit with issue #135, so a save can
    // now be refused for a reason that fixes itself. Without its own case this
    // fell through to `generic`, which shows the status and the raw body — and
    // buries the only thing that matters, that the draft is safe and retrying
    // works.
    const msg = await saveErrorMessage(
      t,
      res(429, '{"title":"rate-limited","detail":"too many requests; retry after 3s"}'),
    );
    expect(msg).toBe(ko.templates.editor.errors.rateLimited);
    expect(msg).not.toContain("429");
    expect(msg).not.toContain("rate-limited");
  });

  it("tells the author to shrink the template on 413, not to retry", async () => {
    // #128: an oversized body used to be a 400 whose detail was Go's
    // "http: request body too large". Its own case says what fixes it — the
    // same save sent again is refused again.
    const msg = await saveErrorMessage(
      t,
      res(413, '{"title":"payload-too-large","status":413,"detail":"request body exceeds 4 MiB"}'),
    );
    expect(msg).toBe(ko.templates.editor.errors.payloadTooLarge);
    expect(msg).not.toContain("payload-too-large");
    expect(msg).not.toContain("HTTP 413");
  });

  it("falls back to a generic message with status + detail", async () => {
    expect(await saveErrorMessage(t, res(500, "boom"))).toBe("저장에 실패했습니다 (HTTP 500). boom");
  });
});

describe("findUnlabelledExposedField", () => {
  it("returns the ui-spec path of the first exposed field with a blank label", () => {
    expect(
      findUnlabelledExposedField([
        { kind: "Deployment", name: "web", fields: { "spec.replicas": { mode: "fixed", fixedValue: 1 } } },
        { kind: "Service", name: "svc", fields: { "spec.type": { mode: "exposed", uiSpec: { label: "  " } } } },
      ]),
    ).toBe("Service[svc].spec.type");
  });

  it("returns null when every exposed field is labelled", () => {
    expect(
      findUnlabelledExposedField([
        { kind: "Deployment", name: "web", fields: { "spec.replicas": { mode: "exposed", uiSpec: { label: "Replicas" } } } },
      ]),
    ).toBeNull();
  });
});
