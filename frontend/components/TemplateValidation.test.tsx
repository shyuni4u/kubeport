import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";
import { TemplateValidation } from "./TemplateValidation";

const source = { resourcesYaml: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: example\n", uiSpecYaml: "fields: []" };
afterEach(() => vi.unstubAllGlobals());

describe("TemplateValidation", () => {
  it("validates only on explicit submission and invalidates success when the target changes", async () => {
    const fetcher = vi.fn(async (url: string) => Response.json(url.endsWith("/clusters") ? { clusters: [{ name: "test" }] } : { valid: true }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<TemplateValidation {...source} />);
    expect(fetcher).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "검증 준비 (dry-run)" }));
    const cluster = await screen.findByLabelText("검증 클러스터");
    expect(screen.getByRole("button", { name: "클러스터에서 검증" })).toBeDisabled();
    await user.selectOptions(cluster, "test");
    await user.click(screen.getByRole("button", { name: "클러스터에서 검증" }));
    expect(await screen.findByRole("status")).toHaveTextContent("리소스는 생성되지 않았습니다");
    expect(fetcher).toHaveBeenLastCalledWith("/api/v1/templates/validate", expect.objectContaining({ body: JSON.stringify({ resources_yaml: source.resourcesYaml, ui_spec_yaml: source.uiSpecYaml, values: {}, cluster: "test", namespace: "default", name: "validation" }) }));
    await user.type(screen.getByLabelText("테스트 배포 이름"), "-new");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("discards an in-flight verdict when the draft changes", async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/clusters") ? Promise.resolve(Response.json({ clusters: [{ name: "test" }] })) : new Promise<Response>(resolve => { finish = resolve; })));
    const user = userEvent.setup();
    const { rerender } = render(<TemplateValidation {...source} />);
    await user.click(screen.getByRole("button", { name: "검증 준비 (dry-run)" }));
    await user.selectOptions(await screen.findByLabelText("검증 클러스터"), "test");
    await user.click(screen.getByRole("button", { name: "클러스터에서 검증" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    rerender(<TemplateValidation {...source} resourcesYaml={`${source.resourcesYaml}data: {message: changed}\n`} />);
    finish(Response.json({ valid: true }));
    expect(await screen.findByRole("button", { name: "검증 준비 (dry-run)" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows the cluster refusal instead of a successful result", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/clusters") ? Response.json({ clusters: [{ name: "test" }] }) : Response.json({ title: "validation-error", detail: "Deployment spec.selector is required", status: 400 }, { status: 400 })));
    const user = userEvent.setup();
    render(<TemplateValidation {...source} />);
    await user.click(screen.getByRole("button", { name: "검증 준비 (dry-run)" }));
    await user.selectOptions(await screen.findByLabelText("검증 클러스터"), "test");
    await user.click(screen.getByRole("button", { name: "클러스터에서 검증" }));
    expect(await screen.findByText("Deployment spec.selector is required")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
