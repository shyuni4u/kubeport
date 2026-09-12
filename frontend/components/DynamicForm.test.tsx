import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { DynamicForm } from "./DynamicForm";
import { REDACTED_SECRET, type UISpec } from "@/lib/ui-spec-to-zod";
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

// #196 security review: moving a release to another version cannot carry a
// Secret over. The field must not quietly start from the ui-spec default —
// submitting that would overwrite the running Secret — but empty, required,
// and saying why.
describe("DynamicForm secrets to enter again", () => {
  const path = "Secret[app].stringData.PASSWORD";
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", default: "web" },
      { path, label: "Password", type: "string", default: "changeme" },
    ],
  };

  it("starts the Secret empty, asks for it, and sends what was typed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm spec={spec} reenterSecrets={[path]} onSubmit={onSubmit} />,
    );

    const input = screen.getByLabelText(/Password/) as HTMLInputElement;
    expect(input.value).toBe("");
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("web");
    expect(screen.getByText(ko.form.secretReenter)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("필수 항목입니다.")).toBeInTheDocument();

    await user.type(input, "s3cret");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [path]: "s3cret" }),
    );
  });

  it("keeps the default for a form that is not moving version", () => {
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect((screen.getByLabelText(/Password/) as HTMLInputElement).value).toBe("changeme");
    expect(screen.queryByText(ko.form.secretReenter)).toBeNull();
  });
});

// #288 — an update on the same version starts every Secret field from the
// redacted placeholder. Fed to the typed widget, a Slider showed NaN, a number
// box showed nothing, a Switch showed "on" for a stored false and an enum had
// nothing selected: the value was kept, but nothing said so, and touching the
// widget quietly replaced it.
describe("DynamicForm kept Secrets", () => {
  const S = {
    slots: "Secret[app].stringData.SLOTS",
    port: "Secret[app].stringData.PORT",
    debug: "Secret[app].stringData.DEBUG",
    mode: "Secret[app].stringData.MODE",
    token: "Secret[app].stringData.TOKEN",
  };
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", default: "web" },
      { path: S.slots, label: "Slots", type: "integer", min: 1, max: 10, default: 3 },
      { path: S.port, label: "Port", type: "integer", default: 80 },
      { path: S.debug, label: "Debug", type: "boolean", default: true },
      { path: S.mode, label: "Mode", type: "enum", values: ["fast", "safe"], default: "fast" },
      { path: S.token, label: "Token", type: "string", default: "changeme" },
    ],
  };
  const kept = {
    "metadata.name": "web",
    [S.slots]: REDACTED_SECRET,
    [S.port]: REDACTED_SECRET,
    [S.debug]: REDACTED_SECRET,
    [S.mode]: REDACTED_SECRET,
    [S.token]: REDACTED_SECRET,
  };
  const t = ko.form.secretKept;

  it("shows every kept Secret as kept instead of a widget guessing at the placeholder", () => {
    const { container } = renderWithIntl(
      <DynamicForm spec={spec} initialValues={kept} onSubmit={() => {}} />,
    );
    expect(screen.getAllByText(t.status)).toHaveLength(5);
    expect(container.querySelector('[data-slot="slider"]')).toBeNull();
    expect(screen.queryByTestId("slider-value")).toBeNull();
    expect(screen.queryByText("NaN")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "fast" })).toBeNull();
    expect(screen.queryByDisplayValue(REDACTED_SECRET)).toBeNull();
    for (const label of ["Slots", "Port", "Debug", "Mode", "Token"]) {
      expect(
        screen.getByRole("button", { name: t.replaceAria.replace("{label}", label) }),
      ).toBeInTheDocument();
    }
    // The non-Secret field is untouched.
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("web");
  });

  it("describes the replace button with the kept state", () => {
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={() => {}} />);
    const button = screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Port") });
    expect(button).toHaveAccessibleDescription(expect.stringContaining(t.status));
  });

  it("submits the placeholder for every Secret left alone", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(kept));
  });

  it("swaps in an empty number box on request, focused, and submits what is typed", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Port") }));

    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
    expect(screen.getAllByText(t.status)).toHaveLength(4);

    await user.type(input, "8080");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ ...kept, [S.port]: 8080 }));
  });

  // codex review: the number box's empty is null for a kept field, and
  // `z.coerce.number()` read null as 0 — an untouched or cleared replacement
  // went out as 0 over the running Secret.
  it("refuses an untouched or cleared number box instead of sending 0", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Port") }));

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();

    const input = screen.getByRole("spinbutton");
    await user.type(input, "5");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton")).toHaveValue(null);
  });

  // A Slider has no empty state, so it starts at its minimum — a bound, not the
  // ui-spec default — and the readout on the label row prints that exact number
  // before anything is sent. It can never be cleared.
  it("starts a replaced Slider at its minimum, shows it, and sends exactly that", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Slots") }));
    expect(screen.getByTestId("slider-value")).toHaveTextContent("1");
    expect(screen.queryByText("NaN")).toBeNull();
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ ...kept, [S.slots]: 1 }));
  });

  // A Switch has no empty state either. It starts off, focused, and off is
  // what it sends — the visibly shown value, not a ui-spec default (the spec
  // here defaults to true). Security review judged that acceptable.
  it("starts a replaced Switch off, shows it, and sends exactly that", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Debug") }));
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveFocus();
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ ...kept, [S.debug]: false }));
  });

  it("sends true once a replaced Switch is turned on", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Debug") }));
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ ...kept, [S.debug]: true }));
  });

  it("refuses an enum replacement that was picked and then unpicked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Mode") }));
    const safe = screen.getByRole("button", { name: "safe" });
    await user.click(safe);
    await user.click(safe);
    expect(safe).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("refuses a string replacement that was typed and then cleared", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Token") }));
    const input = screen.getByRole("textbox", { name: /^Token/ });
    await user.type(input, "abc");
    await user.clear(input);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
    // Cleared stays a replacement; going back to kept is the explicit button.
    expect(screen.getByRole("textbox", { name: /^Token/ })).toBeInTheDocument();
  });

  it("requires a choice for a replaced enum instead of falling back to a default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Mode") }));
    expect(screen.getByRole("button", { name: "fast" })).toHaveAttribute("aria-pressed", "false");

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "safe" }));
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ ...kept, [S.mode]: "safe" }));
  });

  // Emptying the box does not flip it back to "kept": that would yank the
  // input away mid-edit. An empty replacement is refused instead — sent, it
  // would reach the backend as a missing value and be filled from the ui-spec
  // default — and going back is an explicit button.
  it("refuses an emptied replacement, and goes back to kept only when asked", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={spec} initialValues={kept} onSubmit={onSubmit} />);
    await user.click(screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Token") }));

    const input = screen.getByRole("textbox", { name: /^Token/ }) as HTMLInputElement;
    expect(input.value).toBe("");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Token/ })).toBeInTheDocument();

    const keep = screen.getByRole("button", { name: t.keepAria.replace("{label}", "Token") });
    await user.click(keep);
    expect(screen.getAllByText(t.status)).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: t.replaceAria.replace("{label}", "Token") }),
    ).toHaveFocus();

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(kept));
  });

  it("leaves a placeholder outside a Secret to its ordinary widget", () => {
    renderWithIntl(
      <DynamicForm
        spec={spec}
        initialValues={{ ...kept, "metadata.name": REDACTED_SECRET }}
        onSubmit={() => {}}
      />,
    );
    expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe(REDACTED_SECRET);
  });

  it("does not show the kept state on a form that did not start from a release", () => {
    renderWithIntl(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.queryByText(t.status)).toBeNull();
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getByTestId("slider-value")).toHaveTextContent("3");
  });
});

// #309 — an update form starts from the release's stored values. Where those
// held null (or "") for an integer, `z.coerce.number()` read it as 0 and the
// update sent `0` for a field the user never touched and could not see.
describe("DynamicForm stored empty integers", () => {
  const port = "Deployment[web].spec.template.spec.containers[0].ports[0].containerPort";
  const replicas = "Deployment[web].spec.replicas";
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", default: "web" },
      { path: port, label: "Port", type: "integer", required: true },
      { path: replicas, label: "Replicas", type: "integer", min: 0, max: 5, required: true },
    ],
  };

  for (const stored of [null, ""]) {
    it(`shows a required number box stored as ${JSON.stringify(stored)} empty and refuses it`, async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithIntl(
        <DynamicForm
          spec={spec}
          initialValues={{ "metadata.name": "web", [port]: stored, [replicas]: 2 }}
          submitLabel="업데이트"
          onSubmit={onSubmit}
        />,
      );
      const input = screen.getByRole("spinbutton", { name: /Port/ });
      expect(input).toHaveValue(null);

      await user.click(screen.getByRole("button", { name: "업데이트" }));
      await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
      expect(onSubmit).not.toHaveBeenCalled();
      expect(input).toHaveAttribute("aria-invalid", "true");

      await user.type(input, "8080");
      await user.click(screen.getByRole("button", { name: "업데이트" }));
      await waitFor(() =>
        expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [port]: 8080, [replicas]: 2 }),
      );
    });
  }

  // A Slider has no empty state; stored null reads the same as no value at
  // all, which is how a required slider without a default already behaves.
  it("refuses a required slider stored as null rather than sending 0", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm
        spec={spec}
        initialValues={{ "metadata.name": "web", [port]: 80, [replicas]: null }}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves an optional integer stored as null out of the submitted values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const optional: UISpec = {
      fields: [
        { path: "metadata.name", label: "Name", type: "string", default: "web" },
        { path: port, label: "Port", type: "integer", default: 80 },
      ],
    };
    renderWithIntl(
      <DynamicForm spec={optional} initialValues={{ "metadata.name": "web", [port]: null }} onSubmit={onSubmit} />,
    );
    expect(screen.getByRole("spinbutton", { name: /Port/ })).toHaveValue(null);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const sent = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(sent[port]).toBeUndefined();
    // What DeployClient puts on the wire: the key is gone, not 0 or null.
    expect(JSON.parse(JSON.stringify({ values: sent }))).toEqual({ values: { "metadata.name": "web" } });
  });
});

// #316 — the same stored-values path for the other types. A null stored for an
// optional string, autocomplete, boolean or enum failed `.optional()`, which
// lets only undefined through, and the form said "required" on a field that is
// not: the update could not be sent although nobody touched it.
describe("DynamicForm stored null in optional fields", () => {
  const team = "Deployment[web].metadata.labels.team";
  const image = "Deployment[web].spec.template.spec.containers[0].image";
  const debug = "ConfigMap[app].data.DEBUG";
  const mode = "ConfigMap[app].data.MODE";
  const tier = "ConfigMap[app].data.TIER";
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", required: true },
      { path: team, label: "Team", type: "string", default: "core" },
      { path: image, label: "Image", type: "autocomplete", values: ["nginx:1.27"] },
      { path: debug, label: "Debug", type: "boolean", default: true },
      // Two values: a ToggleGroup. Five: a Select.
      { path: mode, label: "Mode", type: "enum", values: ["fast", "safe"] },
      { path: tier, label: "Tier", type: "enum", values: ["a", "b", "c", "d", "e"] },
    ],
  };
  const stored = {
    "metadata.name": "web",
    [team]: null,
    [image]: null,
    [debug]: null,
    [mode]: null,
    [tier]: null,
  };

  it("shows each stored null as empty and sends the update without those keys", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm spec={spec} initialValues={stored} submitLabel="업데이트" onSubmit={onSubmit} />,
    );
    // Empty, not the ui-spec default: the default is not what the release
    // holds, and showing it would claim a value nobody picked.
    expect(screen.getByLabelText(/Team/)).toHaveValue("");
    expect(screen.getByLabelText(/Image/)).toHaveValue("");
    expect(screen.getByRole("switch")).not.toBeChecked();
    for (const v of ["fast", "safe"]) {
      expect(screen.getByRole("button", { name: v })).toHaveAttribute("aria-pressed", "false");
    }
    // By label: the autocomplete's <input list> is a combobox too. The trigger
    // holds a chevron icon, so look for a selected value, not for no text.
    expect(screen.getByLabelText(/Tier/).textContent?.replace(/[^A-Za-z0-9]/g, "")).toBe("");

    await user.click(screen.getByRole("button", { name: "업데이트" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(ko.form.validation.required)).toBeNull();
    const sent = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    // Shown off is not sent as false: an untouched switch sends nothing.
    for (const path of [team, image, debug, mode, tier]) {
      expect(sent[path], path).toBeUndefined();
    }
    // What DeployClient puts on the wire: the keys are gone, not null.
    expect(JSON.parse(JSON.stringify({ values: sent }))).toEqual({ values: { "metadata.name": "web" } });
  });

  it("sends what the user picks over a stored null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm spec={spec} initialValues={stored} submitLabel="업데이트" onSubmit={onSubmit} />,
    );
    await user.click(screen.getByRole("switch"));
    await user.click(screen.getByRole("button", { name: "safe" }));
    await user.type(screen.getByLabelText(/Team/), "platform");
    await user.click(screen.getByRole("button", { name: "업데이트" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(JSON.parse(JSON.stringify(onSubmit.mock.calls[0][0]))).toEqual({
      "metadata.name": "web",
      [team]: "platform",
      [debug]: true,
      [mode]: "safe",
    });
  });

  it("still refuses a required string, boolean and enum stored as null", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const required: UISpec = {
      fields: [
        { path: team, label: "Team", type: "string", required: true },
        { path: debug, label: "Debug", type: "boolean", required: true },
        { path: mode, label: "Mode", type: "enum", values: ["fast", "safe"], required: true },
      ],
    };
    renderWithIntl(
      <DynamicForm
        spec={required}
        initialValues={{ [team]: null, [debug]: null, [mode]: null }}
        submitLabel="업데이트"
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole("button", { name: "업데이트" }));
    await waitFor(() => expect(screen.getAllByText(ko.form.validation.required)).toHaveLength(3));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// #321 — clearing a number box stored `undefined`, and react-hook-form reads an
// undefined field back from its default values. The ui-spec default came back
// into the box the moment it was emptied, so typing appended to it: default 3,
// clear, type 5, and the form held 35 — deployable, if 35 was in range.
describe("DynamicForm clearing a number box that has a default", () => {
  const port = "Deployment[web].spec.template.spec.containers[0].ports[0].containerPort";
  const specWith = (required: boolean): UISpec => ({
    fields: [
      { path: "metadata.name", label: "Name", type: "string", default: "web" },
      { path: port, label: "Port", type: "integer", default: 3, required },
    ],
  });
  const box = () => screen.getByRole("spinbutton", { name: /Port/ }) as HTMLInputElement;

  it("starts a new deploy on the default", () => {
    renderWithIntl(<DynamicForm spec={specWith(true)} onSubmit={() => {}} />);
    expect(box()).toHaveValue(3);
  });

  it("stays empty once cleared, and sends what is typed next instead of appending to the default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const ui = <DynamicForm spec={specWith(true)} onSubmit={onSubmit} />;
    const { rerender } = renderWithIntl(ui);

    await user.clear(box());
    expect(box()).toHaveValue(null);
    expect(box().value).toBe("");
    // Neither a re-render nor leaving the box brings the default back.
    rerender(
      <NextIntlClientProvider locale="ko" messages={ko}>
        {ui}
      </NextIntlClientProvider>,
    );
    await user.tab();
    expect(box()).toHaveValue(null);

    await user.type(box(), "5");
    expect(box()).toHaveValue(5);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [port]: 5 }));
  });

  it("refuses a required box left empty, and the preview hears it does not parse", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onParsedChange = vi.fn();
    renderWithIntl(
      <DynamicForm spec={specWith(true)} onSubmit={onSubmit} onParsedChange={onParsedChange} />,
    );
    expect(onParsedChange).toHaveBeenLastCalledWith({
      success: true,
      values: { "metadata.name": "web", [port]: 3 },
    });

    await user.clear(box());
    expect(onParsedChange).toHaveBeenLastCalledWith({ success: false });

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(screen.getByText(ko.form.validation.required)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(box()).toHaveValue(null);
  });

  it("leaves an optional box left empty out of the submit and the preview", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onParsedChange = vi.fn();
    renderWithIntl(
      <DynamicForm spec={specWith(false)} onSubmit={onSubmit} onParsedChange={onParsedChange} />,
    );
    await user.clear(box());

    const parsed = onParsedChange.mock.calls.at(-1)?.[0];
    expect(parsed.success).toBe(true);
    expect(JSON.parse(JSON.stringify(parsed.values))).toEqual({ "metadata.name": "web" });

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(ko.form.validation.required)).toBeNull();
    const sent = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(sent[port]).toBeUndefined();
    expect(JSON.parse(JSON.stringify({ values: sent }))).toEqual({ values: { "metadata.name": "web" } });
    expect(box()).toHaveValue(null);
  });

  it("keeps a typed 0 as 0", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={specWith(true)} onSubmit={onSubmit} />);
    await user.clear(box());
    await user.type(box(), "0");
    expect(box()).toHaveValue(0);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [port]: 0 }));
  });

  it("takes a negative number typed into the cleared box", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(<DynamicForm spec={specWith(true)} onSubmit={onSubmit} />);
    await user.clear(box());
    await user.type(box(), "-5");
    expect(box()).toHaveValue(-5);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [port]: -5 }));
  });

  it("starts an update on the release's value, and clears to empty, not to the default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm
        spec={specWith(true)}
        initialValues={{ "metadata.name": "web", [port]: 8080 }}
        submitLabel="업데이트"
        onSubmit={onSubmit}
      />,
    );
    expect(box()).toHaveValue(8080);
    await user.clear(box());
    expect(box()).toHaveValue(null);
    await user.type(box(), "81");
    expect(box()).toHaveValue(81);
    await user.click(screen.getByRole("button", { name: "업데이트" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "web", [port]: 81 }));
  });

  it("behaves the same for a box with no default", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const noDefault: UISpec = { fields: [{ path: port, label: "Port", type: "integer", required: true }] };
    renderWithIntl(<DynamicForm spec={noDefault} onSubmit={onSubmit} />);
    expect(box()).toHaveValue(null);
    await user.type(box(), "12");
    await user.clear(box());
    expect(box()).toHaveValue(null);
    await user.type(box(), "5");
    expect(box()).toHaveValue(5);
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ [port]: 5 }));
  });

  // A text box's empty is "", which react-hook-form keeps as a value.
  it("keeps a cleared text box with a default empty too", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const text: UISpec = { fields: [{ path: "metadata.name", label: "Name", type: "string", default: "web" }] };
    renderWithIntl(<DynamicForm spec={text} onSubmit={onSubmit} />);
    const input = screen.getByRole("textbox", { name: /Name/ });
    await user.clear(input);
    await user.tab();
    expect(input).toHaveValue("");
    await user.type(input, "api");
    expect(input).toHaveValue("api");
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ "metadata.name": "api" }));
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

// #319 — the deploy form previewed the raw values while submit sent the parsed
// ones, so a stored null went to the render API, which refused it.
describe("DynamicForm onParsedChange", () => {
  const spec: UISpec = {
    fields: [
      { path: "metadata.name", label: "Name", type: "string", required: true },
      { path: "metadata.labels.tier", label: "Tier", type: "string" },
      { path: "Secret[app].stringData.password", label: "Password", type: "string" },
    ],
  };

  it("leaves a stored null on an optional field out, as submit does", () => {
    const onChange = vi.fn();
    const onParsedChange = vi.fn();
    renderWithIntl(
      <DynamicForm
        spec={spec}
        initialValues={{ "metadata.name": "web", "metadata.labels.tier": null }}
        onSubmit={() => {}}
        onChange={onChange}
        onParsedChange={onParsedChange}
      />,
    );
    // The raw values still carry it; only the parsed ones drop it.
    expect(onChange).toHaveBeenLastCalledWith({ "metadata.name": "web", "metadata.labels.tier": null });
    const last = onParsedChange.mock.calls.at(-1)?.[0];
    expect(last.success).toBe(true);
    expect(JSON.stringify(last.values)).toBe(JSON.stringify({ "metadata.name": "web" }));
  });

  it("reports a stored null on a required field as not parsing, until it is filled", async () => {
    const user = userEvent.setup();
    const onParsedChange = vi.fn();
    renderWithIntl(
      <DynamicForm
        spec={spec}
        initialValues={{ "metadata.name": null }}
        onSubmit={() => {}}
        onParsedChange={onParsedChange}
      />,
    );
    expect(onParsedChange).toHaveBeenLastCalledWith({ success: false });

    await user.type(screen.getByLabelText(/Name/), "web");
    expect(onParsedChange).toHaveBeenLastCalledWith({
      success: true,
      values: { "metadata.name": "web" },
    });
  });

  it("parses a kept Secret's placeholder to exactly what submit sends", async () => {
    const user = userEvent.setup();
    const onParsedChange = vi.fn();
    const onSubmit = vi.fn();
    renderWithIntl(
      <DynamicForm
        spec={spec}
        initialValues={{ "metadata.name": "web", "Secret[app].stringData.password": REDACTED_SECRET }}
        onSubmit={onSubmit}
        onParsedChange={onParsedChange}
      />,
    );
    const parsed = onParsedChange.mock.calls.at(-1)?.[0];
    expect(parsed).toEqual({
      success: true,
      values: { "metadata.name": "web", "Secret[app].stringData.password": REDACTED_SECRET },
    });

    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(onSubmit.mock.calls[0][0])).toBe(JSON.stringify(parsed.values));
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
