# Release Detail Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/releases/[id]` 화면을 스펙 §6 에 맞춰 재설계 — 공통 헤더 + 탭 네비게이션 (개요 / 로그) + MetricCards + InstancesTable + **SSE 기반 실시간 로그** + k8s 용어 토글. 업데이트 플로우는 Plan 3 에서.

**Architecture:**
- **Backend 신규**: `GET /v1/releases/:id/logs?instance=…` SSE 엔드포인트 (k8s pod log follow 스트림 → `text/event-stream` 으로 변환).
- **Frontend 라우트 재구성**: 현재 단일 `page.tsx` → Next.js nested route (`layout.tsx` + `page.tsx` + `logs/page.tsx`). Activity / Settings 는 이 플랜 범위 밖 (스펙 §6.1 은 명시하나 §6 본문에 세부 없음 → 후속).
- **k8s 용어 토글**: Plan 0 의 `useKubeTermsStore` 활용. 번역 맵 `lib/kube-term-map.ts` 신규.

**Tech Stack:** 기존 + Plan 0 산출물 (`StatusChip`, Zustand store, shadcn `Switch` · `Table` · `Tooltip`). Backend: `client-go` pod log follow, Gin SSE support (`c.SSEvent()` / `c.Stream()`).

**스펙 참조:** [2026-04-19-frontend-design-spec.md](../specs/2026-04-19-frontend-design-spec.md) §6.

**전제:** Plan 0 완료 (StatusChip, Vitest, zustand, shadcn Table/Switch/Tooltip/Tabs).

---

## Part A — Backend: SSE 로그 엔드포인트

### Task 1: 로그 스트림 k8s 클라이언트 래퍼

**Files:**
- Create: `backend/internal/k8s/logs.go`
- Create: `backend/internal/k8s/logs_test.go`

`client-go` 의 `Pods(ns).GetLogs(name, &corev1.PodLogOptions{Follow: true})` 을 감싸는 얇은 헬퍼. 여러 pod 을 병합 스트림으로 묶어 한 채널로 내보낸다.

- [ ] **Step 1: 실패 테스트 — `backend/internal/k8s/logs_test.go`** (통합 테스트, envtest 또는 fake clientset)

```go
package k8s

import (
    "context"
    "testing"
    "time"

    fakecore "k8s.io/client-go/kubernetes/fake"
)

func TestStreamPodLogs_BasicEmit(t *testing.T) {
    cs := fakecore.NewSimpleClientset()
    // fake clientset 은 실제 로그 바디를 주지 못함 — 이 테스트는
    // 컨텍스트 취소 + 에러 전파 경로만 검증한다.
    ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
    defer cancel()

    ch, errCh := StreamPodLogs(ctx, cs, "default", []string{"p1"})
    select {
    case <-ctx.Done():
        // expected timeout
    case msg := <-ch:
        t.Fatalf("unexpected message: %+v", msg)
    case err := <-errCh:
        if err == nil || err == context.DeadlineExceeded {
            return
        }
        t.Fatalf("unexpected error: %v", err)
    }
}
```

주의: fake clientset 은 실제 log stream 을 흉내 내지 못한다. 이 테스트는 "cancel 시 채널이 깨끗이 닫힌다" 만 검증. 실제 streaming 검증은 e2e 에서 live k8s 로.

- [ ] **Step 2: 실패 확인**

Run: `cd backend && go test ./internal/k8s -run TestStreamPodLogs`
Expected: FAIL — undefined: `StreamPodLogs`.

- [ ] **Step 3: 구현 — `backend/internal/k8s/logs.go`**

```go
package k8s

import (
    "bufio"
    "context"
    "fmt"
    "sync"

    corev1 "k8s.io/api/core/v1"
    "k8s.io/client-go/kubernetes"
)

// LogLine is one emitted log entry from a single pod.
type LogLine struct {
    Pod  string `json:"pod"`
    Text string `json:"text"`
}

// StreamPodLogs follows logs from multiple pods concurrently and fans
// them into a single channel. Close happens when ctx is done or when
// all pods stop emitting. The returned errCh is closed after ch closes.
func StreamPodLogs(ctx context.Context, cs kubernetes.Interface, namespace string, pods []string) (<-chan LogLine, <-chan error) {
    ch := make(chan LogLine, 64)
    errCh := make(chan error, len(pods))

    var wg sync.WaitGroup
    for _, p := range pods {
        wg.Add(1)
        go func(pod string) {
            defer wg.Done()
            req := cs.CoreV1().Pods(namespace).GetLogs(pod, &corev1.PodLogOptions{
                Follow: true,
            })
            rc, err := req.Stream(ctx)
            if err != nil {
                errCh <- fmt.Errorf("pod %s: %w", pod, err)
                return
            }
            defer rc.Close()
            sc := bufio.NewScanner(rc)
            // k8s 로그는 JSON 포맷 + 스택 트레이스 시 기본 64KB 라인 한계를
            // 쉽게 넘긴다. 1MB 까지 허용해 bufio.ErrTooLong 을 막는다.
            sc.Buffer(make([]byte, 64*1024), 1024*1024)
            for sc.Scan() {
                select {
                case <-ctx.Done():
                    return
                case ch <- LogLine{Pod: pod, Text: sc.Text()}:
                }
            }
            if err := sc.Err(); err != nil {
                errCh <- fmt.Errorf("pod %s scan: %w", pod, err)
            }
        }(p)
    }

    go func() {
        wg.Wait()
        close(ch)
        close(errCh)
    }()

    return ch, errCh
}
```

- [ ] **Step 4: 통과 확인**

Run: `cd backend && go test ./internal/k8s -run TestStreamPodLogs`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add backend/internal/k8s/logs.go backend/internal/k8s/logs_test.go
git commit -m "feat(k8s): StreamPodLogs — follow + fan-in pod logs to single channel"
```

---

### Task 2: `/v1/releases/:id/logs` SSE 핸들러 등록

**Files:**
- Modify: `backend/internal/api/routes.go`
- Create: `backend/internal/api/release_logs.go`
- Create: `backend/internal/api/release_logs_test.go`

릴리스 ID 로 Release 조회 → 권한 체크 (기존 `authorizeReleaseRead` 재사용) → `cluster + namespace + instances` 로부터 pod 이름 목록 추출 → `StreamPodLogs` → 각 line 을 `c.SSEvent("log", {pod, text, time})` 로 푸시.

- [ ] **Step 1: 실패 테스트 — `backend/internal/api/release_logs_test.go`**

```go
package api_test

import (
    "context"
    "net/http/httptest"
    "strings"
    "testing"
    "time"

    "kubeport/internal/api"
    "kubeport/internal/testutil"
)

func TestStreamReleaseLogs_Unauthorized(t *testing.T) {
    h, srv := testutil.NewAPIServer(t) // 기존 도우미 가정
    defer srv.Close()
    _ = h

    req := httptest.NewRequest("GET", "/v1/releases/does-not-exist/logs", nil)
    ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
    defer cancel()
    req = req.WithContext(ctx)
    rw := httptest.NewRecorder()
    srv.Config.Handler.ServeHTTP(rw, req)

    if rw.Code != 401 && rw.Code != 404 {
        t.Fatalf("expected 401 or 404, got %d: %s", rw.Code, rw.Body.String())
    }
    if strings.HasPrefix(rw.Header().Get("Content-Type"), "text/event-stream") {
        t.Fatalf("error response should not set event-stream content-type")
    }
}
```

주의: 실제 SSE 스트림 검증은 e2e 단계 (live k8s + 실제 pod 필요). 여기선 인증·경로 검증만.

- [ ] **Step 2: 실패 확인**

Run: `cd backend && go test ./internal/api -run TestStreamReleaseLogs`
Expected: FAIL — 404 가 나야 정상.

- [ ] **Step 3: 핸들러 구현 — `backend/internal/api/release_logs.go`**

```go
package api

import (
    "context"
    "encoding/json"
    "io"
    "net/http"
    "time"

    "github.com/gin-gonic/gin"

    "kubeport/internal/k8s"
)

// StreamReleaseLogs proxies `kubectl logs -f` for every pod owned by
// the release, multiplexed over Server-Sent Events. Query `?instance=xxx`
// filters to a single pod; `all` (default) follows every pod.
func (h *Handlers) StreamReleaseLogs(c *gin.Context) {
    releaseID := c.Param("id")
    rel, err := h.deps.Store.GetReleaseByID(c, releaseID)
    if err != nil {
        writeError(c, http.StatusNotFound, "not_found", err.Error())
        return
    }
    if err := h.authorizeReleaseRead(c, rel); err != nil {
        writeError(c, http.StatusForbidden, "forbidden", err.Error())
        return
    }

    overview, err := h.deps.K8sFactory.Overview(c, rel)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "k8s", err.Error())
        return
    }

    want := c.DefaultQuery("instance", "all")
    var pods []string
    for _, ins := range overview.Instances {
        if want == "all" || want == ins.Name {
            pods = append(pods, ins.Name)
        }
    }
    if len(pods) == 0 {
        writeError(c, http.StatusNotFound, "no_pods", "no matching instance")
        return
    }

    cs, err := h.deps.K8sFactory.ClientFor(c, rel.Cluster)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "k8s", err.Error())
        return
    }

    c.Writer.Header().Set("Content-Type", "text/event-stream")
    c.Writer.Header().Set("Cache-Control", "no-cache")
    c.Writer.Header().Set("Connection", "keep-alive")
    c.Writer.Flush()

    ctx, cancel := context.WithCancel(c.Request.Context())
    defer cancel()

    ch, errCh := k8s.StreamPodLogs(ctx, cs, rel.Namespace, pods)
    ping := time.NewTicker(15 * time.Second)
    defer ping.Stop()

    c.Stream(func(w io.Writer) bool {
        select {
        case <-ctx.Done():
            return false
        case <-ping.C:
            c.SSEvent("ping", time.Now().Unix())
            return true
        case err := <-errCh:
            if err != nil {
                body, _ := json.Marshal(map[string]string{"error": err.Error()})
                c.SSEvent("error", string(body))
            }
            return true
        case line, ok := <-ch:
            if !ok {
                return false
            }
            body, _ := json.Marshal(map[string]any{
                "time": time.Now().UnixMilli(),
                "pod":  line.Pod,
                "text": line.Text,
            })
            c.SSEvent("log", string(body))
            return true
        }
    })
}
```

**주의**: `K8sFactory.ClientFor` 와 `K8sFactory.Overview` 의 정확한 시그니처는 `backend/internal/k8s/factory.go` 를 보고 맞출 것. 없으면 existing release handler 가 어떻게 client 를 얻는지 따라갈 것 — `GetRelease()` 참조.

- [ ] **Step 4: 라우트 등록 — `backend/internal/api/routes.go` 의 releases 블록에 추가**

```go
v1.GET("/releases/:id/logs", h.StreamReleaseLogs)
```

기존 `v1.GET("/releases/:id", h.GetRelease)` 바로 다음.

- [ ] **Step 5: 테스트 통과**

Run: `cd backend && go test ./internal/api -run TestStreamReleaseLogs`
Expected: PASS.

- [ ] **Step 6: 전체 백엔드 테스트 리그레션 없음**

Run: `cd backend && go test ./...`
Expected: 모두 통과.

- [ ] **Step 7: 커밋**

```bash
git add backend/internal/api/release_logs.go backend/internal/api/release_logs_test.go backend/internal/api/routes.go
git commit -m "feat(api): GET /v1/releases/:id/logs — SSE pod log follow"
```

---

## Part B — Frontend: 라우트 재구성 + 탭

### Task 3: `app/releases/[id]/layout.tsx` — 공통 헤더 + 탭 네비

**Files:**
- Create: `frontend/app/releases/[id]/layout.tsx`
- Create: `frontend/components/ReleaseHeader.tsx`
- Create: `frontend/components/ReleaseTabs.tsx`
- Create: `frontend/components/ReleaseTabs.test.tsx`

Next.js App Router 의 nested layout 을 쓴다. layout 은 서버에서 Release 를 한 번 페치해서 헤더만 렌더; 탭 전환은 children 으로 위임.

- [ ] **Step 1: `frontend/components/ReleaseHeader.tsx` 작성 (server component)**

```tsx
import { StatusChip, statusChipVariantFromRelease } from "@/components/StatusChip";

export type ReleaseHeaderData = {
  id: string;
  name: string;
  status: string;
  template: { name: string; version: number };
  cluster: string;
  namespace: string;
  created_at?: string;
};

export function ReleaseHeader({ data }: { data: ReleaseHeaderData }) {
  return (
    <header className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <h1 className="font-mono text-xl font-medium">{data.name}</h1>
        <StatusChip variant={statusChipVariantFromRelease(data.status)}>
          {data.status}
        </StatusChip>
      </div>
      <div className="text-sm text-slate-600">
        {data.template.name} v{data.template.version} · {data.cluster} / {data.namespace}
        {data.created_at ? ` · ${new Date(data.created_at).toLocaleString()}` : ""}
      </div>
    </header>
  );
}
```

- [ ] **Step 2: `frontend/components/ReleaseTabs.tsx` 작성 (client component, pathname 기반 활성 표시)**

```tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { key: "overview", label: "개요", suffix: "" },
  { key: "logs", label: "로그", suffix: "/logs" },
] as const;

export function ReleaseTabs({ releaseId }: { releaseId: string }) {
  const pathname = usePathname();
  const base = `/releases/${releaseId}`;
  return (
    <nav className="flex gap-4 border-b">
      {TABS.map((t) => {
        const href = base + t.suffix;
        const active = pathname === href;
        return (
          <Link
            key={t.key}
            href={href}
            className={`px-3 py-2 text-sm ${
              active ? "border-b-2 border-blue-700 text-blue-800" : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
```

- [ ] **Step 3: ReleaseTabs 활성 상태 테스트 — `frontend/components/ReleaseTabs.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReleaseTabs } from "./ReleaseTabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/releases/abc/logs",
}));

describe("ReleaseTabs", () => {
  it("marks active tab by pathname suffix", () => {
    render(<ReleaseTabs releaseId="abc" />);
    const logsLink = screen.getByRole("link", { name: "로그" });
    expect(logsLink.className).toMatch(/border-blue-700/);
    const overviewLink = screen.getByRole("link", { name: "개요" });
    expect(overviewLink.className).not.toMatch(/border-blue-700/);
  });
});
```

- [ ] **Step 4: `frontend/app/releases/[id]/layout.tsx` 작성**

```tsx
import { apiFetch } from "@/lib/api-server";
import { ReleaseHeader, type ReleaseHeaderData } from "@/components/ReleaseHeader";
import { ReleaseTabs } from "@/components/ReleaseTabs";
import { notFound } from "next/navigation";

export default async function ReleaseDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) notFound();
  const data = (await res.json()) as ReleaseHeaderData;

  return (
    <div className="flex flex-col gap-4">
      <ReleaseHeader data={data} />
      <ReleaseTabs releaseId={id} />
      {children}
    </div>
  );
}
```

- [ ] **Step 5: 테스트 + 빌드 확인**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 커밋**

```bash
git add frontend/app/releases/[id]/layout.tsx frontend/components/ReleaseHeader.tsx frontend/components/ReleaseTabs.tsx frontend/components/ReleaseTabs.test.tsx
git commit -m "feat(frontend): /releases/[id] nested layout with header + tabs"
```

---

### Task 4: 개요 탭 — MetricCards + InstancesTable

**Files:**
- Create: `frontend/components/MetricCards.tsx`
- Create: `frontend/components/MetricCards.test.tsx`
- Create: `frontend/components/InstancesTable.tsx`
- Create: `frontend/components/InstancesTable.test.tsx`
- Modify: `frontend/app/releases/[id]/page.tsx` (개요 탭으로 재작성, 헤더는 layout 이 그림)

스펙 §6.3. 4개 MetricCard (준비된 인스턴스, 재시작, 메모리, 접근 URL). 메모리·URL 은 overview API 에 아직 없을 수 있음 → "n/a" 로 fallback.

- [ ] **Step 1: 실패 테스트 — `frontend/components/MetricCards.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetricCards } from "./MetricCards";

describe("MetricCards", () => {
  it("renders ready/total instances", () => {
    render(<MetricCards readyTotal={[2, 3]} restarts={1} memory={null} accessURL={null} />);
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    // memory + accessURL fallback to "—"
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBe(2);
  });
});
```

- [ ] **Step 2: 구현 — `frontend/components/MetricCards.tsx`**

```tsx
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { termLabel } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

type Props = {
  readyTotal: [number, number];
  restarts: number;
  memory: string | null;
  accessURL: string | null;
};

export function MetricCards({ readyTotal, restarts, memory, accessURL }: Props) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  const L = (key: Parameters<typeof termLabel>[0]) => termLabel(key, kube);
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      <Metric label={L("readyInstances")} value={`${readyTotal[0]} / ${readyTotal[1]}`} />
      <Metric label={L("restarts")} value={String(restarts)} />
      <Metric label={L("memory")} value={memory ?? "—"} />
      <Metric label={L("accessURL")} value={accessURL ?? "—"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-1 text-xs text-slate-500">{label}</CardHeader>
      <CardContent className="pt-0 text-lg font-medium">{value}</CardContent>
    </Card>
  );
}
```

주의: `useKubeTermsStore` 는 client-only. `MetricCards` 는 client component 가 된다 → 파일 상단에 `"use client"` 필요.

수정: 파일 첫 줄에 `"use client";` 추가하고 테스트를 해당 환경에 맞춤.

- [ ] **Step 3: `frontend/lib/kube-term-map.ts` 작성**

```ts
const KUBE: Record<string, string> = {
  readyInstances: "Ready Pods",
  restarts: "Restart Count",
  memory: "Memory Usage",
  accessURL: "Service DNS",
  instances: "Pods",
  instanceId: "Pod Name",
};
const FRIENDLY: Record<keyof typeof KUBE, string> = {
  readyInstances: "준비된 인스턴스",
  restarts: "재시작",
  memory: "메모리",
  accessURL: "접근 URL",
  instances: "인스턴스",
  instanceId: "인스턴스 ID",
};

export type TermKey = keyof typeof KUBE;

export function termLabel(key: TermKey, kube: boolean): string {
  return (kube ? KUBE[key] : FRIENDLY[key]) ?? key;
}
```

- [ ] **Step 4: InstancesTable — `frontend/components/InstancesTable.tsx`**

```tsx
"use client";

import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatusChip, statusChipVariantFromRelease } from "./StatusChip";
import { termLabel } from "@/lib/kube-term-map";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export type Instance = {
  name: string;
  phase: string;
  ready: boolean;
  restarts: number;
};

export function InstancesTable({ releaseId, instances }: { releaseId: string; instances: Instance[] }) {
  const kube = useKubeTermsStore((s) => s.showKubeTerms);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{termLabel("instanceId", kube)}</TableHead>
          <TableHead>상태</TableHead>
          <TableHead>{termLabel("restarts", kube)}</TableHead>
          <TableHead className="w-20"></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {instances.map((i) => (
          <TableRow key={i.name}>
            <TableCell className="font-mono text-xs">{i.name}</TableCell>
            <TableCell>
              <StatusChip variant={statusChipVariantFromRelease(i.ready ? "healthy" : i.phase.toLowerCase())}>
                {i.phase}
              </StatusChip>
            </TableCell>
            <TableCell>{i.restarts}</TableCell>
            <TableCell>
              <Link href={`/releases/${releaseId}/logs?instance=${i.name}`} className="text-blue-700 hover:underline text-xs">
                로그 →
              </Link>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 5: 테스트 — `frontend/components/InstancesTable.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { InstancesTable } from "./InstancesTable";

describe("InstancesTable", () => {
  it("renders instance rows with logs link", () => {
    render(
      <InstancesTable
        releaseId="abc"
        instances={[{ name: "pod-1", phase: "Running", ready: true, restarts: 0 }]}
      />,
    );
    expect(screen.getByText("pod-1")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /로그/ });
    expect(link).toHaveAttribute("href", "/releases/abc/logs?instance=pod-1");
  });
});
```

- [ ] **Step 6: 테스트·빌드 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 새 테스트 포함 올 통과.

- [ ] **Step 7: `frontend/app/releases/[id]/page.tsx` 재작성 (개요 탭 본문)**

```tsx
import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import { MetricCards } from "@/components/MetricCards";
import { InstancesTable, type Instance } from "@/components/InstancesTable";

type ReleaseOverview = {
  id: string;
  instances_total: number;
  instances_ready: number;
  instances: Instance[];
};

export default async function ReleaseOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) notFound();
  const d = (await res.json()) as ReleaseOverview;
  const restarts = d.instances.reduce((s, i) => s + i.restarts, 0);

  return (
    <div className="flex flex-col gap-6">
      <MetricCards
        readyTotal={[d.instances_ready, d.instances_total]}
        restarts={restarts}
        memory={null}
        accessURL={null}
      />
      <section>
        <h2 className="mb-2 text-sm font-medium">인스턴스 ({d.instances.length})</h2>
        <InstancesTable releaseId={d.id} instances={d.instances} />
      </section>
    </div>
  );
}
```

- [ ] **Step 8: 커밋**

```bash
git add frontend/components/MetricCards.tsx frontend/components/MetricCards.test.tsx \
  frontend/components/InstancesTable.tsx frontend/components/InstancesTable.test.tsx \
  frontend/lib/kube-term-map.ts \
  frontend/app/releases/[id]/page.tsx
git commit -m "feat(frontend): release overview tab — MetricCards + InstancesTable"
```

---

### Task 5: k8s 용어 토글 스위치

**Files:**
- Create: `frontend/components/KubeTermsToggle.tsx`
- Modify: `frontend/components/ReleaseHeader.tsx` (우측에 토글 추가)

- [ ] **Step 1: `frontend/components/KubeTermsToggle.tsx`**

```tsx
"use client";

import { Switch } from "@/components/ui/switch";
import { useKubeTermsStore } from "@/stores/kube-terms-store";

export function KubeTermsToggle() {
  const show = useKubeTermsStore((s) => s.showKubeTerms);
  const toggle = useKubeTermsStore((s) => s.toggle);
  return (
    <label className="inline-flex items-center gap-2 text-xs text-slate-600">
      <Switch checked={show} onCheckedChange={toggle} />
      원본 k8s 용어 보기
    </label>
  );
}
```

- [ ] **Step 2: `ReleaseHeader.tsx` — 오른쪽 정렬로 토글 배치**

기존 `<header className="flex flex-col gap-2">` 블록을 2단 구성으로:

```tsx
import { KubeTermsToggle } from "./KubeTermsToggle";
// ...
return (
  <header className="flex flex-col gap-2">
    <div className="flex items-center gap-3">
      <h1 className="font-mono text-xl font-medium">{data.name}</h1>
      <StatusChip variant={statusChipVariantFromRelease(data.status)}>
        {data.status}
      </StatusChip>
      <div className="ml-auto">
        <KubeTermsToggle />
      </div>
    </div>
    {/* meta line unchanged */}
  </header>
);
```

- [ ] **Step 3: 빌드 + 스모크**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과.

브라우저: `/releases/<id>` 에서 우상단 Switch 토글 → MetricCard 라벨·InstancesTable 헤더가 영어 용어로 바뀌는지.

- [ ] **Step 4: 커밋**

```bash
git add frontend/components/KubeTermsToggle.tsx frontend/components/ReleaseHeader.tsx
git commit -m "feat(frontend): k8s terms toggle in release header"
```

---

### Task 6: 로그 탭 — `/releases/[id]/logs` + SSE 소비

**Files:**
- Create: `frontend/app/releases/[id]/logs/page.tsx`
- Create: `frontend/components/LogsPanel.tsx`
- Create: `frontend/components/LogsPanel.test.tsx`

로그 스트리밍은 Next.js BFF 를 거치지 않고 **브라우저 → Go API 직접 접근**하면 쿠키 인증이 안 되므로, Route Handler 를 하나 만들어 프록시할지 / Go 서버가 same-origin 쿠키를 받을지 결정해야 한다. 현재 BFF 아키텍처 원칙(CLAUDE.md: Browser → Next.js Route Handler → Go API) 에 따라 **Next.js Route Handler** 로 프록시한다.

하지만 SSE 프록시는 Next.js 에서 `Response` 로 ReadableStream 을 그대로 forward 하면 된다 — 별도 라이브러리 불필요. 아래 Step 1 이 그것.

- [ ] **Step 1: Next.js Route Handler — `frontend/app/api/v1/releases/[id]/logs/route.ts`**

```ts
import { apiFetch } from "@/lib/api-server";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const upstream = await apiFetch(`/v1/releases/${id}/logs${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
```

주의: `apiFetch` 가 cookie/session 을 자동으로 Go API 호출에 실어야 한다. 기존 구현이 그렇게 하고 있음 (`frontend/lib/api-server.ts`). 확인 후 필요하면 이 Step 에서 조정.

- [ ] **Step 2: `LogsPanel.tsx` — EventSource 소비 client component**

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type LogEntry = { time: number; pod: string; text: string };

type Props = { releaseId: string; instances: { name: string }[] };

type Status = "connecting" | "connected" | "disconnected";

export function LogsPanel({ releaseId, instances }: Props) {
  const [instance, setInstance] = useState("all");
  const [lines, setLines] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [autoscroll, setAutoscroll] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setStatus("connecting");
    const es = new EventSource(`/api/v1/releases/${releaseId}/logs?instance=${encodeURIComponent(instance)}`);
    es.addEventListener("log", (e: MessageEvent) => {
      try {
        setLines((prev) => [...prev.slice(-1999), JSON.parse(e.data) as LogEntry]);
      } catch {
        /* ignore */
      }
    });
    es.onopen = () => setStatus("connected");
    es.onerror = () => setStatus("disconnected");
    return () => {
      es.close();
    };
  }, [releaseId, instance]);

  useEffect(() => {
    if (!autoscroll) return;
    boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight });
  }, [lines, autoscroll]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs">
        <ConnectionDot status={status} />
        <Select value={instance} onValueChange={setInstance}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">전체 인스턴스</SelectItem>
            {instances.map((i) => (
              <SelectItem key={i.name} value={i.name}>{i.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="ml-auto inline-flex items-center gap-1">
          <Switch checked={autoscroll} onCheckedChange={setAutoscroll} />
          Auto-scroll
        </label>
        <button
          onClick={() => setLines([])}
          className="rounded border px-2 py-0.5 hover:bg-slate-50"
        >
          Clear
        </button>
      </div>
      <div
        ref={boxRef}
        className="h-[60vh] overflow-auto rounded bg-slate-950 p-3 font-mono text-[12px] leading-relaxed text-slate-100"
      >
        {lines.map((l, idx) => (
          <div key={idx} className="whitespace-pre">
            <span className="text-slate-500">[{new Date(l.time).toLocaleTimeString()}]</span>{" "}
            <span className="text-cyan-300">[{l.pod}]</span> {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionDot({ status }: { status: Status }) {
  const color =
    status === "connected" ? "bg-green-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500";
  const label =
    status === "connected" ? "연결됨" : status === "connecting" ? "연결 중" : "끊김";
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
```

- [ ] **Step 3: 테스트 — `frontend/components/LogsPanel.test.tsx`** (connection 상태 스모크)

```tsx
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import { LogsPanel } from "./LogsPanel";

beforeAll(() => {
  // @ts-expect-error — jsdom EventSource stub
  global.EventSource = class {
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener() {}
    close() {}
  };
});

describe("LogsPanel", () => {
  it("starts in 'connecting' state", () => {
    render(<LogsPanel releaseId="abc" instances={[{ name: "p1" }]} />);
    expect(screen.getByText("연결 중")).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: `frontend/app/releases/[id]/logs/page.tsx`**

```tsx
import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import { LogsPanel } from "@/components/LogsPanel";

export default async function ReleaseLogsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const res = await apiFetch(`/v1/releases/${id}`);
  if (!res.ok) notFound();
  const d = (await res.json()) as { id: string; instances: { name: string }[] };
  return <LogsPanel releaseId={d.id} instances={d.instances} />;
}
```

- [ ] **Step 5: 빌드·테스트·린트 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 6: 브라우저 스모크** (dev 필요: 백엔드 + k3d 실제 pod)

- `/releases/<id>` → 개요 탭: MetricCards + Instances 표시
- 탭 "로그" 클릭 → `/releases/<id>/logs` 로 이동, 연결 상태 "연결 중" → "연결됨"
- Select 에서 특정 pod 고르면 스트림 재연결
- 새 로그가 auto-scroll 되어 내려옴
- 탭 "개요" 로 복귀 시 EventSource 가 unmount 로 close

- [ ] **Step 7: 커밋**

```bash
git add frontend/app/api/v1/releases/[id]/logs/route.ts \
  frontend/components/LogsPanel.tsx frontend/components/LogsPanel.test.tsx \
  frontend/app/releases/[id]/logs/page.tsx
git commit -m "feat(frontend): release logs tab — SSE consumer + filter + autoscroll"
```

---

### Task 7: UpdateAvailableBadge — 업데이트 가능 뱃지 (optional, Plan 3 연계)

**Files:**
- Create: `frontend/components/UpdateAvailableBadge.tsx`
- Modify: `frontend/components/ReleaseHeader.tsx`

스펙 §6.2, §6.7: 현재 릴리스 버전 < 최신 non-deprecated published 버전일 때 "업데이트 가능 · v{old} → v{new}" 뱃지 표시. 클릭 → `/catalog/<name>/versions/<v>/deploy?updateReleaseId=<id>` (Plan 3 가 이 라우트 구현).

릴리스 응답에 `template.name`, `template.version` 는 있지만 **"최신 published 버전"** 은 별도 조회 필요: `GET /v1/templates/:name` 이 가장 최신 메타를 반환한다고 가정 (현재 구현 기준). 없으면 skip 하고 후속.

- [ ] **Step 1: `frontend/components/UpdateAvailableBadge.tsx`**

```tsx
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

type Props = {
  templateName: string;
  currentVersion: number;
  latestVersion: number;
  releaseId: string;
};

export function UpdateAvailableBadge({ templateName, currentVersion, latestVersion, releaseId }: Props) {
  if (latestVersion <= currentVersion) return null;
  return (
    <Link
      href={`/catalog/${templateName}/versions/${latestVersion}/deploy?updateReleaseId=${releaseId}`}
      className="inline-flex"
    >
      <Badge variant="warning">
        업데이트 가능 · v{currentVersion} → v{latestVersion}
      </Badge>
    </Link>
  );
}
```

- [ ] **Step 2: layout.tsx 가 최신 버전을 fetch 해서 header 로 전달**

`frontend/app/releases/[id]/layout.tsx` 에서 2번째 fetch 추가:

```tsx
const latestRes = await apiFetch(`/v1/templates/${data.template.name}`);
const latest = latestRes.ok
  ? ((await latestRes.json()) as { current_version: number })
  : null;
```

그리고 `<ReleaseHeader data={data} latestVersion={latest?.current_version ?? null} />` 로 전달.

- [ ] **Step 3: `ReleaseHeader` 의 props 확장 + 렌더**

```tsx
export function ReleaseHeader({ data, latestVersion }: { data: ReleaseHeaderData; latestVersion: number | null }) {
  // ...
  // StatusChip 옆에:
  {latestVersion !== null && (
    <UpdateAvailableBadge
      templateName={data.template.name}
      currentVersion={data.template.version}
      latestVersion={latestVersion}
      releaseId={data.id}
    />
  )}
  // ...
}
```

- [ ] **Step 4: 빌드·린트 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 5: 커밋**

```bash
git add frontend/components/UpdateAvailableBadge.tsx frontend/components/ReleaseHeader.tsx frontend/app/releases/[id]/layout.tsx
git commit -m "feat(frontend): UpdateAvailableBadge in release header"
```

---

## 검증 (End-to-end)

1. **백엔드 테스트·빌드**:
   ```bash
   cd backend && go test ./... && go build ./...
   ```

2. **프론트 테스트·빌드**:
   ```bash
   cd frontend && pnpm test && pnpm lint && pnpm build
   ```

3. **통합 스모크** (local k3d + dev 서버):
   - `/releases/<id>` → 헤더 + 개요 탭 (MetricCards, InstancesTable) 렌더
   - 탭 "로그" 클릭 → SSE 연결 상태가 "연결 중" → "연결됨" 으로 전이
   - pod 생성/삭제가 없는 idle 환경에서도 15초마다 `ping` 이벤트로 연결 유지 (네트워크 로그에 `event: ping` 라인 확인)
   - 특정 pod 을 `kubectl exec -- sh -c 'echo hello && sleep 1'` 로 로그 발생시켜 브라우저에 실시간 표시 확인
   - "원본 k8s 용어 보기" 토글: 헤더 MetricCards 라벨이 `준비된 인스턴스` ↔ `Ready Pods` 로 바뀌는지
   - 새 버전이 있으면 `UpdateAvailableBadge` 가 보이고, 클릭 시 Plan 3 의 deploy 업데이트 라우트로 이동 (Plan 3 미완 시엔 404 가 나면 정상)

4. **리그레션**:
   - `/releases` 리스트 여전히 잘 동작
   - 기존 Plan 0 의 RoleBadge·StatusChip 동작 유지

---

## 스코프 밖 (후속)

- Activity 탭 (§6.1) — 이 플랜 범위 밖. `/releases/[id]/activity/page.tsx` 는 추후.
- Settings 탭 (§6.1, §6.7 AlertDialog 삭제 확인) — 추후 별도 플랜.
- 릴리스 업데이트 PUT 엔드포인트 및 업데이트 폼 — Plan 3 에서 처리.
