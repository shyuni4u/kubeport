import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { CLUSTER_CHANGED_EVENT } from "@/components/ClusterPicker";
import { ErrorDetailProvider } from "@/components/ErrorDetailProvider";
import type { ErrorDetailLevel } from "@/lib/error-detail";

import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";
import type { ReleaseNameRules } from "@/lib/release-name";

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: vi.fn() }),
}));

const spec: UISpec = {
  fields: [
    {
      path: "spec.replicas",
      label: "Replicas",
      type: "integer",
      min: 1,
      max: 5,
      default: 1,
      required: true,
    },
    // A typeable field, so tests can exercise the DynamicForm onChange path
    // and not just the meta inputs.
    {
      path: "metadata.name",
      label: "앱 이름",
      type: "string",
      default: "nginx",
      required: true,
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * The deploy form talks to four endpoints. Each test only cares about one or
 * two of them, so route by URL and let the rest answer with a benign default.
 */
function routedFetch(overrides: {
  ssar?: (body: Record<string, unknown>) => Response;
  releases?: () => Response;
  render?: () => Response;
  clusters?: Array<{ name: string; default_namespace?: string | null }>;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/clusters") {
      return jsonResponse({ clusters: overrides.clusters ?? [{ name: "dev" }] });
    }
    if (url.includes("/render")) {
      if (overrides.render) return overrides.render();
      return jsonResponse({
        rendered_yaml: "apiVersion: apps/v1\nkind: Deployment\n",
      });
    }
    if (url === "/api/v1/selfsubjectaccessreview") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      return overrides.ssar
        ? overrides.ssar(body)
        : jsonResponse({ allowed: true, reason: "" });
    }
    if (url === "/api/v1/releases") {
      return overrides.releases
        ? overrides.releases()
        : jsonResponse({ id: "rel-1" }, 201);
    }
    return jsonResponse({}, 404);
  });
}

async function fillMeta(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("배포 이름"), "my-app");
  // The namespace no longer starts on a hard-coded "default" (#179), so fill
  // it the way a user would.
  await user.clear(screen.getByLabelText("구역"));
  await user.type(screen.getByLabelText("구역"), "default");
}

describe("DeployClient", () => {
  beforeEach(() => {
    pushMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // #30 — a denied preflight used to leave the button an active indigo
  // primary, so users clicked into a guaranteed failure.
  it("blocks submission while RBAC reports a denial", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        ssar: () => jsonResponse({ allowed: false, reason: "forbidden" }),
      }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    // Wait on the *parent's* output, not the panel's row. RBACCheckPanel
    // renders "권한이 거부되었습니다" from its own state and reports the verdict
    // upward from a separate effect, so the button is still enabled for one
    // commit after that row appears. Waiting on the row and then asserting the
    // button synchronously is a race, and CI lost it.
    await waitFor(() => {
      expect(
        screen.getByText(
          "권한이 없어 지금은 배포할 수 없습니다. '권한 확인' 안내를 확인한 뒤 관리자에게 요청하세요.",
        ),
      ).toBeInTheDocument();
    });

    expect(screen.getAllByText(/만들 권한이 없습니다/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeDisabled();
  });

  it("keeps submission enabled when RBAC allows everything", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch({}));

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText("위 목록을 모두 만들 수 있습니다.")).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
  });

  // A failed preflight is not a denial — the user must still be able to try.
  it("does not block submission when the RBAC check itself fails", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ ssar: () => jsonResponse({}, 500) }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
  });

  // #42 — the red failure notice survived every subsequent edit, so a user
  // who fixed the offending value still saw "배포에 실패했습니다".
  it("clears a previous failure when the user edits the metadata", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ releases: () => jsonResponse({ message: "boom" }, 502) }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: /배포하기/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/서버에서 문제가 발생해/);

    await user.type(screen.getByLabelText("구역"), "-demo");

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // #6: a cluster's verdict arrives as 502 k8s-error. It was told as "something
  // went wrong on the server", and its reason was thrown away with the body.
  describe("a cluster that refuses the deploy (#6)", () => {
    const forbidden = {
      type: "https://kubeport.io/errors/k8s-error",
      title: "k8s-error",
      status: 502,
      detail: 'deployments.apps is forbidden: User "u@example.com" cannot create resource "deployments" in the namespace "default"',
      request_id: "req-cluster-9",
    };

    async function submitRefused(level?: ErrorDetailLevel) {
      const user = userEvent.setup();
      vi.stubGlobal("fetch", routedFetch({ releases: () => jsonResponse(forbidden, 502) }));
      const form = <DeployClient templateName="web-app" version={3} team={null} spec={spec} />;
      render(level ? <ErrorDetailProvider initial={level}>{form}</ErrorDetailProvider> : form);
      await fillMeta(user);
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
      });
      await user.click(screen.getByRole("button", { name: /배포하기/ }));
      return screen.findByRole("alert");
    }

    it("says the cluster refused, with the block to send an admin, and no raw message at friendly", async () => {
      const alert = await submitRefused();
      expect(alert).toHaveTextContent(/클러스터가 배포를 받아들이지 않았습니다/);
      expect(alert).not.toHaveTextContent(/서버에서 문제가 발생해/);
      expect(alert).toHaveTextContent("요청 ID: req-cluster-9");
      expect(alert).toHaveTextContent("템플릿: web-app v3");
      expect(alert).not.toHaveTextContent("forbidden");
    });

    it("unfolds the apiserver's words at detailed", async () => {
      const alert = await submitRefused("detailed");
      expect(alert).toHaveTextContent('cannot create resource "deployments" in the namespace "default"');
      expect(alert).toHaveTextContent("502 k8s-error");
    });
  });

  // The main path of #42 is a *form field* edit — it runs through
  // handleValuesChange, not the meta inputs' inline handlers.
  it("clears a previous failure when the user edits a form field", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ releases: () => jsonResponse({ message: "boom" }, 502) }),
    );

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();
    });
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    await user.type(screen.getByLabelText(/앱 이름/), "-2");

    await waitFor(() => {
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  // #31, second half: `router.push` returns immediately, so the form is still
  // on screen during the RSC transition. Unlocking there gives a second POST.
  it("stays locked after a successful deploy while navigation is pending", async () => {
    const user = userEvent.setup();
    const fetchMock = routedFetch({});
    vi.stubGlobal("fetch", fetchMock);

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    const button = screen.getByRole("button", { name: /배포하기/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/releases/rel-1"));
    expect(button).toBeDisabled();

    const releaseCalls = fetchMock.mock.calls.filter(
      ([url]) => url === "/api/v1/releases",
    );
    expect(releaseCalls).toHaveLength(1);
  });

  async function submitAndReadAlert(releases: () => Response) {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch({ releases }));
    render(<DeployClient templateName="nightly-job" version={1} team={null} spec={spec} />);
    await fillMeta(user);
    const button = screen.getByRole("button", { name: /배포하기/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    return screen.findByRole("alert");
  }

  // #161: another release holds the objects this template creates. The old
  // message said "a release with this name exists, pick another name", which is
  // the one thing that cannot help, and did not say which release to look for.
  it("names the release holding the resources on a resource-conflict", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "resource-conflict",
          status: 409,
          detail: "objects this template creates already exist",
          conflicts: [
            { kind: "CronJob", name: "nightly", namespace: "demo", owner: "nightly-job-demo" },
          ],
        },
        409,
      ),
    );

    expect(alert).toHaveTextContent("nightly-job-demo");
    expect(alert).toHaveTextContent(/배포 이름을 바꿔도 해결되지 않습니다/);
    expect(alert).not.toHaveTextContent(/같은 이름의 릴리스/);
  });

  it("does not invent an owner when kubeport did not create the holder", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "resource-conflict",
          status: 409,
          conflicts: [{ kind: "ConfigMap", name: "stray", namespace: "demo", owner: "" }],
        },
        409,
      ),
    );

    expect(alert).toHaveTextContent(/kubeport 밖에서 만든 것/);
  });

  it("still says the name is taken for an ordinary conflict", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse({ title: "conflict", status: 409, detail: "release name already exists" }, 409),
    );

    expect(alert).toHaveTextContent(/같은 이름의 릴리스/);
  });

  // A template pinned to another namespace is the template's fault. The
  // generic 400 message told the user to check their own input.
  it("does not blame the user's input for a template pinned elsewhere", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "validation-error",
          status: 400,
          pinned_namespace: { kind: "Deployment", name: "web", namespace: "monitoring" },
        },
        400,
      ),
    );

    expect(alert).toHaveTextContent(/입력한 값의 문제가 아니니/);
    expect(alert).not.toHaveTextContent(/입력한 값을 확인한 뒤/);
  });

  // #136: a version saved before types were checked names one kubeport does
  // not know, and no input deploys it.
  it("does not blame the user's input for a template field kubeport cannot use", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "validation-error",
          status: 400,
          detail: 'replicas: unsupported field type "int"',
          template_defect: { path: "Deployment[web].spec.replicas", type: "int" },
        },
        400,
      ),
    );

    expect(alert).toHaveTextContent(/입력한 값의 문제가 아니니/);
    expect(alert).not.toHaveTextContent(/입력한 값을 확인한 뒤/);
  });

  // #195: objects carrying this release's own name under another release's id.
  // "The release 'web' uses them" while deploying web would read as nonsense.
  // #350: a demo account's manifest over the demo's limits. "No permission"
  // sent a visitor to an admin for what can be a value in the form, and did not
  // say which.
  describe("a demo account over the demo's limits (#350)", () => {
    function demoPolicy(violations: Array<Record<string, unknown>>) {
      return () =>
        jsonResponse(
          {
            title: "demo-restricted",
            status: 403,
            detail: "demo accounts cannot deploy this",
            demo_policy: violations,
          },
          403,
        );
    }

    it("names the image the demo does not allow", async () => {
      const alert = await submitAndReadAlert(
        demoPolicy([
          { rule: "image-prefix", kind: "CronJob", name: "nightly", container: "job", field: "spec.jobTemplate.spec.template.spec.containers[0].image", got: "quay.io/evil/app:1" },
        ]),
      );
      expect(alert).toHaveTextContent("quay.io/evil/app:1");
      expect(alert).not.toHaveTextContent(/권한이 없습니다/);
    });

    it("names the demo's retry limit, and says there is more", async () => {
      const alert = await submitAndReadAlert(
        demoPolicy([
          { rule: "job-backoff-limit", kind: "CronJob", name: "nightly", field: "spec.jobTemplate.spec.backoffLimit", limit: 2, got: 6 },
          { rule: "cronjob-history-limit", kind: "CronJob", name: "nightly", field: "spec.failedJobsHistoryLimit", limit: 1, got: 5 },
        ]),
      );
      expect(alert).toHaveTextContent(/실패한 작업을 2번까지만/);
      expect(alert).toHaveTextContent(/이 밖에도 1곳이/);
    });

    it("does not invent a number for a failure policy that ignores failures", async () => {
      const alert = await submitAndReadAlert(
        demoPolicy([
          { rule: "job-backoff-limit", kind: "Job", name: "retry", field: "spec.podFailurePolicy.rules[0].action", got: "Ignore" },
        ]),
      );
      expect(alert).toHaveTextContent(/횟수에 세지 않고/);
      expect(alert).not.toHaveTextContent(/null|undefined|NaN/);
    });

    it("sends a value the template fixes to an admin, not to the form", async () => {
      const alert = await submitAndReadAlert(
        demoPolicy([
          { rule: "job-ttl", kind: "Job", name: "once", field: "spec.ttlSecondsAfterFinished", limit: 86400, got: 172800 },
        ]),
      );
      expect(alert).toHaveTextContent(/끝난 작업을 24시간까지만/);
      expect(alert).not.toHaveTextContent(/86400|86,400/);
      expect(alert).toHaveTextContent(/관리자에게 템플릿 수정을 요청하세요/);
    });

    it("names the form field to change when the form holds the value", async () => {
      const user = userEvent.setup();
      vi.stubGlobal(
        "fetch",
        routedFetch({
          releases: demoPolicy([
            { rule: "job-backoff-limit", kind: "CronJob", name: "nightly", field: "spec.jobTemplate.spec.backoffLimit", limit: 2, got: 6 },
          ]),
        }),
      );
      const retrySpec: UISpec = {
        fields: [
          // Spelled differently from the response on purpose (#129).
          { path: "CronJob[nightly].spec.jobTemplate.spec['backoffLimit']", label: "재시도 횟수", type: "integer", default: 6, required: true },
        ],
      };
      render(<DeployClient templateName="nightly-job" version={1} team={null} spec={retrySpec} />);
      await fillMeta(user);
      const button = screen.getByRole("button", { name: /배포하기/ });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      const alert = await screen.findByRole("alert");

      expect(alert).toHaveTextContent("'재시도 횟수' 값을 2 이하로 바꾸세요");
      expect(alert).not.toHaveTextContent(/관리자/);
    });

    // The response names the object as rendered; a ui-spec path names it by
    // selector (codex review). A field is recommended only when its selector
    // can only mean that object — otherwise the visitor would change a value
    // that cannot lift the refusal.
    describe("which form field holds the value", () => {
      async function alertFor(
        fields: UISpec["fields"],
        violation: Record<string, unknown>,
        nameRules?: ReleaseNameRules,
      ) {
        const user = userEvent.setup();
        vi.stubGlobal("fetch", routedFetch({ releases: demoPolicy([violation]) }));
        render(
          <DeployClient templateName="batch" version={1} team={null} spec={{ fields }} nameRules={nameRules} />,
        );
        await fillMeta(user);
        const button = screen.getByRole("button", { name: /배포하기/ });
        await waitFor(() => expect(button).toBeEnabled());
        await user.click(button);
        return screen.findByRole("alert");
      }
      const retries = (path: string, label = "재시도 횟수") =>
        ({ path, label, type: "integer", default: 1, required: true }) as const;
      const onJob = (name: string) => ({
        rule: "job-backoff-limit", kind: "Job", name, field: "spec.backoffLimit", limit: 2, got: 6,
      });
      const toAdmin = /관리자에게 템플릿 수정을 요청하세요/;

      // The backend accepts a left-out selector only when the template has one
      // object of that kind, so it can only be this one.
      it("finds a field that leaves the selector out", async () => {
        const alert = await alertFor([retries("Job.spec.backoffLimit")], onJob("once"));
        expect(alert).toHaveTextContent("'재시도 횟수' 값을 2 이하로 바꾸세요");
      });

      it("finds a field on an object a new multi-instance release renamed", async () => {
        const alert = await alertFor(
          [retries("Job[once].spec.backoffLimit")],
          // fillMeta names the release my-app.
          onJob("my-app-once"),
          { multiple: true, maxLength: 30, letterFirst: true },
        );
        expect(alert).toHaveTextContent("'재시도 횟수' 값을 2 이하로 바꾸세요");
      });

      // An action has no number to name, but a form that exposes it still
      // lets the visitor lift the refusal (codex review).
      it("names a failure-policy action the form holds", async () => {
        const alert = await alertFor(
          [{ path: "Job.spec.podFailurePolicy.rules[0].action", label: "실패 처리", type: "string", default: "Count", required: true }],
          { rule: "job-backoff-limit", kind: "Job", name: "once", field: "spec.podFailurePolicy.rules[0].action", got: "Ignore" },
        );
        expect(alert).toHaveTextContent("'실패 처리' 을 실패를 무시하지 않는 값으로 바꾸세요");
        expect(alert).not.toHaveTextContent(toAdmin);
      });

      // In a multi-instance release every object is renamed: "once" renders as
      // my-app-once, so a Job[my-app-once] field is another Job (codex review).
      it("does not take an unprefixed name for a multi-instance object", async () => {
        const alert = await alertFor(
          [retries("Job[my-app-once].spec.backoffLimit")],
          onJob("my-app-once"),
          { multiple: true, maxLength: 30, letterFirst: true },
        );
        expect(alert).not.toHaveTextContent(/재시도 횟수/);
        expect(alert).toHaveTextContent(toAdmin);
      });

      // The backend renders a multi-instance preview as release "preview",
      // whatever the name field holds.
      it("finds the field in a multi-instance preview", async () => {
        vi.stubGlobal("fetch", routedFetch({ render: demoPolicy([onJob("preview-once")]) }));
        render(
          <DeployClient
            templateName="batch"
            version={1}
            team={null}
            spec={{ fields: [retries("Job[once].spec.backoffLimit")] }}
            nameRules={{ multiple: true, maxLength: 30, letterFirst: true }}
          />,
        );
        expect(await screen.findByText(/'재시도 횟수' 값을 2 이하로 바꾸세요/)).toBeInTheDocument();
      });

      it("does not guess that an index means the object refused", async () => {
        // The template may have another Job whose limit is fixed.
        const alert = await alertFor([retries("Job[0].spec.backoffLimit")], onJob("second"));
        expect(alert).not.toHaveTextContent(/재시도 횟수/);
        expect(alert).toHaveTextContent(toAdmin);
      });

      it("does not read a name that only ends the same way as renamed", async () => {
        const alert = await alertFor([retries("Job[once].spec.backoffLimit")], onJob("other-once"));
        expect(alert).not.toHaveTextContent(/재시도 횟수/);
        expect(alert).toHaveTextContent(toAdmin);
      });

      it("does not name a field on another object", async () => {
        const alert = await alertFor([retries("Job[other].spec.backoffLimit")], onJob("once"));
        expect(alert).not.toHaveTextContent(/재시도 횟수/);
        expect(alert).toHaveTextContent(toAdmin);
      });
    });

    // A release from before #350 meets the limits on its next update. "Cannot
    // deploy" would leave the visitor wondering what happened to the one running.
    it("says the running release is unchanged when an update is refused", async () => {
      const user = userEvent.setup();
      const base = routedFetch({});
      const refused = demoPolicy([
        { rule: "cronjob-history-limit", kind: "CronJob", name: "nightly", field: "spec.failedJobsHistoryLimit", limit: 1, got: 5 },
      ]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) =>
          url.startsWith("/api/v1/releases/") ? refused() : base(url, init),
        ),
      );
      render(
        <DeployClient
          templateName="nightly-job"
          version={2}
          team={null}
          spec={spec}
          updateReleaseId="rel-1"
          initialValues={{ "spec.replicas": 1, "metadata.name": "nginx" }}
        />,
      );
      const button = screen.getByRole("button", { name: /배포하기|업데이트/ });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      const alert = await screen.findByRole("alert");

      expect(alert).toHaveTextContent(/실행 기록을 1개까지만/);
      expect(alert).toHaveTextContent(/지금 실행 중인 릴리스는 그대로입니다/);
    });

    it("still says no permission for a demo-restricted refusal without limits", async () => {
      const alert = await submitAndReadAlert(() =>
        jsonResponse({ title: "demo-restricted", status: 403, detail: "demo accounts cannot perform this action" }, 403),
      );
      expect(alert).toHaveTextContent(/권한이 없습니다/);
    });

    it("says why the preview is empty when the demo's limits refuse it", async () => {
      vi.stubGlobal(
        "fetch",
        routedFetch({
          render: demoPolicy([
            { rule: "cronjob-history-limit", kind: "CronJob", name: "nightly", field: "spec.successfulJobsHistoryLimit", limit: 1, got: 3 },
          ]),
        }),
      );
      render(<DeployClient templateName="nightly-job" version={1} team={null} spec={spec} />);
      expect(await screen.findByText(/끝난 실행 기록을 1개까지만/)).toBeInTheDocument();
      expect(screen.queryByText("폼을 채우면 여기에 미리보기가 표시됩니다.")).not.toBeInTheDocument();
    });
  });

  it("says objects are an earlier same-name release's, not this one's", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "resource-conflict",
          status: 409,
          conflicts: [
            { kind: "Secret", name: "app-secret", namespace: "demo", owner: "nightly", same_name: true },
          ],
        },
        409,
      ),
    );

    expect(alert).toHaveTextContent(/같은 이름의 예전 릴리스가 남긴 리소스/);
    expect(alert).not.toHaveTextContent(/''nightly'' 릴리스가|'nightly' 릴리스가/);
    expect(alert).not.toHaveTextContent(/kubeport 밖에서 만든 것/);
  });

  it("still names another release when one holds objects next to a same-name leftover", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "resource-conflict",
          status: 409,
          conflicts: [
            { kind: "Secret", name: "app-secret", namespace: "demo", owner: "nightly", same_name: true },
            { kind: "CronJob", name: "nightly", namespace: "demo", owner: "nightly-job-demo" },
          ],
        },
        409,
      ),
    );

    expect(alert).toHaveTextContent("nightly-job-demo");
  });

  it("does not claim kubeport did not create a holder it cannot see", async () => {
    const alert = await submitAndReadAlert(() =>
      jsonResponse(
        {
          title: "resource-conflict",
          status: 409,
          conflicts: [
            { kind: "Secret", name: "app-secret", namespace: "demo", owner: "", owner_unknown: true },
          ],
        },
        409,
      ),
    );

    expect(alert).toHaveTextContent(/이 계정 권한으로 확인할 수 없습니다/);
    expect(alert).not.toHaveTextContent(/kubeport 밖에서 만든 것/);
  });

  // An existing release cannot move to another area, so the create advice is
  // impossible advice on an update.
  it("does not suggest another area when an update is refused", async () => {
    const user = userEvent.setup();
    const base = routedFetch({});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url.startsWith("/api/v1/releases/")
          ? jsonResponse(
              {
                title: "resource-conflict",
                status: 409,
                conflicts: [
                  { kind: "ConfigMap", name: "web-config", namespace: "demo", owner: "web-app-demo" },
                ],
              },
              409,
            )
          : base(url, init),
      ),
    );

    render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={spec}
        updateReleaseId="rel-1"
        initialValues={{ "spec.replicas": 1, "metadata.name": "nginx" }}
      />,
    );
    const button = screen.getByRole("button", { name: /배포하기|업데이트/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const alert = await screen.findByRole("alert");

    expect(alert).toHaveTextContent("web-app-demo");
    expect(alert).toHaveTextContent(/업데이트할 수 없습니다/);
    expect(alert).not.toHaveTextContent(/다른 구역에 배포하거나/);
  });
});

// #179 — the namespace field started on a hard-coded "default". The chart
// README promises the cluster's registered default_namespace, and demo
// accounts cannot write to "default" at all, so the demo's main path opened on
// a permission denial.
describe("DeployClient namespace default", () => {
  beforeEach(() => {
    pushMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const namespaceInput = () => screen.getByLabelText("구역") as HTMLInputElement;

  it("starts on the selected cluster's registered default namespace", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ clusters: [{ name: "dev", default_namespace: "team-a" }] }),
    );
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);

    await waitFor(() => expect(namespaceInput().value).toBe("team-a"));
  });

  it("starts empty, not on default, when the cluster registered none, and will not submit", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({ clusters: [{ name: "dev", default_namespace: null }] }),
    );
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);

    await screen.findByText("dev");
    expect(namespaceInput().value).toBe("");
    await user.type(screen.getByLabelText("배포 이름"), "my-app");
    // The API requires a namespace; an empty one is not worth a round trip.
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeDisabled();
  });

  it("starts a demo session on the demo namespace, whatever the cluster says", async () => {
    vi.stubGlobal(
      "fetch",
      routedFetch({ clusters: [{ name: "dev", default_namespace: "default" }] }),
    );
    render(
      <DeployClient
        templateName="web-app"
        version={1}
        team={null}
        spec={spec}
        demoNamespace="demo"
      />,
    );

    expect(namespaceInput().value).toBe("demo");
    await screen.findByText("dev");
    expect(namespaceInput().value).toBe("demo");
  });

  it("follows a cluster change until the reader types a namespace", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      routedFetch({
        clusters: [
          { name: "dev", default_namespace: "team-a" },
          { name: "prod", default_namespace: "team-b" },
        ],
      }),
    );
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await waitFor(() => expect(namespaceInput().value).toBe("team-a"));

    act(() => {
      window.dispatchEvent(new CustomEvent(CLUSTER_CHANGED_EVENT, { detail: "prod" }));
    });
    await waitFor(() => expect(namespaceInput().value).toBe("team-b"));

    await user.clear(namespaceInput());
    await user.type(namespaceInput(), "mine");
    act(() => {
      window.dispatchEvent(new CustomEvent(CLUSTER_CHANGED_EVENT, { detail: "dev" }));
    });
    await screen.findByText("dev");
    expect(namespaceInput().value).toBe("mine");
  });

  // An update has no namespace field — the release's namespace cannot move —
  // so the empty-namespace guard must not reach it, or the button never
  // unlocks.
  it("still lets an update be submitted", async () => {
    vi.stubGlobal("fetch", routedFetch({}));
    const { container } = render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={spec}
        updateReleaseId="rel-9"
        initialValues={{ "spec.replicas": 1, "metadata.name": "nginx" }}
      />,
    );

    await waitFor(() =>
      expect(container.querySelector('button[type="submit"]')).toBeEnabled(),
    );
  });
});

// #182 — the name was checked only by the API. A name the help text already
// ruled out went through and came back as a 400, and an empty one switched the
// button off without saying why.
describe("DeployClient release name", () => {
  beforeEach(() => {
    pushMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const nameInput = () => screen.getByLabelText("배포 이름") as HTMLInputElement;
  const submitButton = () => screen.getByRole("button", { name: /배포하기/ });
  const clusterWithNamespace = () =>
    routedFetch({ clusters: [{ name: "dev", default_namespace: "team-a" }] });

  it("says why the button is off while the name is empty", async () => {
    vi.stubGlobal("fetch", clusterWithNamespace());
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await waitFor(() =>
      expect((screen.getByLabelText("구역") as HTMLInputElement).value).toBe("team-a"),
    );

    expect(submitButton()).toBeDisabled();
    expect(nameInput()).toHaveAccessibleDescription("배포 이름을 입력하면 배포할 수 있습니다.");
    // Where every form starts is not an error.
    expect(nameInput()).toHaveAttribute("aria-invalid", "false");
  });

  it("flags a name the API would refuse before anyone submits it", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", clusterWithNamespace());
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await waitFor(() =>
      expect((screen.getByLabelText("구역") as HTMLInputElement).value).toBe("team-a"),
    );

    // The reviewer's input from #182.
    await user.type(nameInput(), "Web App 배포 테스트 1");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveAccessibleDescription(/하이픈으로 시작하거나 끝날 수 없습니다/);
    expect(submitButton()).toBeDisabled();

    await user.clear(nameInput());
    await user.type(nameInput(), "web-app-test-1");
    expect(nameInput()).toHaveAttribute("aria-invalid", "false");
    expect(screen.queryByText(/하이픈으로 시작하거나 끝날 수 없습니다/)).toBeNull();
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  // maxLength stops typing past the limit, but not a value the page prefilled
  // (a demo account's default is the template name plus a suffix).
  it("asks for a shorter name when a prefilled one is too long", async () => {
    vi.stubGlobal("fetch", clusterWithNamespace());
    render(
      <DeployClient
        templateName="web-app"
        version={1}
        team={null}
        spec={spec}
        defaultName={"a".repeat(64)}
      />,
    );

    expect(nameInput()).toHaveAccessibleDescription("63자 이하로 줄여 주세요.");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(submitButton()).toBeDisabled();
  });

  // #190 — a multi-instance template's objects take the release name in front
  // of theirs, so the backend refuses a name those objects cannot fit.
  it("holds a multi-instance template's name to what its objects leave", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", clusterWithNamespace());
    const nameRules = { multiple: true, maxLength: 37, letterFirst: true };
    render(
      <DeployClient templateName="web-app" version={1} team={null} spec={spec} nameRules={nameRules} />,
    );
    await waitFor(() =>
      expect((screen.getByLabelText("구역") as HTMLInputElement).value).toBe("team-a"),
    );

    expect(nameInput()).toHaveAttribute("maxLength", "37");
    expect(nameInput()).toHaveAccessibleDescription(/37자까지 쓸 수 있습니다/);

    await user.type(nameInput(), "2048-game");
    expect(nameInput()).toHaveAttribute("aria-invalid", "true");
    expect(nameInput()).toHaveAccessibleDescription(/영문 소문자로 시작해야 합니다/);
    expect(submitButton()).toBeDisabled();

    await user.clear(nameInput());
    await user.type(nameInput(), "game-2048");
    expect(nameInput()).toHaveAttribute("aria-invalid", "false");
    await waitFor(() => expect(submitButton()).toBeEnabled());
  });

  it("gives a prefilled multi-instance name the limit it breaks", async () => {
    vi.stubGlobal("fetch", clusterWithNamespace());
    render(
      <DeployClient
        templateName="web-app"
        version={1}
        team={null}
        spec={spec}
        defaultName={"a".repeat(38)}
        nameRules={{ multiple: true, maxLength: 37, letterFirst: false }}
      />,
    );

    expect(nameInput()).toHaveAccessibleDescription(/37자 이하로 줄여 주세요\./);
    expect(submitButton()).toBeDisabled();
  });

  it("does not mention several deployments for a single-instance template", async () => {
    vi.stubGlobal("fetch", clusterWithNamespace());
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    expect(nameInput()).toHaveAttribute("maxLength", "63");
    expect(screen.queryByText(/여러 번 배포할 수 있습니다/)).toBeNull();
  });
});

// #319 — the preview sent the raw form values while submit sent the parsed
// ones. A release whose stored values held null sent that null to the render
// API, which refused it, and the preview stayed empty.
describe("DeployClient preview payload", () => {
  beforeEach(() => {
    pushMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const INVALID = "필수 항목을 채우고 표시된 오류를 고치면 미리보기가 나옵니다.";
  const RBAC_WAITS = "미리보기가 나오면 만들 수 있는지 확인합니다.";
  const ALL_ALLOWED = "위 목록을 모두 만들 수 있습니다.";
  // ResourcesPreview's row for the mocked Deployment, which has no name.
  const PREVIEW_ROW = "(이름 없음)";
  const RENDERED = "apiVersion: apps/v1\nkind: Deployment\n";

  const updateSpec: UISpec = {
    fields: [
      { path: "metadata.name", label: "앱 이름", type: "string", required: true },
      { path: "metadata.labels.tier", label: "등급", type: "string" },
      { path: "Secret[app].stringData.password", label: "비밀번호", type: "string" },
    ],
  };

  type Call = [string, RequestInit | undefined];

  /** The render API as the backend answers it: a null value is a 400. */
  function backendFetch() {
    const base = routedFetch({});
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/render")) {
        const body = JSON.parse(String(init?.body)) as { values: Record<string, unknown> };
        return Object.values(body.values).includes(null)
          ? jsonResponse({ title: "validation-error", status: 400 }, 400)
          : jsonResponse({ rendered_yaml: RENDERED });
      }
      if (url.startsWith("/api/v1/releases/")) return jsonResponse({}, 200);
      return base(url, init);
    });
  }

  const renderCalls = (m: { mock: { calls: unknown[] } }) =>
    (m.mock.calls as Call[]).filter(([url]) => url.includes("/render"));
  const bodyOf = ([, init]: Call) => JSON.parse(String(init?.body)) as Record<string, unknown>;

  /** Longer than the preview's 300ms debounce. */
  const pastDebounce = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 450));
    });

  it("leaves a stored null on an optional field out of the preview, and renders it", async () => {
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={updateSpec}
        updateReleaseId="rel-1"
        initialValues={{ "metadata.name": "web", "metadata.labels.tier": null }}
      />,
    );

    expect(await screen.findByText(PREVIEW_ROW)).toBeInTheDocument();
    const calls = renderCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(bodyOf(calls[0])).toEqual({ values: { "metadata.name": "web" }, release_id: "rel-1" });
    expect(String(calls[0][1]?.body)).not.toContain("tier");
  });

  it("holds the preview while a required field holds a stored null, and sends it once filled", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={updateSpec}
        updateReleaseId="rel-1"
        initialValues={{ "metadata.name": null, "metadata.labels.tier": "gold" }}
      />,
    );

    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(INVALID)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/앱 이름/), "web");

    expect(await screen.findByText(PREVIEW_ROW)).toBeInTheDocument();
    expect(screen.queryByText(INVALID)).not.toBeInTheDocument();
    expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({
      values: { "metadata.name": "web", "metadata.labels.tier": "gold" },
      release_id: "rel-1",
    });
  });

  it("previews a kept Secret with the same values submit sends", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={updateSpec}
        updateReleaseId="rel-1"
        initialValues={{ "metadata.name": "web", "Secret[app].stringData.password": "<redacted>" }}
      />,
    );

    expect(await screen.findByText(PREVIEW_ROW)).toBeInTheDocument();
    const preview = bodyOf(renderCalls(fetchMock).at(-1)!);

    const button = screen.getByRole("button", { name: /배포하기|업데이트/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/releases/rel-1"));
    const put = (fetchMock.mock.calls as Call[]).find(([url]) => url === "/api/v1/releases/rel-1")!;

    expect(preview.values).toEqual({
      "metadata.name": "web",
      "Secret[app].stringData.password": "<redacted>",
    });
    expect(JSON.stringify(preview.values)).toBe(JSON.stringify(bodyOf(put).values));
  });

  it("sends a valid new deploy's preview exactly as before", async () => {
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);

    expect(await screen.findByText(PREVIEW_ROW)).toBeInTheDocument();
    const calls = renderCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]?.body).toBe(
      JSON.stringify({ values: { "spec.replicas": 1, "metadata.name": "nginx" } }),
    );
  });

  // No default, so a new form starts with the required field empty.
  const portSpec: UISpec = {
    fields: [{ path: "spec.port", label: "포트", type: "integer", required: true }],
  };
  // With one. Until #321 a cleared box read back as its default and typing
  // appended to it, so the tests below that clear the box had to avoid one.
  const defaultPortSpec: UISpec = {
    fields: [{ path: "spec.port", label: "포트", type: "integer", default: 8080, required: true }],
  };

  it("previews what is typed into a cleared box, not the default it had", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="web-app" version={1} team={null} spec={defaultPortSpec} />);
    await fillMeta(user);
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();

    const before = renderCalls(fetchMock).length;
    await user.clear(screen.getByLabelText(/포트/));
    await waitFor(() => expect(screen.getByText(INVALID)).toBeInTheDocument());
    expect(screen.getByLabelText(/포트/)).toHaveValue(null);
    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(before);

    await user.type(screen.getByLabelText(/포트/), "80");
    expect(screen.getByLabelText(/포트/)).toHaveValue(80);
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();
    expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({ values: { "spec.port": 80 } });
  });

  it("does not keep a permission verdict for values that no longer parse", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="web-app" version={1} team={null} spec={portSpec} />);
    await fillMeta(user);

    // A new form that starts with a required field empty says why nothing is
    // shown, in both panels, and asks nothing of the API.
    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(screen.getByText(RBAC_WAITS)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeEnabled();

    await user.type(screen.getByLabelText(/포트/), "8080");
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();

    const before = renderCalls(fetchMock).length;
    await user.clear(screen.getByLabelText(/포트/));

    await waitFor(() => expect(screen.getByText(INVALID)).toBeInTheDocument());
    expect(screen.queryByText(ALL_ALLOWED)).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_ROW)).not.toBeInTheDocument();
    expect(screen.getByText(RBAC_WAITS)).toBeInTheDocument();
    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(before);

    await user.type(screen.getByLabelText(/포트/), "80");
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();
    expect(screen.queryByText(RBAC_WAITS)).not.toBeInTheDocument();
    expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({ values: { "spec.port": 80 } });
  });

  it("drops a preview that answers after the values stopped parsing", async () => {
    const user = userEvent.setup();
    const pending: Array<() => void> = [];
    const base = backendFetch();
    const fetchMock = vi.fn((url: string, init?: RequestInit) =>
      url.includes("/render")
        ? new Promise<Response>((resolve) => {
            pending.push(() => resolve(jsonResponse({ rendered_yaml: RENDERED })));
          })
        : base(url, init),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="web-app" version={1} team={null} spec={defaultPortSpec} />);
    await fillMeta(user);
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));

    await user.clear(screen.getByLabelText(/포트/));
    await waitFor(() => expect(screen.getByText(INVALID)).toBeInTheDocument());
    await act(async () => {
      pending.forEach((answer) => answer());
    });
    await pastDebounce();

    expect(screen.queryByText(PREVIEW_ROW)).not.toBeInTheDocument();
    expect(screen.queryByText(ALL_ALLOWED)).not.toBeInTheDocument();
    expect(screen.getByText(INVALID)).toBeInTheDocument();
  });

  // #331 — app-with-config's "API 키": required, no default. Typed in and then
  // emptied, the box held "", which parsed: the preview and the verdict stayed,
  // and the render API was asked again with "".
  const apiKey = "Secret[app-secret].stringData.API_KEY";
  const apiKeySpec: UISpec = {
    fields: [{ path: apiKey, label: "API 키", type: "string", required: true }],
  };
  const REQUIRED = "필수 항목입니다.";

  it("holds the preview again when a filled required text box is emptied", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="app-with-config" version={1} team={null} spec={apiKeySpec} />);
    await fillMeta(user);
    const box = () => screen.getByLabelText(/API 키/);

    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByText(INVALID)).toBeInTheDocument();
    expect(screen.getByText(RBAC_WAITS)).toBeInTheDocument();

    await user.type(box(), "k");
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();
    expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({ values: { [apiKey]: "k" } });

    const before = renderCalls(fetchMock).length;
    await user.clear(box());

    await waitFor(() => expect(screen.getByText(INVALID)).toBeInTheDocument());
    expect(screen.getByText(REQUIRED)).toBeInTheDocument();
    expect(screen.queryByText(ALL_ALLOWED)).not.toBeInTheDocument();
    expect(screen.queryByText(PREVIEW_ROW)).not.toBeInTheDocument();
    expect(screen.getByText(RBAC_WAITS)).toBeInTheDocument();
    await pastDebounce();
    expect(renderCalls(fetchMock)).toHaveLength(before);

    // The button stays pressable, as on a fresh form, but submit refuses "".
    await user.click(screen.getByRole("button", { name: /배포하기/ }));
    await pastDebounce();
    expect((fetchMock.mock.calls as Call[]).some(([url]) => url === "/api/v1/releases")).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
    expect(screen.getByText(REQUIRED)).toBeInTheDocument();

    await user.type(box(), "k2");
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();
    expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument();
    expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({ values: { [apiKey]: "k2" } });
  });

  // #334 — an optional text box with a default, typed in and emptied, sent ""
  // to both the preview and the release, and the API wrote it over the
  // default. Both now leave the key out, so the API fills the default — and
  // they still send the same values (#322).
  const image = "Deployment[web].spec.template.spec.containers[0].image";
  const imageSpec: UISpec = {
    fields: [{ path: image, label: "이미지", type: "string", default: "nginx:1.25" }],
  };

  it("previews and deploys an emptied optional box with a default without its key", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(<DeployClient templateName="web-app" version={1} team={null} spec={imageSpec} />);
    await fillMeta(user);
    const box = () => screen.getByLabelText(/이미지/);

    await user.clear(box());
    await user.type(box(), "custom");
    await waitFor(() =>
      expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({ values: { [image]: "custom" } }),
    );

    await user.clear(box());
    await waitFor(() => expect(String(renderCalls(fetchMock).at(-1)![1]?.body)).not.toContain(image));
    expect(await screen.findByText(ALL_ALLOWED)).toBeInTheDocument();
    const preview = bodyOf(renderCalls(fetchMock).at(-1)!);
    expect(preview).toEqual({ values: {} });

    const button = screen.getByRole("button", { name: /배포하기/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(pushMock).toHaveBeenCalled());
    const post = (fetchMock.mock.calls as Call[]).find(([url]) => url === "/api/v1/releases")!;
    expect(String(post[1]?.body)).not.toContain(image);
    expect(JSON.stringify(bodyOf(post).values)).toBe(JSON.stringify(preview.values));
  });

  it("previews and updates a stored value emptied on a box with a default without its key", async () => {
    const user = userEvent.setup();
    const fetchMock = backendFetch();
    vi.stubGlobal("fetch", fetchMock);
    render(
      <DeployClient
        templateName="web-app"
        version={2}
        team={null}
        spec={imageSpec}
        updateReleaseId="rel-1"
        initialValues={{ [image]: "registry.example/app:7" }}
      />,
    );
    await waitFor(() =>
      expect(bodyOf(renderCalls(fetchMock).at(-1)!)).toEqual({
        values: { [image]: "registry.example/app:7" },
        release_id: "rel-1",
      }),
    );

    await user.clear(screen.getByLabelText(/이미지/));
    await waitFor(() => expect(String(renderCalls(fetchMock).at(-1)![1]?.body)).not.toContain(image));
    const preview = bodyOf(renderCalls(fetchMock).at(-1)!);
    expect(preview).toEqual({ values: {}, release_id: "rel-1" });

    const button = screen.getByRole("button", { name: /배포하기|업데이트/ });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/releases/rel-1"));
    const put = (fetchMock.mock.calls as Call[]).find(([url]) => url === "/api/v1/releases/rel-1")!;
    expect(String(put[1]?.body)).not.toContain(image);
    expect(JSON.stringify(bodyOf(put).values)).toBe(JSON.stringify(preview.values));
  });
  // #359 — the header link (#354) says "설정 바꾸기", but this page said
  // "v1 로 업데이트" for a release already on v1: a reader could not tell
  // whether the version was going up or only the values. The page now names
  // the release and, on the same version, calls the action what the link did.
  describe("update form naming (#359)", () => {
    function renderUpdate(version: number) {
      vi.stubGlobal("fetch", routedFetch({}));
      return render(
        <DeployClient
          templateName="web-app"
          version={version}
          team={null}
          spec={spec}
          updateReleaseId="rel-1"
          updateRelease={{ name: "hello-web", version: 2 }}
          initialValues={{ "spec.replicas": 1, "metadata.name": "nginx" }}
        />,
      );
    }

    it("on the same version, changes settings of the named release", () => {
      renderUpdate(2);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("'hello-web' 설정 바꾸기");
      expect(screen.getByRole("button", { name: "바뀐 설정 적용" })).toBeInTheDocument();
      expect(screen.queryByText(/로 업데이트/)).toBeNull();
    });

    it("on another version, still updates to it and names the release", () => {
      renderUpdate(3);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("v3 로 업데이트");
      expect(screen.getByRole("button", { name: "v3 로 업데이트" })).toBeInTheDocument();
      expect(screen.getByText(/hello-web/)).toBeInTheDocument();
    });

    // ICU treats ' and { as syntax in the message, not in an argument value:
    // a name with either must come through as typed, and React escapes it.
    it("shows a name with quotes or braces as typed", () => {
      vi.stubGlobal("fetch", routedFetch({}));
      render(
        <DeployClient
          templateName="web-app"
          version={2}
          team={null}
          spec={spec}
          updateReleaseId="rel-1"
          updateRelease={{ name: "it's-{a}-<b>", version: 2 }}
          initialValues={{}}
        />,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("'it's-{a}-<b>' 설정 바꾸기");
    });

    it("falls back to the version wording when the release came without a name", () => {
      vi.stubGlobal("fetch", routedFetch({}));
      render(
        <DeployClient
          templateName="web-app"
          version={2}
          team={null}
          spec={spec}
          updateReleaseId="rel-1"
          updateRelease={{ name: "", version: 2 }}
          initialValues={{}}
        />,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("v2 로 업데이트");
      expect(screen.queryByText(/설정 바꾸기/)).toBeNull();
    });

    it("falls back to the version wording when the release is not described", () => {
      vi.stubGlobal("fetch", routedFetch({}));
      render(
        <DeployClient templateName="web-app" version={2} team={null} spec={spec} updateReleaseId="rel-1" initialValues={{}} />,
      );
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("v2 로 업데이트");
    });
  });
});
