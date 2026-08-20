import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DynamicForm } from "./DynamicForm";
import type { UISpec } from "@/lib/ui-spec-to-zod";

describe("DynamicForm widget mapping", () => {
  it("renders Slider for integer with both min+max", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.replicas",
          label: "Replicas",
          type: "integer",
          min: 1,
          max: 10,
          default: 3,
          required: true,
        },
      ],
    };
    const { container } = render(
      <DynamicForm spec={spec} onSubmit={() => {}} />,
    );
    // base-ui Slider renders its thumb's hidden <input type="range">
    // (implicit role="slider"). Jsdom/testing-library's accessibility tree
    // treats the visually-hidden input as hidden, so query via data-slot.
    expect(container.querySelector('[data-slot="slider"]')).not.toBeNull();
    expect(
      container.querySelector('input[type="range"]'),
    ).not.toBeNull();
    // Numeric value display next to the slider.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("renders numeric Input for integer without both min+max", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.replicas",
          label: "Replicas",
          type: "integer",
          default: 2,
          required: true,
        },
      ],
    };
    const { container } = render(
      <DynamicForm spec={spec} onSubmit={() => {}} />,
    );
    const input = screen.getByLabelText(/Replicas/) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "number");
    expect(container.querySelector('[data-slot="slider"]')).toBeNull();
  });

  it("renders Switch for boolean", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.enabled",
          label: "Enabled",
          type: "boolean",
          default: false,
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("renders ToggleGroup for enum with <= 4 values", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.type",
          label: "Type",
          type: "enum",
          values: ["ClusterIP", "NodePort", "LoadBalancer"],
          default: "ClusterIP",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    // ToggleGroupItem renders a <button> with aria-pressed. Use getByText.
    expect(screen.getByText("ClusterIP")).toBeInTheDocument();
    expect(screen.getByText("NodePort")).toBeInTheDocument();
    expect(screen.getByText("LoadBalancer")).toBeInTheDocument();
    // No combobox trigger (that would mean Select was used).
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("renders Select for enum with > 4 values", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.kind",
          label: "Kind",
          type: "enum",
          values: ["a", "b", "c", "d", "e"],
          default: "a",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("renders text Input for string", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    const input = screen.getByLabelText(/Name/) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "text");
  });

  it("shows pattern hint below string input when pattern is set", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          pattern: "^[a-z]+$",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByText(/pattern:\s*\/\^\[a-z\]\+\$\//)).toBeInTheDocument();
  });

  it("does not render pattern hint when pattern is not set", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.queryByText(/pattern:/)).toBeNull();
  });

  it("renders text Input + datalist for autocomplete", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "spec.containers[0].image",
          label: "Image",
          type: "autocomplete",
          values: ["nginx:1.25", "nginx:1.27", "httpd:2.4"],
          required: true,
        },
      ],
    };
    const { container } = render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    const input = screen.getByLabelText(/Image/) as HTMLInputElement;
    expect(input).toHaveAttribute("type", "text");
    // The input is wired to a datalist by id; the datalist has one <option>
    // per suggestion. The id is path-scoped (alphanumerics + hyphens) so a
    // single form with multiple autocomplete fields doesn't share lists.
    const listId = input.getAttribute("list");
    expect(listId).toBeTruthy();
    const datalist = container.querySelector(`datalist#${CSS.escape(listId!)}`);
    expect(datalist).not.toBeNull();
    const options = datalist!.querySelectorAll("option");
    expect(options.length).toBe(3);
    expect(Array.from(options).map((o) => (o as HTMLOptionElement).value)).toEqual([
      "nginx:1.25",
      "nginx:1.27",
      "httpd:2.4",
    ]);
  });
});

describe("DynamicForm submit", () => {
  it("submitting with valid input calls onSubmit with values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ "metadata.name": "nginx" });
  });

  it("submitting with invalid input blocks onSubmit and shows error", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          pattern: "^[a-z]+$",
          required: true,
          // no default → required but empty fails
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/Name/) as HTMLInputElement;
    await user.type(input, "ABC");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    // FormMessage (role=none but data-slot=form-message) — look for message
    // text. Zod's regex error message typically contains "Invalid".
    const messages = document.querySelectorAll('[data-slot="form-message"]');
    expect(messages.length).toBeGreaterThan(0);
  });

  it("respects submitLabel prop override", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "x",
          required: true,
        },
      ],
    };
    render(
      <DynamicForm spec={spec} submitLabel="업데이트" onSubmit={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /업데이트/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /배포하기/ })).toBeNull();
  });

  it("defaults submit button label to 배포하기", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "x",
          required: true,
        },
      ],
    };
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeInTheDocument();
  });
});

describe("DynamicForm onChange callback", () => {
  it("fires onChange on text input change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "",
          required: true,
        },
      ],
    };
    render(
      <DynamicForm
        spec={spec}
        onSubmit={() => {}}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText(/Name/);
    await user.type(input, "ab");
    // Each keystroke triggers watch → onChange; at least one call.
    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls.at(-1)?.[0];
    expect(lastCall).toMatchObject({ "metadata.name": "ab" });
  });

  it("initialValues override spec defaults", () => {
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          default: "nginx",
          required: true,
        },
      ],
    };
    render(
      <DynamicForm
        spec={spec}
        initialValues={{ "metadata.name": "redis" }}
        onSubmit={() => {}}
      />,
    );
    const input = screen.getByLabelText(/Name/) as HTMLInputElement;
    expect(input.value).toBe("redis");
  });
});
