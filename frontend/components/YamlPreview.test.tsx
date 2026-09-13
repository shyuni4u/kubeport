import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { ErrorDetailProvider } from "./ErrorDetailProvider";
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

  // #6: the sentence already quotes the detail, so even at "raw" — where
  // ProblemMessage unfolds the server's message — it is not printed twice.
  it("does not repeat the detail at raw, and shows the kind there", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ title: "validation-error", status: 400, detail: "only-once-detail", request_id: "req-raw" }),
        { status: 400 },
      ),
    );

    render(
      <ErrorDetailProvider initial="raw">
        <YamlPreview uiState={uiState} />
      </ErrorDetailProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent?.match(/only-once-detail/g)).toHaveLength(1);
    expect(alert).toHaveTextContent("400 validation-error");
    expect(alert).toHaveTextContent("요청 ID: req-raw");
  });

  // A body that is not a Problem — an HTML 502 from a proxy, an empty
  // response — still has to say something, and it must not be dumped raw.
  it("falls back to the status when the body is not a Problem", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html><body>502 Bad Gateway</body></html>", { status: 502 }),
    );

    render(<YamlPreview uiState={uiState} />);

    // The sentence names the status, and so does the copyable block (#6).
    expect((await screen.findAllByText(/502/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("HTTP 502");
    expect(screen.queryByText(/<html>/)).toBeNull();
  });

  // #332: a new UI-mode template starts with no resources, and the server's
  // answer to an empty ui_state is go-yaml's `expected STREAM-START`. That was
  // the first thing an admin saw on `/templates/new`, before doing anything.
  it("sends nothing and shows an empty-state line when there are no resources", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: 400, detail: "yaml: expected STREAM-START", request_id: "r-1" }), {
        status: 400,
      }),
    );

    render(<YamlPreview uiState={{ resources: [] }} />);
    await new Promise((r) => setTimeout(r, 400)); // past the 300ms debounce

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/리소스를 추가하면/)).toBeInTheDocument();
    expect(screen.queryByText(/STREAM-START/)).toBeNull();
    expect(screen.queryByText(/만들지 못했습니다/)).toBeNull();
  });

  // Back to empty is the same state, and a request still waiting out the
  // debounce for the last resource must not go out after it is gone.
  it("goes back to the empty-state line when the last resource is removed", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ resources_yaml: "kind: ConfigMap\n", ui_spec_yaml: "fields: []\n" }), {
        status: 200,
      }),
    );
    const { rerender } = render(<YamlPreview uiState={uiState} />);
    await waitFor(() => expect(screen.getAllByTestId("monaco")[0]).toHaveTextContent("kind: ConfigMap"));
    const callsBefore = fetchMock.mock.calls.length;

    // An edit that starts a debounced request, then the last resource goes.
    rerender(<YamlPreview uiState={{ resources: [{ ...uiState.resources[0], name: "renamed" }] }} />);
    rerender(<YamlPreview uiState={{ resources: [] }} />);
    await new Promise((r) => setTimeout(r, 400));

    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(screen.getByText(/리소스를 추가하면/)).toBeInTheDocument();
    expect(screen.queryByTestId("monaco")).toBeNull();
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
