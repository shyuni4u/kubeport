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
