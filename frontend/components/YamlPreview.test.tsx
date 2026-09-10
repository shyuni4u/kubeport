import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { YamlPreview } from "./YamlPreview";

vi.mock("./MonacoPanel", () => ({
  MonacoPanel: ({ value }: { value: string }) => <pre data-testid="monaco">{value}</pre>,
}));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const uiState = {
  resources: [{ apiVersion: "v1", kind: "ConfigMap", name: "web-config", fields: {} }],
};

// #129's side note: the preview pane printed `${status}: ${await res.text()}`,
// so a failed preview arrived as the whole Problem document — `type`,
// `status`, `request_id` and all — as one unparsed line of JSON. The admin is
// the audience here and #6 says they get the original wording, but the
// original wording is `detail`; the envelope around it is for machines and it
// buried the one sentence that says what is wrong.
describe("YamlPreview when the preview is refused", () => {
  it("shows the Problem's detail rather than the whole document", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "https://kubeport.io/errors/validation-error",
          title: "validation-error",
          status: 400,
          detail: `resource ConfigMap/web-config field "metadata.labels.x": bad path remainder`,
          request_id: "f8764b47-ee87-409c-9984-93394541df2e",
        }),
        { status: 400, headers: { "content-type": "application/problem+json" } },
      ),
    );

    render(<YamlPreview uiState={uiState} />);

    expect(await screen.findByText(/bad path remainder/)).toBeInTheDocument();
    expect(screen.queryByText(/kubeport\.io\/errors/)).toBeNull();
    expect(screen.queryByText(/"title"/)).toBeNull();
  });

  // The id is the only route to the server-side reason, so it stays — just not
  // in the middle of the sentence.
  it("keeps the request id on its own line", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ title: "internal", status: 500, detail: "boom", request_id: "req-77" }),
        { status: 500 },
      ),
    );

    render(<YamlPreview uiState={uiState} />);

    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.getByText(/req-77/)).toBeInTheDocument();
  });

  // A body that is not a Problem — an HTML 502 from a proxy, an empty
  // response — still has to say something, and it must not be dumped raw.
  it("falls back to the status when the body is not a Problem", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );

    render(<YamlPreview uiState={uiState} />);

    expect(await screen.findByText(/502/)).toBeInTheDocument();
    expect(screen.queryByText(/<html>/)).toBeNull();
  });

  it("clears the error once a later preview succeeds", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: "internal", status: 500, detail: "boom" }), { status: 500 }),
    );
    const { rerender } = render(<YamlPreview uiState={uiState} />);
    expect(await screen.findByText(/boom/)).toBeInTheDocument();

    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ resources_yaml: "kind: ConfigMap\n", ui_spec_yaml: "fields: []\n" }), {
        status: 200,
      }),
    );
    rerender(<YamlPreview uiState={{ resources: [...uiState.resources] }} />);

    await waitFor(() => expect(screen.queryByText(/boom/)).toBeNull());
  });
});
