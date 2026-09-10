import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { SchemaNode } from "@/lib/openapi";
import ko from "@/messages/ko.json";

import { FieldInspector, uiSpecPath, type UIField } from "./FieldInspector";

// SchemaNode fakes — only the fields FieldInspector actually reads.
const stringSchema: SchemaNode = { type: "string" };
const integerSchema: SchemaNode = { type: "integer" };
const enumSchema: SchemaNode = { type: "string", enum: ["A", "B"] };

function harness(
  initial: UIField | undefined,
  schema: SchemaNode = stringSchema,
  extra: { kind?: string; resourceName?: string; readOnly?: boolean } = {},
) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <FieldInspector
        path="spec.image"
        node={schema}
        value={initial}
        onChange={onChange}
        onClear={onClear}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
  return { onChange, onClear };
}

describe("FieldInspector", () => {
  describe("header + help", () => {
    it("shows the ui-spec path Kind[name].path when resource context is given", () => {
      harness(undefined, stringSchema, { kind: "Deployment", resourceName: "web" });
      const header = screen.getByText("Deployment[web].spec.image");
      expect(header).toHaveAttribute("title", ko.templates.editor.field.uiSpecPathHelp);
    });

    it("falls back to the bare path without resource context", () => {
      harness(undefined);
      expect(screen.getByText("spec.image")).toBeInTheDocument();
    });

    it("renders (?) help beside the fix / expose buttons", () => {
      harness(undefined);
      expect(screen.getByRole("button", { name: "값 고정" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "사용자 노출" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: "도움말" })).toHaveLength(2);
    });

    it("exposing a field starts with an EMPTY label and a placeholder suggesting the leaf", () => {
      const { onChange } = harness(undefined);
      fireEvent.click(screen.getByRole("button", { name: "사용자 노출" }));
      const next = onChange.mock.calls[0][0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.label).toBe("");
    });

    it("shows the label placeholder with the path leaf", () => {
      harness({ mode: "exposed", uiSpec: { label: "", type: "string", required: false } });
      expect(screen.getByPlaceholderText("사용자에게 보일 이름 (예: image)")).toBeInTheDocument();
    });

    it("lets the admin author the help text users see behind (?)", () => {
      const { onChange } = harness({ mode: "exposed", uiSpec: { label: "이미지", type: "string", required: false } });
      const input = screen.getByPlaceholderText(/사용자가 \(\?\) 를 눌렀을 때/);
      fireEvent.change(input, { target: { value: "실행할 프로그램 이름입니다." } });
      const next = onChange.mock.calls.at(-1)?.[0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.help).toBe("실행할 프로그램 이름입니다.");
    });

    it("clearing the help box drops the key so the ui-spec stays minimal", () => {
      const { onChange } = harness({
        mode: "exposed",
        uiSpec: { label: "이미지", type: "string", required: false, help: "예전 설명" },
      });
      fireEvent.change(screen.getByDisplayValue("예전 설명"), { target: { value: "" } });
      const cleared = onChange.mock.calls.at(-1)?.[0] as Extract<UIField, { mode: "exposed" }>;
      expect(cleared.uiSpec.help).toBeUndefined();
    });
  });

  describe("입력 방식 type toggle (string-compatible schema)", () => {
    it("hides the toggle when no field is exposed yet", () => {
      harness(undefined);
      expect(screen.queryByText("입력 방식")).toBeNull();
    });

    it("shows 3-way toggle when string field is exposed", () => {
      harness({
        mode: "exposed",
        uiSpec: { label: "Image", type: "string", required: false },
      });
      expect(screen.getByText("입력 방식")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "자유 텍스트" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "선택지" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "추천" })).toBeInTheDocument();
    });

    it("hides the toggle for integer schema", () => {
      harness(
        {
          mode: "exposed",
          uiSpec: { label: "Replicas", type: "integer", required: false },
        },
        integerSchema,
      );
      expect(screen.queryByText("입력 방식")).toBeNull();
    });

    it("upgrading string → 선택지 (enum) does NOT auto-seed values", () => {
      // Auto-seeding `[""]` would produce `z.enum([""])` downstream, which
      // accepts only the literal empty string — confusing footgun. The
      // admin uses "+ 값 추가" to start the list explicitly.
      const { onChange } = harness({
        mode: "exposed",
        uiSpec: { label: "Image", type: "string", required: false },
      });
      fireEvent.click(screen.getByRole("button", { name: "선택지" }));
      expect(onChange).toHaveBeenCalledOnce();
      const next = onChange.mock.calls[0][0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.type).toBe("enum");
      expect(next.uiSpec.values).toBeUndefined();
    });

    it("upgrading string → 추천 (autocomplete) also does NOT auto-seed", () => {
      const { onChange } = harness({
        mode: "exposed",
        uiSpec: { label: "Image", type: "string", required: false },
      });
      fireEvent.click(screen.getByRole("button", { name: "추천" }));
      const next = onChange.mock.calls[0][0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.type).toBe("autocomplete");
      expect(next.uiSpec.values).toBeUndefined();
    });

    it("switching enum ↔ autocomplete preserves the values list", () => {
      const { onChange } = harness({
        mode: "exposed",
        uiSpec: {
          label: "Image",
          type: "enum",
          values: ["nginx:1.25", "nginx:1.27"],
          required: false,
        },
      });
      fireEvent.click(screen.getByRole("button", { name: "추천" }));
      const next = onChange.mock.calls[0][0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.type).toBe("autocomplete");
      expect(next.uiSpec.values).toEqual(["nginx:1.25", "nginx:1.27"]);
    });
  });

  describe("values list editor", () => {
    it("renders for autocomplete with the 추천 항목 label", () => {
      harness({
        mode: "exposed",
        uiSpec: {
          label: "Image",
          type: "autocomplete",
          values: ["nginx:1.25"],
          required: false,
        },
      });
      expect(screen.getByText(/추천 항목/)).toBeInTheDocument();
      expect(screen.getByDisplayValue("nginx:1.25")).toBeInTheDocument();
    });

    it("renders for enum with the 선택지 (Values) label", () => {
      harness(
        {
          mode: "exposed",
          uiSpec: {
            label: "Type",
            type: "enum",
            values: ["A"],
            required: false,
          },
        },
        enumSchema,
      );
      // "선택지" alone matches both the toggle button and the list header,
      // so anchor on the parenthesized "(Values)" suffix that's only on the
      // list header.
      expect(screen.getByText(/선택지\s*\(Values\)/)).toBeInTheDocument();
    });

    it("does not render for plain string type", () => {
      harness({
        mode: "exposed",
        uiSpec: { label: "Image", type: "string", required: false },
      });
      expect(screen.queryByText(/추천 항목/)).toBeNull();
      expect(screen.queryByText(/선택지 \(Values\)/)).toBeNull();
    });

    it("+ 값 추가 appends an empty string to values", () => {
      const { onChange } = harness({
        mode: "exposed",
        uiSpec: {
          label: "Image",
          type: "autocomplete",
          values: ["a", "b"],
          required: false,
        },
      });
      fireEvent.click(screen.getByText("+ 값 추가"));
      const next = onChange.mock.calls[0][0] as Extract<UIField, { mode: "exposed" }>;
      expect(next.uiSpec.values).toEqual(["a", "b", ""]);
    });
  });

  // #184 — a YAML-authored draft opened in UI mode cannot be saved, yet every
  // input accepted typing next to a save button that never enabled.
  //
  // Asserted as disabled rather than by clicking: jsdom still dispatches a
  // click to a control inside a disabled fieldset, which a browser does not.
  describe("readOnly", () => {
    const exposed: UIField = {
      mode: "exposed",
      uiSpec: { label: "Image", type: "string", required: false },
    };

    it("shows the field's settings but lets nothing change them", () => {
      harness(exposed, stringSchema, { readOnly: true });

      expect(screen.getByDisplayValue("Image")).toBeDisabled();
      expect(screen.getByText(ko.templates.editor.field.fix)).toBeDisabled();
      expect(screen.getByText(ko.templates.editor.field.expose)).toBeDisabled();
      expect(screen.getByRole("checkbox")).toBeDisabled();
    });

    it("stays editable by default", () => {
      harness(exposed);

      expect(screen.getByDisplayValue("Image")).toBeEnabled();
      expect(screen.getByText(ko.templates.editor.field.fix)).toBeEnabled();
    });
  });

  describe("uiSpecPath", () => {
    it("formats Kind[name].path and falls back to path", () => {
      expect(uiSpecPath("Deployment", "web", "spec.replicas")).toBe("Deployment[web].spec.replicas");
      expect(uiSpecPath(undefined, undefined, "spec.replicas")).toBe("spec.replicas");
    });
  });
});
