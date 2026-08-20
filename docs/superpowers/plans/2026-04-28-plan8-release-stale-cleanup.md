# Plan 8 — Release Stale Cleanup (2026-04-28)

> **Status**: ✅ merged (PR #35). Plan 7 (visual refresh + i18n) 머지 후 후속.
> **Stage 1 only.** 백그라운드 reconcile 루프 / SA 토큰 / DB 컬럼 추가 (= Stage 2) 는 Plan 9 자리에 별도 플랜으로 미룸 (CLAUDE.md plan 표 참조).

## 동기

Plan 0–7 에서 릴리스 CRUD 와 비주얼/i18n 까지 완성됐지만, **DB 의 릴리스 레코드와 클러스터의 실제 k8s 상태가 어긋날 때 회수 경로가 없다.** Plan 7 머지 후 첫 테스트 세션(2026-04-28) 에서 다음 시나리오가 재현됐다:

1. 사용자가 `kind` 클러스터에 `test-web` 릴리스를 정상 배포 → DB·k8s 일치.
2. 다음 세션 전에 `kind delete cluster --name kubeport` (또는 머신 재부팅·클러스터 재구성 등) 으로 클러스터가 사라짐.
3. 앱은 그 사실을 모름. DB 에는 레코드가 남고 k8s 에는 리소스가 없음.
4. 사용자가 `/releases/<id>` 페이지를 열면 — 헤더 + `unknown` 칩 + 0/0 metric + 빈 instances 테이블만 보임. **왜 그런지 설명이 없음.**
5. 삭제 시도 → 그러나 프런트에 삭제 UI 가 자체가 없고, 설령 `DELETE /v1/releases/:id` 를 직접 호출해도 백엔드가 k8s 호출(`cli.DeleteByRelease`)을 먼저 시도해 502 로 실패. **DB row 가 영원히 남는다.**

근본 해결은 **백그라운드 reconcile 루프 + SA 토큰 기반 무인 인증**이지만 (Plan 9 로 별도 분리, ~4–5d 공수), 당장 필요한 건:

- **(a)** 사용자에게 "왜 비어 있는지" 명확한 설명, 일반 사용자에게는 admin 에 문의하라는 안내.
- **(b)** admin 이 DB row 를 깔끔하게 정리할 수 있는 길 (k8s 응답과 무관하게).

이 플랜은 그 두 가지만 다룬다. DB write 없음, 백그라운드 프로세스 없음.

## 범위(Scope)

**IN**:

- 백엔드 `GetRelease` 응답의 `status` 분류 확장 (read-time 계산만, DB write 없음):
  - 기존: `healthy` / `warning` / `error` / `unknown`.
  - 추가: `cluster-unreachable` (k8s factory 생성 또는 list 호출 실패), `resources-missing` (호출 성공 + 매칭 리소스 없음).
- `DELETE /v1/releases/:id?force=true` 옵션 — **admin 전용**. k8s 호출 건너뛰고 DB 레코드만 정리.
- 릴리스 상세 페이지에 explainer 배너 — 위 두 status 일 때 노출:
  - 일반 사용자: 상황 설명 + "관리자에게 문의하세요".
  - admin: 같은 설명 + `[강제 삭제]` 버튼 (확인 다이얼로그 포함).
- `StatusChip` 매핑에 새 status 두 개 추가 (variant 자체 신설은 하지 않고 기존 `warning` / `error` 에 매핑).
- ko/en i18n 문자열 추가 (Plan 7 의 `next-intl` 인프라 위에 얹는다).

**OUT (= Stage 2 별도 플랜에서 다룸)**:

- 백그라운드 reconcile 루프, ServiceAccount 토큰 저장(암호화), leader election.
- DB 컬럼 추가 (`releases.observed_status`, `releases.last_observed_at`).
- `/v1/clusters/:name` cascade-delete 또는 unregister 정리.
- 릴리스 리스트 (`/releases`) 에서의 force-delete 진입 — 상세 페이지에서만 노출 (확인 절차 강제·혼동 방지).
- 일반 사용자 본인 (release owner) 의 force-delete 권한 — 현재는 admin only.

## 의존성 / 작업 환경

- Plan 7 (i18n 인프라) 가 main 에 머지된 후 시작. `next-intl` 의 `getTranslations` (server) / `useTranslations` (client) 와 `frontend/messages/{ko,en}.json` 사용.
- 기존 `/v1/me` 엔드포인트 (Plan 6 부터 권한 판정에 사용) 와 `KBP_DEV_ADMIN_EMAILS` / `kubeport-admin` 그룹 판정 로직 (`backend/internal/api/releases.go:53` `isAdmin`) 그대로 사용.
- 별도 브랜치 `feat/plan8-release-stale-cleanup`, 워크트리 권장. 추정 공수 1.5–2 영업일.

## 파일 구조

| 파일 | 작업 | 역할 |
|---|---|---|
| `backend/internal/api/releases.go` | modify | `GetRelease` / `respondReleaseOverview` 의 status 분류 확장 + `DeleteRelease` 의 `force` 옵션 |
| `backend/internal/api/releases_test.go` | modify | 새 status 케이스 + force-delete 테스트 |
| `frontend/components/StatusChip.tsx` | modify | `cluster-unreachable` / `resources-missing` → variant 매핑 추가 |
| `frontend/components/ReleaseStaleBanner.tsx` | create | 배너 (server component) — 메시지 + (admin 일 때) 강제삭제 버튼 mount |
| `frontend/components/ForceDeleteButton.tsx` | create | client component — confirm dialog → DELETE 호출 → `/releases` 라우팅 |
| `frontend/app/releases/[id]/layout.tsx` | modify | `/v1/me` 동시 fetch + 배너 조건부 렌더 |
| `frontend/messages/ko.json` | modify | 새 키 (`releases.status.*` 확장 + `releases.stale.*`) |
| `frontend/messages/en.json` | modify | 동일 |
| `frontend/components/ReleaseStaleBanner.test.tsx` | create | vitest |
| `frontend/components/ForceDeleteButton.test.tsx` | create | vitest |

## Tasks

### T1 — 백엔드: `GetRelease` status 분류 확장

`backend/internal/api/releases.go` 의 `GetRelease` (라인 251–286) 와 `respondReleaseOverview` (292–316) 수정.

현재 세 가지 실패 경로 (`auth.UserFrom` false / `K8sFactory.NewWithToken` 실패 / `cli.ListInstances` 실패) 가 모두 `respondReleaseOverview(c, rel, nil)` 로 합쳐지고, 결과 status 가 `abstractStatus([])` → `"unknown"` 으로 일률 처리된다. 다음과 같이 분류한다:

- `K8sFactory.NewWithToken` 실패 → `"cluster-unreachable"` (URL 파싱·TLS·CA 문제 포함).
- `cli.ListInstances` 실패 → `"cluster-unreachable"` (대부분 connection refused / timeout).
- `cli.ListInstances` 성공 + `len(instances) == 0` → `"resources-missing"`.
- `auth.UserFrom` 실패 (이론상 발생 안 함, 미들웨어 보장) → 기존 `"unknown"` 유지.
- 그 외 정상 경로 → 기존 `abstractStatus(instances)` 그대로.

`respondReleaseOverview` 시그니처에 `statusOverride string` 인자를 추가 — 빈 문자열이면 기존처럼 `abstractStatus` 호출:

```go
func (h *Handlers) GetRelease(c *gin.Context) {
    // ... 기존: ID 파싱 / Store.GetReleaseByID / authorize 그대로.

    u, ok := auth.UserFrom(ctx)
    if !ok {
        respondReleaseOverview(c, rel, nil, "unknown")
        return
    }
    cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
    if err != nil {
        respondReleaseOverview(c, rel, nil, "cluster-unreachable")
        return
    }
    instances, err := cli.ListInstances(ctx, rel.Namespace, rel.Name)
    if err != nil {
        respondReleaseOverview(c, rel, nil, "cluster-unreachable")
        return
    }
    if len(instances) == 0 {
        respondReleaseOverview(c, rel, instances, "resources-missing")
        return
    }
    respondReleaseOverview(c, rel, instances, "")
}

func respondReleaseOverview(c *gin.Context, rel store.GetReleaseByIDRow, instances []k8s.Instance, statusOverride string) {
    if instances == nil {
        instances = []k8s.Instance{}
    }
    ready := 0
    for _, i := range instances {
        if i.Ready {
            ready++
        }
    }
    status := statusOverride
    if status == "" {
        status = abstractStatus(instances)
    }
    c.JSON(http.StatusOK, gin.H{
        "id": rel.ID, "name": rel.Name,
        "template":        gin.H{"name": rel.TemplateName, "version": rel.TemplateVersion},
        "cluster":         rel.ClusterName,
        "namespace":       rel.Namespace,
        "values_json":     rel.ValuesJson,
        "rendered_yaml":   rel.RenderedYaml,
        "instances_total": len(instances),
        "instances_ready": ready,
        "instances":       instances,
        "status":          status,
        "created_at":      rel.CreatedAt,
    })
}
```

`abstractStatus` 자체는 그대로 둔다. `len(instances) == 0` 분기에서 `"unknown"` 을 반환하던 기존 코드 라인은 더 이상 도달하지 않지만, 안전망으로 유지.

### T2 — 백엔드: `DELETE /v1/releases/:id?force=true` (admin only)

`backend/internal/api/releases.go` 의 `DeleteRelease` (라인 343–377) 수정.

- `c.Query("force") == "true"` 일 때 k8s 호출 단계 (`NewWithToken` + `DeleteByRelease`) 를 건너뛴다.
- `force=true` 는 **admin 만 허용** (`isAdmin(c)` true). 비admin 은 `403 rbac-denied`.
- 기존 `authorizeReleaseAccess` 는 그대로 통과해야 함 (admin 이 아닌 owner 는 통과). admin 가드는 그 위에 추가.
- 정상 force 경로: DB DELETE 만 수행. 응답 `{"deleted": true, "force": true}`.
- 비force 경로: 기존 동작 그대로 (k8s 먼저 → DB).
- **감사용 로그**: force 경로에서 한 줄. `log.Printf("force-delete: user=%s release_id=%s", u.Email, id)` — 별도 audit 시스템 도입 전 임시.

```go
func (h *Handlers) DeleteRelease(c *gin.Context) {
    id, err := parseUUID(c.Param("id"))
    if err != nil {
        writeError(c, http.StatusBadRequest, "validation-error", "invalid release id")
        return
    }
    ctx := c.Request.Context()
    u, _ := auth.UserFrom(ctx)

    rel, err := h.deps.Store.GetReleaseByID(ctx, id)
    if err != nil {
        writeError(c, http.StatusNotFound, "not-found", "release")
        return
    }

    if !h.authorizeReleaseAccess(c, rel) {
        return
    }

    force := c.Query("force") == "true"
    if force && !isAdmin(c) {
        writeError(c, http.StatusForbidden, "rbac-denied", "force delete requires admin")
        return
    }

    if !force {
        cli, err := h.deps.K8sFactory.NewWithToken(rel.ClusterApiUrl, rel.ClusterCaBundle.String, u.IDToken)
        if err != nil {
            writeError(c, http.StatusInternalServerError, "k8s-error", err.Error())
            return
        }
        if err := cli.DeleteByRelease(ctx, rel.Namespace, rel.Name); err != nil {
            writeError(c, http.StatusBadGateway, "k8s-error", err.Error())
            return
        }
    } else {
        log.Printf("force-delete: user=%s release_id=%s name=%s cluster=%s",
            u.Email, id, rel.Name, rel.ClusterName)
    }

    if err := h.deps.Store.DeleteRelease(ctx, id); err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    c.JSON(http.StatusOK, gin.H{"deleted": true, "force": force})
}
```

### T3 — 백엔드 테스트

`backend/internal/api/releases_test.go` 에 추가. 기존 `K8sFactory` mock (정상/실패 분기) 와 테이블 테스트 패턴을 그대로 따른다.

추가 테스트 케이스 (이름은 기존 컨벤션에 맞춰 조정):

```go
func TestGetRelease_FactoryError_ReturnsClusterUnreachable(t *testing.T) {
    // factory.NewWithToken 가 error 를 반환하도록 설정.
    // GET /v1/releases/<id> 호출.
    // assert: HTTP 200, body.status == "cluster-unreachable", instances == [].
}

func TestGetRelease_ListInstancesError_ReturnsClusterUnreachable(t *testing.T) {
    // factory 는 OK, cli.ListInstances 가 error 를 반환하도록 설정.
    // assert: body.status == "cluster-unreachable", instances == [].
}

func TestGetRelease_EmptyInstances_ReturnsResourcesMissing(t *testing.T) {
    // cli.ListInstances 가 ([], nil) 반환.
    // assert: body.status == "resources-missing", instances == [].
}

func TestDeleteRelease_ForceAdmin_BypassesK8s(t *testing.T) {
    // admin 토큰으로 DELETE /v1/releases/<id>?force=true.
    // factory.NewWithToken 가 호출되지 **않아야** 함 (mock 호출 카운터 검증).
    // DB 에서 행 삭제 확인.
    // 응답 body: {"deleted": true, "force": true}.
}

func TestDeleteRelease_ForceNonAdmin_Forbidden(t *testing.T) {
    // 일반 사용자 (release owner) 로 DELETE ?force=true.
    // 403 rbac-denied.
    // DB 에서 행이 그대로 남아 있는지 확인.
    // factory.NewWithToken 호출 카운터 0.
}

func TestDeleteRelease_NoForce_StillRequiresK8sSuccess(t *testing.T) {
    // 회귀 방어: force 없이 호출, k8s DeleteByRelease 가 실패하면 502 + DB 그대로.
    // 기존 동작이 깨지지 않는지 보장.
}
```

기존 `releases_test.go` 의 mock 구조와 테이블 테스트 케이스를 한두 개 복사 후 변형하는 식으로 작성. mock K8sFactory 가 호출 카운터를 노출하지 않으면 추가 (간단한 atomic.Int32 한 개).

### T4 — 프런트: `StatusChip` 매핑 + i18n 문자열

**`frontend/components/StatusChip.tsx`** (modify):

`statusChipVariantFromRelease(status: string)` 매핑에 두 항목 추가:

- `"cluster-unreachable"` → `"warning"` (amber).
- `"resources-missing"` → `"danger"` (red).

StatusChip variant 자체는 신설하지 않는다 — `frontend/components/StatusChip.tsx` 의 기존 `StatusVariant` 4종 (`success` / `warning` / `danger` / `muted`) 재사용으로 충분.

**`frontend/messages/ko.json`** (modify) — 키 추가:

```json
{
  "releases": {
    "status": {
      "healthy": "정상",
      "warning": "주의",
      "error": "오류",
      "unknown": "알 수 없음",
      "cluster-unreachable": "클러스터 응답 없음",
      "resources-missing": "리소스 없음"
    },
    "stale": {
      "title": {
        "cluster-unreachable": "클러스터에 접근할 수 없습니다",
        "resources-missing": "클러스터에 해당 리소스가 없습니다"
      },
      "body": {
        "cluster-unreachable": "클러스터 {cluster} 가 응답하지 않습니다. 일시적인 네트워크 문제이거나, 더 이상 운영되지 않는 클러스터일 수 있습니다.",
        "resources-missing": "릴리스 레코드는 있지만 클러스터에 매칭되는 리소스가 없습니다. 외부에서 삭제됐거나 클러스터가 재구성됐을 수 있습니다."
      },
      "contactAdmin": "이 릴리스를 정리하려면 관리자에게 문의하세요.",
      "forceDelete": {
        "button": "강제 삭제",
        "confirm": "이 릴리스의 DB 레코드만 삭제합니다. 클러스터에는 영향을 주지 않습니다. 계속하시겠습니까?",
        "failed": "삭제 실패: {error}"
      }
    }
  }
}
```

**`frontend/messages/en.json`** (modify) — 동일 키:

```json
{
  "releases": {
    "status": {
      "healthy": "healthy",
      "warning": "warning",
      "error": "error",
      "unknown": "unknown",
      "cluster-unreachable": "cluster unreachable",
      "resources-missing": "resources missing"
    },
    "stale": {
      "title": {
        "cluster-unreachable": "Cluster is unreachable",
        "resources-missing": "Resources not found in cluster"
      },
      "body": {
        "cluster-unreachable": "Cluster {cluster} is not responding. This may be a transient network issue or the cluster may no longer be operational.",
        "resources-missing": "The release record exists but no matching resources were found in the cluster. They may have been deleted externally or the cluster may have been rebuilt."
      },
      "contactAdmin": "Contact an admin to clean up this release.",
      "forceDelete": {
        "button": "Force delete",
        "confirm": "This deletes only the DB record. The cluster will not be touched. Continue?",
        "failed": "Delete failed: {error}"
      }
    }
  }
}
```

기존 `releases.status.*` 키가 Plan 7 결과로 이미 존재한다면 누락된 것만 추가. `releases.stale.*` 는 신규 네임스페이스.

### T5 — 프런트: `ReleaseStaleBanner` (server component)

**`frontend/components/ReleaseStaleBanner.tsx`** (create):

```tsx
import { getTranslations } from "next-intl/server";
import { ServerCrash, AlertTriangle } from "lucide-react";
import { ForceDeleteButton } from "./ForceDeleteButton";

type StaleStatus = "cluster-unreachable" | "resources-missing";

export async function ReleaseStaleBanner({
  status,
  releaseId,
  cluster,
  isAdmin,
}: {
  status: StaleStatus;
  releaseId: string;
  cluster: string;
  isAdmin: boolean;
}) {
  const t = await getTranslations("releases.stale");
  const Icon = status === "cluster-unreachable" ? ServerCrash : AlertTriangle;
  return (
    <div className="flex gap-3 rounded-xl border border-amber-300/60 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex-1 space-y-2">
        <p className="font-medium">{t(`title.${status}`)}</p>
        <p className="text-sm text-muted-foreground">
          {t(`body.${status}`, { cluster })}
        </p>
        {isAdmin ? (
          <ForceDeleteButton releaseId={releaseId} />
        ) : (
          <p className="text-sm">{t("contactAdmin")}</p>
        )}
      </div>
    </div>
  );
}
```

색·라운드는 Plan 7 의 토큰 (`amber-300/60`, `bg-amber-50`) 사용. 정확한 토큰 클래스명은 작업 시 `frontend/app/globals.css` 에서 재확인. 다크 모드 변형은 Plan 7 이 이미 깔아둔 토큰을 따른다.

### T6 — 프런트: `ForceDeleteButton` (client) + 레이아웃 wiring

**`frontend/components/ForceDeleteButton.tsx`** (create):

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

export function ForceDeleteButton({ releaseId }: { releaseId: string }) {
  const t = useTranslations("releases.stale.forceDelete");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (!window.confirm(t("confirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/releases/${releaseId}?force=true`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body || res.statusText);
      }
      router.push("/releases");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="destructive" size="sm" onClick={onClick} disabled={busy}>
        {t("button")}
      </Button>
      {error && (
        <span className="text-sm text-destructive">
          {t("failed", { error })}
        </span>
      )}
    </div>
  );
}
```

`window.confirm` 1차 사용 — shadcn `AlertDialog` 로의 격상은 별도 작은 PR 로 분리 가능 (열린 질문 #2).

**`frontend/app/releases/[id]/layout.tsx`** (modify) — `/v1/me` 동시 fetch + 배너 조건부 렌더:

```tsx
import { apiFetch } from "@/lib/api-server";
import { ReleaseHeader, type ReleaseHeaderData } from "@/components/ReleaseHeader";
import { ReleaseTabs } from "@/components/ReleaseTabs";
import { ReleaseStaleBanner } from "@/components/ReleaseStaleBanner";
import { notFound } from "next/navigation";

const STALE_STATUSES = new Set(["cluster-unreachable", "resources-missing"]);

export default async function ReleaseDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [relRes, meRes] = await Promise.all([
    apiFetch(`/v1/releases/${id}`),
    apiFetch("/v1/me"),
  ]);
  if (!relRes.ok) notFound();
  const data = (await relRes.json()) as ReleaseHeaderData;
  const me = meRes.ok ? await meRes.json() : { groups: [] };
  const isAdmin = (me.groups ?? []).includes("kubeport-admin");

  return (
    <div className="flex flex-col gap-4">
      <ReleaseHeader data={data} />
      {STALE_STATUSES.has(data.status) && (
        <ReleaseStaleBanner
          status={data.status as "cluster-unreachable" | "resources-missing"}
          releaseId={id}
          cluster={data.cluster}
          isAdmin={isAdmin}
        />
      )}
      <ReleaseTabs releaseId={id} />
      {children}
    </div>
  );
}
```

`/v1/me` 응답 형태는 작업 시 `backend/internal/api/me.go` 에서 확인. `groups` 키가 다르면 거기에 맞춰 수정. Plan 6 의 템플릿 페이지가 이미 같은 방식으로 admin 판정을 하므로 그 코드를 참고할 것.

### T7 — 프런트 테스트

**`frontend/components/ReleaseStaleBanner.test.tsx`** (create):

- `isAdmin=true` → `ForceDeleteButton` 렌더, contactAdmin 메시지 미렌더.
- `isAdmin=false` → contactAdmin 렌더, 버튼 미렌더.
- status 별로 title/body 메시지 키가 올바르게 매칭 (`getByText` 또는 i18n mock 검증).
- ko/en 양쪽 메시지 파일에 모든 키가 존재 — `import` 후 `Object.keys` 비교로 누락 검증.

**`frontend/components/ForceDeleteButton.test.tsx`** (create):

- 클릭 → `confirm` 거부 → `fetch` 미호출.
- 클릭 → `confirm` 승인 → `fetch` 호출 (URL `/api/v1/releases/<id>?force=true`, method `DELETE`), 200 응답 → `router.push("/releases")` 호출.
- 실패 응답 (4xx/5xx) → 에러 메시지 표시 (`failed` 키 포맷팅 확인), busy 해제.

Playwright e2e 까지 가지 않는다 (Stage 1 범위 밖). 단위 테스트만으로 충분 — 통합 동작은 검증 시나리오에서 수동.

## 작업 방법

- 별도 워크트리 `feat/plan8-release-stale-cleanup`. Plan 7 main 머지 후 시작.
- 커밋 단위 (대략 6 커밋):
  - `feat(plan8/T1-T2): backend status classification + force-delete`
  - `test(plan8/T3): backend tests for new status + force-delete`
  - `feat(plan8/T4): StatusChip mappings + i18n strings (ko/en)`
  - `feat(plan8/T5): ReleaseStaleBanner component`
  - `feat(plan8/T6): ForceDeleteButton + release layout wiring`
  - `test(plan8/T7): frontend tests for banner + force-delete button`
- 각 커밋은 빌드·lint·기존 테스트 통과 상태로.
- PR 제목: `feat(plan8): release stale cleanup (Stage 1 — force-delete + status 분류)`.
- PR 설명에 본문 한 줄: "Stage 2 (백그라운드 reconcile + SA 토큰) 는 별도 플랜으로 미룸 — `docs/superpowers/plans/2026-04-XX-release-reconciler.md` (작성 예정)."
- 머지 후 `CLAUDE.md` 의 plan 표에 Plan 8 항목 추가, Stage 2 자리도 표 아래 메모로 남김.

## 검증 시나리오 (수동)

1. `docs/local-e2e.md` 절차로 풀 e2e 셋업 (kind + 백엔드 + 프런트).
2. alice 로 로그인, `web` 템플릿 v1 배포.
3. `/releases/<id>` 정상 status `healthy` 확인.
4. `kind delete cluster --name kubeport`.
5. 페이지 새로고침 → 헤더 칩이 `cluster-unreachable` 로, 배너가 노출되어야 함. **alice 는 "관리자에게 문의" 메시지만 보임 (강제 삭제 버튼 없음).**
6. `admin@example.com` 으로 재로그인 → 같은 페이지에서 `[강제 삭제]` 버튼 노출 확인.
7. 클릭 → confirm → DB row 삭제 → `/releases` 로 라우팅 → 목록에서 사라짐 확인.
8. `kind create cluster ...` 로 새 클러스터 띄우고 새 릴리스 만든 후 `kubectl delete deploy/web -n default` 로 외부 삭제 → 페이지 status 가 `resources-missing` 으로 분기되는지 확인.
9. ko/en 로케일 토글로 양쪽 문구 확인.

## 열린 질문

1. **Force-delete 스코프**: admin 외에 release owner 본인도 허용할지. 현재는 admin only — 운영 사고 회수 도구 성격이므로 안전 우선. 향후 사용자 피드백 보고 재검토.
2. **확인 다이얼로그**: 1차로 `window.confirm`. shadcn `AlertDialog` 격상은 별도 작은 PR 로 분리 가능.
3. **i18n 키 위치**: `releases.stale.*` 네임스페이스 신설로 가정. Plan 7 T8 결과의 메시지 구조와 충돌 시 거기에 맞춰 평탄화 또는 재배치.
4. **"resources-missing" 의 race window**: 릴리스 생성 직후 pod 가 뜨기 전 짧은 구간 (보통 < 10s) 에 `len(instances) == 0` 이 될 수 있음 → 새 릴리스가 잠시 "리소스 없음" 으로 잘못 분류될 위험. 회피책 후보:
    - **(a)** `cli.ListInstances` 외에 Deployment / StatefulSet / Service 같은 워크로드 존재 여부도 별도로 조회 후, **둘 다 없을 때만** `resources-missing` 분류. (정확하지만 호출 1–2회 추가)
    - **(b)** `release.created_at` 이 N초 (예: 60s) 미만이면 분류 보류, 기존 `unknown` 폴백.
    - T1 구현 시 `internal/k8s` 패키지에서 `ListInstances` 가 무엇을 보는지 확인 후 (a) 가 가능한 형태인지 판단. 불가능하거나 비용이 크면 (b) 로.
5. **로그 형식**: T2 의 `log.Printf("force-delete: ...")` 한 줄로 충분한가, 또는 audit 테이블 (별도 플랜) 까지 갈지. Stage 1 에서는 한 줄로 시작.
