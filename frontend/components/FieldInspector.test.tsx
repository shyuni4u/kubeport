import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SchemaNode } from "@/lib/openapi";

import { FieldInspector, type UIField } from "./FieldInspector";

// SchemaNode fakes — only the fields FieldInspector actually reads.
const stringSchema: SchemaNode = { type: "string" };
const integerSchema: SchemaNode = { type: "integer" };
const enumSchema: SchemaNode = { type: "string", enum: ["A", "B"] };

function harness(initial: UIField | undefined, schema: SchemaNode = stringSchema) {
  const onChange = vi.fn();
  const onClear = vi.fn();
  render(
    <FieldInspector
      path="spec.image"
      node={schema}
      value={initial}
      onChange={onChange}
      onClear={onClear}
    />,
  );
  return { onChange, onClear };
}

describe("FieldInspector", () => {
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
});
