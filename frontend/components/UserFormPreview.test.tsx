import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { UserFormPreview } from "./UserFormPreview";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const oneResource = {
  resources: [{ apiVersion: "v1", kind: "ConfigMap", name: "web-config", fields: {} }],
};

// #332, the form tab of the same preview: with no resources the UI-mode
// preview used to POST an empty ui_state and print the refusal — the whole
// Problem body, go-yaml's `expected STREAM-START` inside it — on the first
// screen of a new template.
describe("UserFormPreview in UI mode with no resources", () => {
  it("sends nothing and shows an empty-state line", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 400, detail: "yaml: expected STREAM-START" }), { status: 400 }),
    );

    render(<UserFormPreview uiState={{ resources: [] }} />);
    await new Promise((r) => setTimeout(r, 400)); // past the 300ms debounce

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/리소스를 추가하면/)).toBeInTheDocument();
    expect(screen.queryByText(/STREAM-START/)).toBeNull();
    expect(screen.queryByText(/실패했습니다/)).toBeNull();
  });

  it("goes back to the empty-state line when the last resource is removed", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ resources_yaml: "kind: ConfigMap\n", ui_spec_yaml: "fields: []\n" }), {
        status: 200,
      }),
    );
    const { rerender } = render(<UserFormPreview uiState={oneResource} />);
    expect(await screen.findByText(/노출된 필드가 없습니다/)).toBeInTheDocument();
    const callsBefore = fetchMock.mock.calls.length;

    rerender(<UserFormPreview uiState={{ resources: [{ ...oneResource.resources[0], name: "renamed" }] }} />);
    rerender(<UserFormPreview uiState={{ resources: [] }} />);
    await new Promise((r) => setTimeout(r, 400));

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(screen.getByText(/리소스를 추가하면/)).toBeInTheDocument();
  });

  // The guard is for the empty case only: a template with a resource still
  // round-trips through the server as before.
  it("still asks the server once there is a resource", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ resources_yaml: "kind: ConfigMap\n", ui_spec_yaml: "fields: []\n" }), {
        status: 200,
      }),
    );

    render(<UserFormPreview uiState={oneResource} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/리소스를 추가하면/)).toBeNull();
  });
});
