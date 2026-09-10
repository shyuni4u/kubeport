import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { DynamicForm } from "./DynamicForm";
import type { UISpec } from "@/lib/ui-spec-to-zod";
import ko from "@/messages/ko.json";

// DynamicForm translates zod issues via next-intl, so every render needs a
// provider. Korean messages are used so assertions can check real sentences.
function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      {ui}
    </NextIntlClientProvider>,
  );
}

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
    const { container } = renderWithIntl(
      <DynamicForm spec={spec} onSubmit={() => {}} />,
    );
    // base-ui Slider renders its thumb's hidden <input type="range">
    // (implicit role="slider"). Jsdom/testing-library's accessibility tree
    // treats the visually-hidden input as hidden, so query via data-slot.
    expect(container.querySelector('[data-slot="slider"]')).not.toBeNull();
    expect(
      container.querySelector('input[type="range"]'),
    ).not.toBeNull();
    // Numeric value readout — on the label row since #113.
    expect(screen.getByTestId("slider-value")).toHaveTextContent("3");
  });

  // #164 — DynamicForm is the trust boundary, and the deploy form is the
  // entry point that proves it has to be: DeployClient hands it the server's
  // ui-spec directly, with no preview component in between to normalise it.
  //
  // Once schemaFromUISpec stopped throwing on an undescribable field, an
  // un-normalised spec would leave the field out of the schema while still
  // rendering its row — renderWidget returns undefined, and FormControl's
  // React.cloneElement throws on that. The crash would just move from the
  // validator to the renderer, into the one form with no error boundary.
  it("drops an undescribable field instead of rendering a row it cannot fill", () => {
    const spec = {
      fields: [
        { path: "metadata.name", label: "Name", type: "string" },
        { path: "broken", label: "Broken", type: "sxtring" },
      ],
    } as unknown as UISpec;

    expect(() =>
      renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />),
    ).not.toThrow();
    expect(screen.getByLabelText(/Name/)).toBeInTheDocument();
    expect(screen.queryByText("Broken")).toBeNull();
  });

  it("survives an enum with no values, from any entry point", () => {
    const spec = {
      fields: [{ path: "a", label: "Choice", type: "enum" }],
    } as unknown as UISpec;
    expect(() =>
      renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />),
    ).not.toThrow();
    expect(screen.queryByText("Choice")).toBeNull();
  });

  // The document-level shapes, one level above the field-level ones. The
  // deploy pages fall back to `{fields: []}` only when the whole YAML is
  // empty, so `fields:` with no value (null) and a spec with no `fields` key
  // at all ({}) arrive here as-is — and the backend accepts both on save.
  it.each([
    ["fields: null", { fields: null }],
    ["no fields key", {}],
    ["fields not a list", { fields: "nope" }],
  ])("renders an empty form for a ui-spec with %s", (_label, raw) => {
    expect(() =>
      renderWithIntl(
        <DynamicForm spec={raw as unknown as UISpec} onSubmit={() => {}} />,
      ),
    ).not.toThrow();
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
    const { container } = renderWithIntl(
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
    // Plain-language sentence only — the raw regex must never be shown.
    expect(screen.getByText("정해진 형식이 있는 값입니다.")).toBeInTheDocument();
    expect(screen.queryByText(/\^\[a-z\]\+\$/)).toBeNull();
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.queryByText("정해진 형식이 있는 값입니다.")).toBeNull();
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
    const { container } = renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    const input = screen.getByLabelText(/Name/) as HTMLInputElement;
    await user.type(input, "ABC");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    // FormMessage (role=none but data-slot=form-message) — the zod regex
    // issue is translated to the plain-language pattern sentence, never
    // zod's raw "Invalid".
    const messages = document.querySelectorAll('[data-slot="form-message"]');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0]).toHaveTextContent("허용되지 않는 형식입니다.");
    expect(screen.queryByText(/^Invalid$/)).toBeNull();
  });

  it("shows a localized required message when a required string is left empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("필수 항목입니다.")).toBeInTheDocument();
    expect(screen.queryByText(/^Required$/)).toBeNull();
  });

  it("shows a localized too-long message for a string over maxLength", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    // maxLength is enforced by zod only (no native attribute), so the issue
    // reaches the resolver instead of being blocked by HTML validation.
    const spec: UISpec = {
      fields: [
        {
          path: "metadata.name",
          label: "Name",
          type: "string",
          maxLength: 3,
          default: "toolong",
          required: true,
        },
      ],
    };
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    // Strings get a character-count sentence, not the numeric bound wording.
    expect(await screen.findByText("3자 이하로 입력하세요.")).toBeInTheDocument();
    expect(screen.queryByText(/String must contain/)).toBeNull();
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
    renderWithIntl(
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
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
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
    renderWithIntl(
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

  it("keeps bracket paths flat in onChange and onSubmit (regression)", async () => {
    // RHF splits field names on `[` and `]` as well as `.`; before the
    // bracket encoding, `Deployment[web]...containers[0].env[0].value`
    // came back as a nested object and submit sent the stale default.
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSubmit = vi.fn();
    const path = "Deployment[web].spec.template.spec.containers[0].env[0].value";
    const spec: UISpec = {
      fields: [{ path, label: "Msg", type: "string", default: "x" }],
    };
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} onChange={onChange} />);
    await user.type(screen.getByLabelText(/Msg/), "y");
    const last = onChange.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(last).toEqual({ [path]: "xy" });
    await user.click(screen.getByRole("button"));
    expect(onSubmit).toHaveBeenCalledWith({ [path]: "xy" });
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
    renderWithIntl(
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

// #31 — a second click before the parent re-renders used to fire a second
// POST /v1/releases. The parent's `disabled` prop lands a render too late,
// so the guard has to live inside the form.
describe("DynamicForm double submit", () => {
  const nameSpec: UISpec = {
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

  it("does not call onSubmit twice while the first submit is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const inFlight = new Promise<void>((r) => {
      release = r;
    });
    const onSubmit = vi.fn().mockReturnValue(inFlight);

    renderWithIntl(<DynamicForm spec={nameSpec} onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: /배포하기/ });

    await user.click(button);
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    release();
  });

  // The guard is scoped to "a submit is in flight" and nothing more —
  // DynamicForm cannot know whether the parent is about to navigate away.
  // Staying locked *after a successful* submit is the parent's job, pinned by
  // DeployClient.test.tsx "stays locked after a successful deploy".
  it("accepts a new submit once the previous one has settled", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const onSubmit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            release = r;
          }),
      )
      .mockResolvedValue(undefined);

    renderWithIntl(<DynamicForm spec={nameSpec} onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: /배포하기/ });

    await user.click(button);
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  // A synchronous (void-returning) onSubmit is still a valid consumer —
  // UserFormPreview and LandingCompare use one.
  it("still submits when onSubmit returns void", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    renderWithIntl(<DynamicForm spec={nameSpec} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

// Part of #30: the deploy form's preview → kinds → RBAC preflight chain hangs
// off onChange. Emitting only on change meant an all-defaults deploy got no
// preflight at all, and the submit button had nothing to be gated by.
describe("DynamicForm onChange", () => {
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

  it("emits the initial values once on mount", () => {
    const onChange = vi.fn();
    renderWithIntl(
      <DynamicForm spec={spec} onSubmit={() => {}} onChange={onChange} />,
    );
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ "metadata.name": "nginx" });
  });

  it("keeps emitting on subsequent edits", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithIntl(
      <DynamicForm spec={spec} onSubmit={() => {}} onChange={onChange} />,
    );
    onChange.mockClear();
    await user.type(screen.getByLabelText(/Name/), "x");
    expect(onChange).toHaveBeenLastCalledWith({ "metadata.name": "nginxx" });
  });
});

// #43 — the track was `bg-muted`, which is byte-identical to `--background`,
// so the slider read as a bare thumb floating on nothing. End labels give the
// control a visible extent even before the track contrast lands.
describe("DynamicForm slider affordance", () => {
  const rangeSpec: UISpec = {
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

  it("labels the slider's min and max ends", () => {
    renderWithIntl(<DynamicForm spec={rangeSpec} onSubmit={() => {}} />);
    expect(screen.getByTestId("slider-min")).toHaveTextContent("1");
    expect(screen.getByTestId("slider-max")).toHaveTextContent("10");
  });

  // #113 — the readout used to sit 8px from the max label on the same
  // baseline, so the control read as "1 … 3 1": three numbers with nothing
  // saying which is the scale and which is the answer.
  //
  // Asserted structurally rather than by distance. jsdom has no layout, but
  // more importantly a fix that only widened the gap would come back the
  // moment the row narrowed — the readout has to leave the scale row.
  it("keeps the value readout out of the min/max scale row", () => {
    const { container } = renderWithIntl(
      <DynamicForm spec={rangeSpec} onSubmit={() => {}} />,
    );
    const value = screen.getByTestId("slider-value");
    const max = screen.getByTestId("slider-max");
    expect(value.parentElement).not.toBe(max.parentElement);
    expect(value.parentElement).toContainElement(
      container.querySelector("label"),
    );
  });

  // The worst reading was value == max, which rendered a bare "10 10".
  it("stays unambiguous when the value sits at the max", () => {
    const atMax: UISpec = {
      fields: [
        {
          path: "spec.replicas",
          label: "Replicas",
          type: "integer",
          min: 1,
          max: 10,
          default: 10,
          required: true,
        },
      ],
    };
    renderWithIntl(<DynamicForm spec={atMax} onSubmit={() => {}} />);
    const value = screen.getByTestId("slider-value");
    expect(value).toHaveTextContent("10");
    expect(value.parentElement).not.toBe(
      screen.getByTestId("slider-max").parentElement,
    );
  });

  // Asserted as a whitelist, not as "not bg-muted": the negative form passes
  // for bg-transparent, bg-background, or no class at all — every way of
  // being *more* invisible than the bug it is supposed to guard.
  it("fills the track with a token that clears the background", () => {
    const { container } = renderWithIntl(
      <DynamicForm spec={rangeSpec} onSubmit={() => {}} />,
    );
    const track = container.querySelector('[data-slot="slider-track"]');
    expect(track).not.toBeNull();
    // jsdom has no Tailwind, so the computed color is unavailable here; the
    // real contrast is asserted in tests/e2e/05-user-deploy.spec.ts.
    const ALLOWED = ["bg-slider-track"];
    expect(ALLOWED.some((c) => track!.className.split(/\s+/).includes(c))).toBe(
      true,
    );
  });
});

// #44 — the admin's "user form preview" submits nothing, yet it rendered in the
// primary colour right beside the editor's real save action. The loudest button
// on the screen was the one that does nothing.
describe("DynamicForm submit emphasis", () => {
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", required: true },
    ],
  };

  it("submits in the primary colour by default", () => {
    renderWithIntl(
      <DynamicForm spec={spec} onSubmit={() => {}} submitLabel="Deploy" />,
    );
    expect(screen.getByRole("button", { name: "Deploy" }).className).toContain(
      "bg-primary",
    );
  });

  it("can step back to outline for a preview that deploys nothing", () => {
    renderWithIntl(
      <DynamicForm
        spec={spec}
        onSubmit={() => {}}
        submitLabel="Deploy"
        submitVariant="outline"
      />,
    );
    const button = screen.getByRole("button", { name: "Deploy" });
    expect(button.className).not.toContain("bg-primary");
    expect(button.className).toContain("border");
  });
});

// A quoted segment reaches the deploy form whenever an admin exposes a label
// or annotation. DynamicForm rewrites `.`, `[` and `]` out of RHF field names
// because RHF reads all three as nesting; the quote characters that quoting
// introduces are new to that encoding, so the flat key has to survive them.
describe("DynamicForm quoted path segments", () => {
  const quoted = `Deployment[web].metadata.labels["app.kubernetes.io/name"]`;

  it("submits a quoted path as one flat key", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const spec: UISpec = {
      fields: [{ path: quoted, label: "앱 이름", type: "string", default: "web-app", required: true }],
    };
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Not `{Deployment: {web: {metadata: ...}}}` — the backend looks the whole
    // string up in a flat map.
    expect(Object.keys(onSubmit.mock.calls[0][0])).toEqual([quoted]);
    expect(onSubmit.mock.calls[0][0][quoted]).toBe("web-app");
  });

  it("reports a validation failure against the quoted field", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const spec: UISpec = {
      fields: [{ path: quoted, label: "앱 이름", type: "string", pattern: "^[a-z]+$", required: true }],
    };
    renderWithIntl(<DynamicForm spec={spec} onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/앱 이름/), "NOPE");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));

    // The issue path has to map back to this field's encoded name, or the
    // message renders detached from the input that caused it.
    await waitFor(() => expect(onSubmit).not.toHaveBeenCalled());
    expect(screen.getByLabelText(/앱 이름/)).toHaveAttribute("aria-invalid", "true");
  });
});
