import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import ko from "@/messages/ko.json";
import { LandingCompare } from "./LandingCompare";

const dir = path.resolve(__dirname, "../lib/showcase");
const resourcesYaml = readFileSync(path.join(dir, "web-app.resources.yaml"), "utf8").replaceAll("\r\n", "\n");
const uiSpecYaml = readFileSync(path.join(dir, "web-app.ui-spec.yaml"), "utf8").replaceAll("\r\n", "\n");

function renderCompare() {
  return render(
    <NextIntlClientProvider locale="ko" messages={ko}>
      <LandingCompare resourcesYaml={resourcesYaml} uiSpecYaml={uiSpecYaml} />
    </NextIntlClientProvider>,
  );
}

describe("LandingCompare", () => {
  it("shows the full admin YAML with a line-count badge and the user form with an input-count badge", () => {
    renderCompare();
    const pre = screen.getByTestId("landing-yaml");
    expect(pre.textContent).toContain("kind: Deployment");
    expect(pre.textContent).toContain("kind: ConfigMap");
    // badge reflects the fixture's real line count
    const lineCount = resourcesYaml.replace(/\n$/, "").split("\n").length;
    expect(screen.getByText(`YAML ${lineCount}줄`)).toBeInTheDocument();
    expect(screen.getByText(/입력 4개/)).toBeInTheDocument();
    expect(screen.getByText("환영 문구")).toBeInTheDocument();
    expect(screen.getByText("동시에 띄울 개수")).toBeInTheDocument();
    // deploy button is a preview only
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeDisabled();
  });

  it("renders a (?) help affordance for every field and for each pane heading", () => {
    renderCompare();
    const hints = screen.getAllByRole("button", { name: "도움말" });
    const fieldCount = (uiSpecYaml.match(/^\s+- path:/gm) ?? []).length;
    // one per field + 2 pane titles + 2 badges
    expect(hints).toHaveLength(fieldCount + 4);
    // the hint must not leak into the input's accessible name
    expect(screen.getByRole("textbox", { name: "환영 문구" })).toBeInTheDocument();
  });

  it("rewrites the YAML and highlights the changed line when a form value changes", async () => {
    const user = userEvent.setup();
    renderCompare();
    const pre = screen.getByTestId("landing-yaml");
    expect(within(pre).queryAllByTitle("방금 바뀐 줄")).toHaveLength(0);

    const input = screen.getByRole("textbox", { name: /환영 문구/ });
    await user.clear(input);
    await user.type(input, "안녕 kubeport");

    expect(pre.textContent).toContain('value: "안녕 kubeport"');
    expect(pre.textContent).not.toContain("Hello from kubeport");
    const changed = within(pre).getAllByTitle("방금 바뀐 줄");
    expect(changed).toHaveLength(1);
    expect(changed[0].textContent).toContain("value:");
  });
});
