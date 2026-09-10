import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithIntl as render } from "@/tests/intl-test-utils";

import { CLUSTER_CHANGED_EVENT } from "@/components/ClusterPicker";

import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

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
  clusters?: Array<{ name: string; default_namespace?: string | null }>;
}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/clusters") {
      return jsonResponse({ clusters: overrides.clusters ?? [{ name: "dev" }] });
    }
    if (url.includes("/render")) {
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

    expect(screen.getByText(/권한이 거부되었습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /배포하기/ })).toBeDisabled();
  });

  it("keeps submission enabled when RBAC allows everything", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", routedFetch({}));

    render(<DeployClient templateName="web-app" version={1} team={null} spec={spec} />);
    await fillMeta(user);

    await waitFor(() => {
      expect(screen.getByText("모든 리소스 생성 권한 확인됨.")).toBeInTheDocument();
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
});
