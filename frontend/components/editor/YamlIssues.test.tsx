import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

import en from "@/messages/en.json";
import ko from "@/messages/ko.json";
import { validateTemplateYaml, YAML_ISSUE_CODES } from "@/lib/yaml-validation";
import { YamlIssueList, useSaveBlockedReason } from "./YamlIssues";

const RESOURCES = "apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: api }\nspec:\n  replicas: 1\n";
const UISPEC = "fields:\n  - path: Deployment[web].spec.replicas\n    label: Replicas\n    type: integer\n";

function Reason({ resources, uiSpec }: { resources: string; uiSpec: string }) {
  const reason = useSaveBlockedReason();
  return <p>{reason(validateTemplateYaml(resources, uiSpec)) ?? "none"}</p>;
}

describe("validation messages", () => {
  it.each([
    ["ko", ko],
    ["en", en],
  ])("%s has a sentence for every issue code", (_locale, messages) => {
    const v = (messages as { templates: { editor: { validation: Record<string, string> } } }).templates.editor
      .validation;
    for (const key of [...YAML_ISSUE_CODES, "summary", "error", "warning", "location", "more", "saveBlocked"]) {
      expect(v[key], key).toEqual(expect.any(String));
    }
  });
});

describe("YamlIssueList", () => {
  it("renders nothing when there is nothing wrong", () => {
    const { container } = render(
      <NextIntlClientProvider locale="ko" messages={ko}>
        <YamlIssueList validation={{ resources: [], uiSpec: [] }} />
      </NextIntlClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists a renamed resource as a warning, with file and line", () => {
    render(
      <NextIntlClientProvider locale="ko" messages={ko}>
        <YamlIssueList validation={validateTemplateYaml(RESOURCES, UISPEC)} />
      </NextIntlClientProvider>,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("오류 0건, 경고 1건");
    expect(status).toHaveTextContent("경고 ui-spec.yaml 2행");
    expect(status).toHaveTextContent('resources.yaml 에 이름이 "web" 인 Deployment 가 없습니다.');
  });
});

describe("useSaveBlockedReason", () => {
  it("names the first error's file and line", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Reason resources={"a: [1, 2\nb: 3\n"} uiSpec="" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText(/^Fix 1 error\(s\) to save\. resources\.yaml line \d+: YAML syntax error:/)).toBeInTheDocument();
  });

  it("does not block on warnings alone", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <Reason resources={RESOURCES} uiSpec={UISPEC} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByText("none")).toBeInTheDocument();
  });
});
