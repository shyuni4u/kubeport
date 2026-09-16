import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { CatalogBrowser } from "./CatalogBrowser";
import { DynamicForm } from "./DynamicForm";
import { LogsPanel } from "./LogsPanel";
import ko from "@/messages/ko.json";
import en from "@/messages/en.json";

describe.each([
  ["ko", ko, "동시에 띄울 개수", "로그 인스턴스 선택"],
  ["en", en, "Replica count", "Select log instance"],
] as const)("accessible controls (%s)", (locale, messages, label, logLabel) => {
  function mount(children: React.ReactNode) {
    return render(<NextIntlClientProvider locale={locale} messages={messages}>{children}</NextIntlClientProvider>);
  }

  it("names search after typing and keeps filtering", async () => {
    mount(<CatalogBrowser templates={[
      { name: "web", display_name: "Web", current_version: 1, tags: [], description: "" },
      { name: "db", display_name: "Database", current_version: 1, tags: [], description: "" },
    ]} />);
    const input = screen.getByRole("textbox", { name: messages.catalog.searchPlaceholder });
    await userEvent.type(input, "web");
    expect(input).toHaveAccessibleName(messages.catalog.searchPlaceholder);
    expect(screen.queryByText("Database")).not.toBeInTheDocument();
  });

  it("names the log selector independently of its selected value", async () => {
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} });
    try {
      mount(<LogsPanel releaseId="fixture" instances={[{ name: "p1" }]} />);
      const trigger = screen.getByRole("combobox", { name: logLabel });
      await userEvent.click(trigger);
      await userEvent.click(screen.getByRole("option", { name: "p1" }));
      expect(trigger).toHaveAccessibleName(logLabel);
      expect(trigger).toHaveTextContent("p1");
    } finally { vi.unstubAllGlobals(); }
  });

  it("connects range name, description and validation; keeps keyboard changes", async () => {
    const onSubmit = vi.fn();
    mount(<DynamicForm spec={{ fields: [{ path: "replicas", type: "integer", label,
      help: "Instances to run", min: 1, max: 10, default: 3, required: true,
    }] }} submitLabel={messages.deploy.submit} initialValues={{ replicas: 20 }} onSubmit={onSubmit} />);
    // jsdom has no layout; Base UI hides the thumb until it can measure it.
    const thumb = document.querySelector<HTMLElement>('[data-slot="slider-thumb"]')!;
    thumb.style.visibility = "visible";
    const slider = screen.getByRole("slider", { name: new RegExp(label) });
    expect(slider).toHaveAccessibleDescription("Instances to run");
    await userEvent.click(screen.getByRole("button", { name: messages.deploy.submit }));
    await waitFor(() => expect(slider).toHaveAttribute("aria-invalid", "true"));
    const descriptions = slider.getAttribute("aria-describedby")!.split(" ");
    expect(descriptions).toHaveLength(2);
    descriptions.forEach(id => expect(document.getElementById(id)).not.toBeNull());
    act(() => slider.focus());
    await userEvent.keyboard("{Home}{ArrowRight}");
    expect(slider).toHaveValue("2");
    await userEvent.click(screen.getByRole("button", { name: messages.deploy.submit }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ replicas: 2 }));
    expect(slider).not.toHaveAttribute("aria-invalid", "true");
  });
});
