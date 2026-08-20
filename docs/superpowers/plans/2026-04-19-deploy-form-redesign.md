# Deploy Form Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 배포 폼 화면 (`/catalog/[name]/deploy`, `/catalog/[name]/versions/[v]/deploy`) 을 스펙 §5 에 맞춰 재설계 — shadcn 기반 `DynamicForm` (type별 위젯 자동 매핑), `lib/ui-spec-to-zod.ts` 로 Zod 스키마 런타임 생성, 오른쪽에 리소스 미리보기 + RBAC 권한 체크 패널, 업데이트 플로우 (`PUT /v1/releases/:id`).

**Architecture:**
- **Backend 신규 3개 엔드포인트**: `POST /v1/templates/:name/render` (미리보기), `PUT /v1/releases/:id` (업데이트), `POST /v1/selfsubjectaccessreview` (k8s SSAR 프록시).
- **Frontend 라우트 추가**: `/catalog/[name]/versions/[v]/deploy` (현재 없음 — 업데이트용).
- **Frontend 재작성**: 현재 `DynamicForm.tsx` 는 plain HTML; 이를 shadcn 기반으로 재구성. Zod 스키마 생성 로직은 `lib/ui-spec-to-zod.ts` 로 분리하고 **단위 테스트 작성**.

**Tech Stack:** 기존 + Plan 0 산출물 (shadcn Input/Select/Switch/Slider/ToggleGroup/Form, use-debounce, TanStack Query). Backend: 기존 `template.Render` 재사용 + k8s SelfSubjectAccessReview proxy.

**스펙 참조:** [2026-04-19-frontend-design-spec.md](../specs/2026-04-19-frontend-design-spec.md) §5 + §6.6 (업데이트 플로우).

**전제:** Plan 0 완료 (shadcn form/slider/switch/toggle-group, use-debounce, TanStack Query).

---

## Part A — Backend: 3개 엔드포인트 추가

### Task 1: `POST /v1/templates/:name/render` — 배포 전 미리보기

**Files:**
- Create: `backend/internal/api/template_render.go`
- Create: `backend/internal/api/template_render_test.go`
- Modify: `backend/internal/api/routes.go`

기존 `template.Render(resourcesYAML, uiSpecYAML, values, labels)` 함수는 있음 (`backend/internal/template/render.go`). 이를 감싸는 HTTP 핸들러만 추가한다. 최신 published 버전 또는 query `?version=N` 으로 특정 버전을 렌더.

- [ ] **Step 1: 실패 테스트 — `backend/internal/api/template_render_test.go`**

```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "testing"

    "kubeport/internal/testutil"
)

func TestPreviewRender_NotFound(t *testing.T) {
    _, srv := testutil.NewAPIServer(t)
    defer srv.Close()
    body, _ := json.Marshal(map[string]any{"values": map[string]any{}})
    req := httptest.NewRequest("POST", "/v1/templates/does-not-exist/render", bytes.NewReader(body))
    rw := httptest.NewRecorder()
    srv.Config.Handler.ServeHTTP(rw, req)
    if rw.Code != 404 {
        t.Fatalf("expected 404, got %d: %s", rw.Code, rw.Body.String())
    }
}

// 추가 테스트: 정상 경로는 testutil.SeedPublishedTemplate 유사 헬퍼로
// seed 후 200 + rendered_yaml 필드 확인.
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && go test ./internal/api -run TestPreviewRender`
Expected: FAIL — 404 로 실패.

- [ ] **Step 3: 핸들러 구현 — `backend/internal/api/template_render.go`**

```go
package api

import (
    "encoding/json"
    "net/http"
    "strconv"

    "github.com/gin-gonic/gin"

    "kubeport/internal/template"
)

type previewRenderReq struct {
    Values map[string]any `json:"values"`
}

// PreviewRender renders a template with supplied values for UI preview.
// It does NOT apply to k8s. Version selection: ?version=N, default =
// current published version of the template.
func (h *Handlers) PreviewRender(c *gin.Context) {
    name := c.Param("name")
    var req previewRenderReq
    if err := c.ShouldBindJSON(&req); err != nil {
        writeError(c, http.StatusBadRequest, "bad_request", err.Error())
        return
    }

    tmpl, err := h.deps.Store.GetTemplateByName(c, name)
    if err != nil {
        writeError(c, http.StatusNotFound, "not_found", err.Error())
        return
    }

    versionNum := tmpl.CurrentVersion
    if v := c.Query("version"); v != "" {
        n, err := strconv.Atoi(v)
        if err != nil {
            writeError(c, http.StatusBadRequest, "bad_request", "invalid version")
            return
        }
        versionNum = int32(n)
    }
    ver, err := h.deps.Store.GetTemplateVersion(c, tmpl.ID, versionNum)
    if err != nil {
        writeError(c, http.StatusNotFound, "not_found", err.Error())
        return
    }

    valuesJSON, _ := json.Marshal(req.Values)
    out, err := template.Render(ver.ResourcesYaml, ver.UiSpecYaml.String, valuesJSON, template.Labels{
        TemplateName:    name,
        TemplateVersion: int(versionNum),
        ReleaseName:     "preview",
    })
    if err != nil {
        writeError(c, http.StatusBadRequest, "render_failed", err.Error())
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "template":        name,
        "version":         versionNum,
        "rendered_yaml":   string(out),
    })
}
```

**주의:** `Store.GetTemplateByName`, `Store.GetTemplateVersion`, `template.Labels` 의 실제 필드는 코드 읽고 맞출 것 — 스펙이 아니라 실제 시그니처 우선.

- [ ] **Step 4: `routes.go` 에 추가**

`v1.POST("/templates/preview", h.PreviewTemplate)` 바로 다음에:
```go
v1.POST("/templates/:name/render", h.PreviewRender)
```

- [ ] **Step 5: 통과 + 전체 리그레션**

Run: `cd backend && go test ./...`
Expected: 모두 통과.

- [ ] **Step 6: 커밋**

```bash
git add backend/internal/api/template_render.go backend/internal/api/template_render_test.go backend/internal/api/routes.go
git commit -m "feat(api): POST /v1/templates/:name/render — preview-only rendering"
```

---

### Task 2: `PUT /v1/releases/:id` — 릴리스 업데이트

**Files:**
- Create: `backend/internal/api/release_update.go`
- Create: `backend/internal/api/release_update_test.go`
- Modify: `backend/internal/api/routes.go`
- Modify: `backend/internal/store/...` (쿼리 추가 필요 시)

기존 `CreateRelease` 로직과 비슷하지만, DB 에서 기존 릴리스를 로드한 뒤 `version` / `values` 만 갱신하고 k8s apply 재실행. template 과 cluster/namespace 는 **불변** (바꾸려면 새 릴리스 생성).

- [ ] **Step 1: 실패 테스트 — `backend/internal/api/release_update_test.go`**

```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "testing"

    "kubeport/internal/testutil"
)

func TestUpdateRelease_NotFound(t *testing.T) {
    _, srv := testutil.NewAPIServer(t)
    defer srv.Close()
    body, _ := json.Marshal(map[string]any{"version": 2, "values": map[string]any{}})
    req := httptest.NewRequest("PUT", "/v1/releases/deadbeef/update-flow", bytes.NewReader(body))
    req.URL.Path = "/v1/releases/deadbeef"  // use PUT on canonical path
    req.Method = "PUT"
    rw := httptest.NewRecorder()
    srv.Config.Handler.ServeHTTP(rw, req)
    if rw.Code != 404 {
        t.Fatalf("expected 404, got %d", rw.Code)
    }
}
```

- [ ] **Step 2: 실패 확인**

Run: `cd backend && go test ./internal/api -run TestUpdateRelease`
Expected: FAIL — route 미등록.

- [ ] **Step 3: 구현 — `backend/internal/api/release_update.go`**

```go
package api

import (
    "encoding/json"
    "net/http"

    "github.com/gin-gonic/gin"

    "kubeport/internal/template"
)

type updateReleaseReq struct {
    Version int            `json:"version"`
    Values  map[string]any `json:"values"`
}

// UpdateRelease re-renders the release with new values (and optionally a new
// template version) and re-applies to the cluster. Template name, cluster, and
// namespace remain immutable — to change any of those, create a new release.
func (h *Handlers) UpdateRelease(c *gin.Context) {
    id := c.Param("id")
    var req updateReleaseReq
    if err := c.ShouldBindJSON(&req); err != nil {
        writeError(c, http.StatusBadRequest, "bad_request", err.Error())
        return
    }
    if req.Version <= 0 {
        writeError(c, http.StatusBadRequest, "bad_request", "version is required")
        return
    }

    rel, err := h.deps.Store.GetReleaseByID(c, id)
    if err != nil {
        writeError(c, http.StatusNotFound, "not_found", err.Error())
        return
    }
    if err := h.authorizeReleaseWrite(c, rel); err != nil {
        writeError(c, http.StatusForbidden, "forbidden", err.Error())
        return
    }

    tmpl, err := h.deps.Store.GetTemplateByName(c, rel.TemplateName)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }
    ver, err := h.deps.Store.GetTemplateVersion(c, tmpl.ID, int32(req.Version))
    if err != nil {
        writeError(c, http.StatusBadRequest, "bad_request", "version not found")
        return
    }

    valuesJSON, _ := json.Marshal(req.Values)
    out, err := template.Render(ver.ResourcesYaml, ver.UiSpecYaml.String, valuesJSON, template.Labels{
        TemplateName:    rel.TemplateName,
        TemplateVersion: req.Version,
        ReleaseName:     rel.Name,
        ReleaseID:       rel.ID,
    })
    if err != nil {
        writeError(c, http.StatusBadRequest, "render_failed", err.Error())
        return
    }

    // Apply to k8s (reuse existing apply path from CreateRelease).
    if err := h.deps.K8sFactory.Apply(c, rel.Cluster, rel.Namespace, out); err != nil {
        writeError(c, http.StatusInternalServerError, "apply_failed", err.Error())
        return
    }

    // Persist the new version + values.
    if err := h.deps.Store.UpdateReleaseValuesAndVersion(c, id, int32(req.Version), valuesJSON, string(out)); err != nil {
        writeError(c, http.StatusInternalServerError, "internal", err.Error())
        return
    }

    c.JSON(http.StatusOK, gin.H{"id": id, "version": req.Version})
}
```

**주의:** `Store.UpdateReleaseValuesAndVersion` 가 현재 없으면 `backend/internal/store/queries/releases.sql` 에 다음 추가 후 regenerate:

```sql
-- name: UpdateReleaseValuesAndVersion :exec
UPDATE releases
SET template_version = $2,
    values_json = $3,
    rendered_yaml = $4,
    updated_at = NOW()
WHERE id = $1;
```

그리고 `h.authorizeReleaseWrite` 가 없으면 `authorizeReleaseRead` 기반으로 작성 (template owner/team membership 확인).

- [ ] **Step 4: 라우트 등록**

`v1.DELETE("/releases/:id", h.DeleteRelease)` 바로 위에:
```go
v1.PUT("/releases/:id", h.UpdateRelease)
```

- [ ] **Step 5: 통과 + 리그레션**

Run: `cd backend && go test ./...`
Expected: 통과. sqlc 재생성이 필요하면 Makefile 대상 실행 (`make sqlc-generate` 또는 `sqlc generate`).

- [ ] **Step 6: 커밋**

```bash
git add backend/internal/api/release_update.go backend/internal/api/release_update_test.go \
  backend/internal/api/routes.go backend/internal/store/
git commit -m "feat(api): PUT /v1/releases/:id — re-render + re-apply on new values/version"
```

---

### Task 3: `POST /v1/selfsubjectaccessreview` — k8s SSAR 프록시

**Files:**
- Create: `backend/internal/api/ssar.go`
- Create: `backend/internal/api/ssar_test.go`
- Modify: `backend/internal/api/routes.go`

사용자 토큰으로 k8s `SelfSubjectAccessReview` 를 호출해 "이 사용자가 이 cluster/namespace 에서 X 리소스를 create 할 수 있는가?" 판정. 배포 폼이 필드 변경 시마다 호출 (debounce).

- [ ] **Step 1: 실패 테스트 — `backend/internal/api/ssar_test.go`**

```go
package api_test

import (
    "bytes"
    "encoding/json"
    "net/http/httptest"
    "testing"

    "kubeport/internal/testutil"
)

func TestSSAR_BadRequest(t *testing.T) {
    _, srv := testutil.NewAPIServer(t)
    defer srv.Close()
    body, _ := json.Marshal(map[string]any{})
    req := httptest.NewRequest("POST", "/v1/selfsubjectaccessreview", bytes.NewReader(body))
    rw := httptest.NewRecorder()
    srv.Config.Handler.ServeHTTP(rw, req)
    if rw.Code != 400 && rw.Code != 401 {
        t.Fatalf("expected 400 or 401, got %d", rw.Code)
    }
}
```

- [ ] **Step 2: 구현 — `backend/internal/api/ssar.go`**

```go
package api

import (
    "net/http"

    "github.com/gin-gonic/gin"

    authv1 "k8s.io/api/authorization/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ssarReq struct {
    Cluster   string `json:"cluster"`
    Namespace string `json:"namespace"`
    Verb      string `json:"verb"`
    Group     string `json:"group"`
    Resource  string `json:"resource"`
    Name      string `json:"name"`
}

// CheckSelfSubjectAccess proxies a SelfSubjectAccessReview to the target
// cluster using the caller's OIDC token. This is used by the deploy form
// to show permission warnings before submit.
func (h *Handlers) CheckSelfSubjectAccess(c *gin.Context) {
    var req ssarReq
    if err := c.ShouldBindJSON(&req); err != nil {
        writeError(c, http.StatusBadRequest, "bad_request", err.Error())
        return
    }
    if req.Cluster == "" || req.Verb == "" || req.Resource == "" {
        writeError(c, http.StatusBadRequest, "bad_request", "cluster, verb, resource are required")
        return
    }

    cs, err := h.deps.K8sFactory.ClientFor(c, req.Cluster)
    if err != nil {
        writeError(c, http.StatusInternalServerError, "k8s", err.Error())
        return
    }

    review := &authv1.SelfSubjectAccessReview{
        Spec: authv1.SelfSubjectAccessReviewSpec{
            ResourceAttributes: &authv1.ResourceAttributes{
                Namespace: req.Namespace,
                Verb:      req.Verb,
                Group:     req.Group,
                Resource:  req.Resource,
                Name:      req.Name,
            },
        },
    }
    out, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(c, review, metav1.CreateOptions{})
    if err != nil {
        writeError(c, http.StatusInternalServerError, "k8s", err.Error())
        return
    }

    c.JSON(http.StatusOK, gin.H{
        "allowed": out.Status.Allowed,
        "reason":  out.Status.Reason,
        "denied":  out.Status.Denied,
    })
}
```

- [ ] **Step 3: 라우트 등록**

```go
v1.POST("/selfsubjectaccessreview", h.CheckSelfSubjectAccess)
```

- [ ] **Step 4: 테스트·리그레션 통과**

Run: `cd backend && go test ./...`

- [ ] **Step 5: 커밋**

```bash
git add backend/internal/api/ssar.go backend/internal/api/ssar_test.go backend/internal/api/routes.go
git commit -m "feat(api): POST /v1/selfsubjectaccessreview — k8s SSAR proxy for UI checks"
```

---

## Part B — Frontend: Zod 스키마 + shadcn DynamicForm

### Task 4: `lib/ui-spec-to-zod.ts` — UISpec → ZodSchema 유틸

**Files:**
- Create: `frontend/lib/ui-spec-to-zod.ts`
- Create: `frontend/lib/ui-spec-to-zod.test.ts`

기존 `DynamicForm.tsx` 안의 `buildZodSchema` 를 추출·확장한다. 스펙 §5.4 의 정확한 타입 규약을 따름.

- [ ] **Step 1: 실패 테스트 — `frontend/lib/ui-spec-to-zod.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { schemaFromUISpec, defaultsFromUISpec, type UISpec } from "./ui-spec-to-zod";

const spec: UISpec = {
  fields: [
    { path: "spec.replicas", type: "integer", label: "Replicas", min: 1, max: 5, default: 1, required: true },
    { path: "spec.image", type: "string", label: "Image", pattern: "^[a-z0-9/:.-]+$", required: true },
    { path: "spec.debug", type: "boolean", label: "Debug", default: false, required: false },
    { path: "spec.strategy", type: "enum", label: "Strategy", values: ["Rolling", "Recreate"], default: "Rolling", required: true },
  ],
};

describe("schemaFromUISpec", () => {
  it("accepts valid input", () => {
    const s = schemaFromUISpec(spec);
    const r = s.safeParse({
      "spec.replicas": 3,
      "spec.image": "nginx:latest",
      "spec.strategy": "Rolling",
    });
    expect(r.success).toBe(true);
  });

  it("rejects out-of-range integer", () => {
    const s = schemaFromUISpec(spec);
    const r = s.safeParse({
      "spec.replicas": 99,
      "spec.image": "nginx",
      "spec.strategy": "Rolling",
    });
    expect(r.success).toBe(false);
  });

  it("rejects pattern mismatch", () => {
    const s = schemaFromUISpec(spec);
    const r = s.safeParse({
      "spec.replicas": 2,
      "spec.image": "INVALID UPPERCASE",
      "spec.strategy": "Rolling",
    });
    expect(r.success).toBe(false);
  });

  it("rejects enum value not in list", () => {
    const s = schemaFromUISpec(spec);
    const r = s.safeParse({
      "spec.replicas": 2,
      "spec.image": "nginx",
      "spec.strategy": "Unknown",
    });
    expect(r.success).toBe(false);
  });

  it("treats optional field as optional", () => {
    const s = schemaFromUISpec(spec);
    const r = s.safeParse({
      "spec.replicas": 2,
      "spec.image": "nginx",
      "spec.strategy": "Rolling",
    });
    expect(r.success).toBe(true); // spec.debug omitted
  });
});

describe("defaultsFromUISpec", () => {
  it("extracts default values keyed by path", () => {
    expect(defaultsFromUISpec(spec)).toEqual({
      "spec.replicas": 1,
      "spec.debug": false,
      "spec.strategy": "Rolling",
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd frontend && pnpm test lib/ui-spec-to-zod.test.ts`
Expected: FAIL.

- [ ] **Step 3: 구현 — `frontend/lib/ui-spec-to-zod.ts`**

```ts
import { z, type ZodTypeAny } from "zod";

export type UISpecField =
  | { path: string; label: string; help?: string; type: "string"; default?: string; required?: boolean; minLength?: number; maxLength?: number; pattern?: string; placeholder?: string }
  | { path: string; label: string; help?: string; type: "integer"; default?: number; required?: boolean; min?: number; max?: number }
  | { path: string; label: string; help?: string; type: "boolean"; default?: boolean; required?: boolean }
  | { path: string; label: string; help?: string; type: "enum"; values: string[]; default?: string; required?: boolean };

export type UISpec = { fields: UISpecField[] };

// ⚠️ 구현자 주의 (RHF ↔ Zod key 일치):
// react-hook-form 은 `name="spec.replicas"` 를 중첩 경로로 해석해
// form values 를 `{ spec: { replicas: … } }` 로 구성한다. 반면 아래
// schemaFromUISpec 은 평면 키 `{ "spec.replicas": … }` 로 스키마를 만든다.
// zodResolver 가 이 둘을 연결하면 중첩 vs 평면 불일치로 유효성 검사가
// 실제로는 동작하지 않는다.
//
// 구현 첫 스텝에서 백엔드 `backend/internal/template/render.go` 가 values
// 를 어떻게 lookup 하는지 확인 후, 아래 둘 중 하나로 통일할 것:
//
//   A. **중첩 (권장)** — `schemaFromUISpec` 도 path 를 쪼개 중첩 `z.object`
//      를 빌드하고, RHF 의 기본 nesting 을 그대로 활용. 백엔드가 values
//      를 JSON 트리로 traverse 한다면 자연스럽다.
//
//   B. **평면** — RHF 필드 이름에서 점을 이스케이프(예: `spec__replicas`)
//      하고 submit 시점에 경로를 복구해 백엔드 전송. Zod 는 지금처럼 평면
//      유지. 백엔드가 `values["spec.replicas"]` flat lookup 이면 택.
//
// 아래 구현은 **평면 샘플**이다. 중첩으로 간다면 shape 빌드 로직을
// `setAtPath(shape, f.path, zs)` 재귀 형태로 바꾸고, defaults 도 동일 규칙.

export function schemaFromUISpec(spec: UISpec) {
  const shape: Record<string, ZodTypeAny> = {};
  for (const f of spec.fields) {
    let zs: ZodTypeAny;
    switch (f.type) {
      case "string": {
        let s = z.string();
        if (f.minLength !== undefined) s = s.min(f.minLength);
        if (f.maxLength !== undefined) s = s.max(f.maxLength);
        if (f.pattern) s = s.regex(new RegExp(f.pattern));
        zs = s;
        break;
      }
      case "integer": {
        let n = z.coerce.number().int();
        if (f.min !== undefined) n = n.min(f.min);
        if (f.max !== undefined) n = n.max(f.max);
        zs = n;
        break;
      }
      case "boolean":
        zs = z.boolean();
        break;
      case "enum":
        zs = z.enum(f.values as [string, ...string[]]);
        break;
    }
    shape[f.path] = f.required ? zs : zs.optional();
  }
  return z.object(shape);
}

export function defaultsFromUISpec(spec: UISpec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (f.default !== undefined) out[f.path] = f.default;
  }
  return out;
}
```

- [ ] **Step 4: 통과 + 빌드**

Run: `cd frontend && pnpm test lib/ui-spec-to-zod.test.ts && pnpm lint && pnpm build`
Expected: `6 passed`.

- [ ] **Step 5: 커밋**

```bash
git add frontend/lib/ui-spec-to-zod.ts frontend/lib/ui-spec-to-zod.test.ts
git commit -m "feat(frontend): extract schemaFromUISpec + defaultsFromUISpec utilities"
```

---

### Task 5: `DynamicForm.tsx` 재작성 — shadcn 위젯 매핑

**Files:**
- Modify: `frontend/components/DynamicForm.tsx`
- Create: `frontend/components/DynamicForm.test.tsx`

스펙 §5.3 의 type → 위젯 매핑을 정확히 구현. 기존 DynamicForm 은 buildZodSchema 를 내장했지만, 이제 `schemaFromUISpec` 을 import.

- [ ] **Step 1: 현재 DynamicForm 을 읽고, export 된 공개 API 파악**

Run: `cat frontend/components/DynamicForm.tsx`
Expected: `<DynamicForm spec={...} initialValues={...} onSubmit={...} />` 시그니처 확인.

- [ ] **Step 2: 테스트 먼저 — `frontend/components/DynamicForm.test.tsx`**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DynamicForm } from "./DynamicForm";
import type { UISpec } from "@/lib/ui-spec-to-zod";

const spec: UISpec = {
  fields: [
    { path: "replicas", type: "integer", label: "Replicas", min: 1, max: 10, default: 1, required: true },
    { path: "image", type: "string", label: "Image", required: true },
    { path: "debug", type: "boolean", label: "Debug", default: false },
    { path: "strategy", type: "enum", label: "Strategy", values: ["A", "B", "C"] }, // ≤4 → ToggleGroup
    { path: "env", type: "enum", label: "Env", values: ["dev", "stage", "prod", "edge", "canary"] }, // 5 → Select
  ],
};

describe("DynamicForm widget mapping", () => {
  it("renders Slider for integer with both min+max", () => {
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    // shadcn Slider exposes role=slider
    expect(screen.getByRole("slider")).toBeInTheDocument();
  });

  it("renders Switch for boolean", () => {
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("renders ToggleGroup for enum with ≤4 values", () => {
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    // ToggleGroup items are buttons with radio role
    expect(screen.getByRole("radio", { name: "A" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "B" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "C" })).toBeInTheDocument();
  });

  it("renders Select for enum with >4 values", () => {
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("shows validation error for invalid input on submit", async () => {
    render(<DynamicForm spec={spec} onSubmit={() => {}} />);
    // leave image empty, click submit
    await userEvent.click(screen.getByRole("button", { name: /배포하기|update/i }));
    // RHF would normally block; just ensure at least one error message
    const errs = await screen.findAllByText(/required|필수/i);
    expect(errs.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: 구현 — `frontend/components/DynamicForm.tsx` 재작성**

```tsx
"use client";

import { useMemo } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from "@/components/ui/form";
import { Button } from "@/components/ui/button";

import { schemaFromUISpec, defaultsFromUISpec, type UISpec, type UISpecField } from "@/lib/ui-spec-to-zod";

type Props = {
  spec: UISpec;
  initialValues?: Record<string, unknown>;
  submitLabel?: string;
  onSubmit: (values: Record<string, unknown>) => void;
  onChange?: (values: Record<string, unknown>) => void;
};

export function DynamicForm({ spec, initialValues, submitLabel = "배포하기", onSubmit, onChange }: Props) {
  const schema = useMemo(() => schemaFromUISpec(spec), [spec]);
  const defaults = useMemo(() => ({ ...defaultsFromUISpec(spec), ...(initialValues ?? {}) }), [spec, initialValues]);

  const form = useForm<Record<string, unknown>>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
    mode: "onChange",
  });

  // Propagate values upward (for preview + RBAC).
  if (onChange) form.watch(() => onChange(form.getValues()));

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        {spec.fields.map((field) => (
          <FieldRow key={field.path} field={field} control={form.control} />
        ))}
        <div className="flex justify-end">
          <Button type="submit">{submitLabel}</Button>
        </div>
      </form>
    </Form>
  );
}

function FieldRow({ field, control }: { field: UISpecField; control: ReturnType<typeof useForm>["control"] }) {
  return (
    <FormField
      control={control}
      name={field.path}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>{field.label}{field.required && <span className="text-red-600"> *</span>}</FormLabel>
          <FormControl>{renderWidget(field, rhf)}</FormControl>
          {field.help && <FormDescription>{field.help}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function renderWidget(
  field: UISpecField,
  rhf: { value: unknown; onChange: (v: unknown) => void; onBlur: () => void; name: string; ref: React.Ref<HTMLElement> },
) {
  if (field.type === "boolean") {
    return <Switch checked={Boolean(rhf.value)} onCheckedChange={rhf.onChange} />;
  }
  if (field.type === "integer") {
    const hasRange = field.min !== undefined && field.max !== undefined;
    if (hasRange) {
      return (
        <div className="flex items-center gap-3">
          <Slider
            min={field.min}
            max={field.max}
            step={1}
            value={[typeof rhf.value === "number" ? rhf.value : field.min!]}
            onValueChange={(v) => rhf.onChange(v[0])}
            className="flex-1"
          />
          <span className="w-10 text-right text-sm tabular-nums">{String(rhf.value ?? field.min)}</span>
        </div>
      );
    }
    return (
      <Input
        type="number"
        min={field.min}
        max={field.max}
        value={rhf.value === undefined || rhf.value === null ? "" : String(rhf.value)}
        onChange={(e) => {
          // 빈 문자열은 undefined 로. Number("") === 0 이라 그대로 변환하면
          // 사용자가 지운 optional 필드에 0 이 주입된다.
          const v = e.target.value;
          rhf.onChange(v === "" ? undefined : Number(v));
        }}
      />
    );
  }
  if (field.type === "enum") {
    if (field.values.length <= 4) {
      return (
        <ToggleGroup type="single" value={String(rhf.value ?? "")} onValueChange={rhf.onChange}>
          {field.values.map((v) => (
            <ToggleGroupItem key={v} value={v}>{v}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      );
    }
    return (
      <Select value={String(rhf.value ?? "")} onValueChange={rhf.onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {field.values.map((v) => (
            <SelectItem key={v} value={v}>{v}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  // string
  return (
    <div className="flex flex-col gap-1">
      <Input
        type="text"
        placeholder={field.placeholder}
        value={String(rhf.value ?? "")}
        onChange={(e) => rhf.onChange(e.target.value)}
      />
      {field.pattern && (
        <span className="text-[11px] text-slate-500">regex: <code>{field.pattern}</code></span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 테스트 통과**

Run: `cd frontend && pnpm test components/DynamicForm.test.tsx`
Expected: `5 passed`.

- [ ] **Step 5: 빌드·린트 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과. 기존 deploy page 가 DynamicForm 을 그대로 import 하고 있으면, props 변경이 있다면 타입 에러로 드러남 — 다음 태스크에서 수정.

- [ ] **Step 6: 커밋**

```bash
git add frontend/components/DynamicForm.tsx frontend/components/DynamicForm.test.tsx
git commit -m "refactor(frontend): rewrite DynamicForm with shadcn widgets + spec-based mapping"
```

---

### Task 6: `ResourcesPreview.tsx` — 렌더된 YAML 미리보기 패널

**Files:**
- Create: `frontend/components/ResourcesPreview.tsx`

Plan 0 의 MonacoPanel 이 있지만 이 패널은 "만들어질 리소스 리스트 (종류 + 이름)" 의 읽기 쉬운 요약을 우선 보여주고, 상세는 탭 전환 시 Monaco. MVP 에선 **리스트만** 으로 간단히 시작 (Monaco 패널은 후속 확장 가능).

- [ ] **Step 1: 구현 — `frontend/components/ResourcesPreview.tsx`**

```tsx
"use client";

import YAML from "yaml";
import { useMemo } from "react";

type Props = { renderedYaml: string | null; pending: boolean };

export function ResourcesPreview({ renderedYaml, pending }: Props) {
  const resources = useMemo(() => {
    if (!renderedYaml) return [];
    try {
      const docs = YAML.parseAllDocuments(renderedYaml);
      return docs
        .map((d) => d.toJS() as { kind?: string; metadata?: { name?: string } })
        .filter((x) => x && x.kind)
        .map((x) => ({ kind: x.kind!, name: x.metadata?.name ?? "(unnamed)" }));
    } catch {
      return [];
    }
  }, [renderedYaml]);

  return (
    <aside className="flex flex-col gap-3 rounded-md bg-slate-50 p-4">
      <h2 className="text-sm font-medium">만들어질 리소스</h2>
      {pending && <p className="text-xs text-slate-500">렌더링 중…</p>}
      {!pending && resources.length === 0 && (
        <p className="text-xs text-slate-500">폼을 채우면 미리보기가 여기 표시됩니다.</p>
      )}
      <ul className="flex flex-col gap-1">
        {resources.map((r, idx) => (
          <li key={idx} className="flex items-center justify-between text-sm">
            <span className="font-mono text-xs text-slate-600">{r.kind}</span>
            <span>{r.name}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
```

- [ ] **Step 2: 빌드 확인**

Run: `cd frontend && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 3: 커밋**

```bash
git add frontend/components/ResourcesPreview.tsx
git commit -m "feat(frontend): ResourcesPreview — summarizes rendered YAML by kind/name"
```

---

### Task 7: `RBACCheckPanel.tsx` — 권한 체크 카드

**Files:**
- Create: `frontend/components/RBACCheckPanel.tsx`

폼 값에서 `cluster + namespace` 를 꺼내고, 현재 렌더된 리소스에서 필요한 (verb, group, resource) 집합을 추출해 backend SSAR 프록시를 여러 번 호출. 모두 allowed 면 success, 하나라도 denied 면 danger.

간단화: 첫 구현에선 **고정된 리소스 세트** (deployments, services, ingresses 등 MVP 스코프) 에 대해 `create` 권한만 체크. 렌더된 YAML 에서 동적으로 뽑는 건 후속.

- [ ] **Step 1: 구현 — `frontend/components/RBACCheckPanel.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

type CheckResult = { allowed: boolean; resource: string; reason: string };

type Props = { cluster: string; namespace: string; kinds: string[] };

const KIND_TO_RESOURCE: Record<string, { group: string; resource: string }> = {
  Deployment: { group: "apps", resource: "deployments" },
  Service: { group: "", resource: "services" },
  Ingress: { group: "networking.k8s.io", resource: "ingresses" },
  ConfigMap: { group: "", resource: "configmaps" },
  Secret: { group: "", resource: "secrets" },
  StatefulSet: { group: "apps", resource: "statefulsets" },
};

export function RBACCheckPanel({ cluster, namespace, kinds }: Props) {
  const [results, setResults] = useState<CheckResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cluster || !namespace || kinds.length === 0) {
      setResults([]);
      return;
    }
    // cluster/namespace/kinds 가 빠르게 바뀔 때 이전 요청 응답이 최신
    // 상태를 덮어쓰지 않도록 active 플래그로 보호.
    let active = true;
    setLoading(true);
    Promise.all(
      kinds.map(async (k) => {
        const map = KIND_TO_RESOURCE[k];
        if (!map) return { allowed: true, resource: k, reason: "unknown kind — skipped" };
        const res = await fetch("/api/v1/selfsubjectaccessreview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cluster, namespace, verb: "create", ...map }),
        });
        if (!res.ok) return { allowed: false, resource: k, reason: `HTTP ${res.status}` };
        const body = (await res.json()) as { allowed: boolean; reason: string };
        return { allowed: body.allowed, resource: k, reason: body.reason ?? "" };
      }),
    )
      .then((r) => {
        if (active) setResults(r);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [cluster, namespace, kinds.join(",")]);

  const allAllowed = results.length > 0 && results.every((r) => r.allowed);
  const anyDenied = results.some((r) => !r.allowed);

  return (
    <Card>
      <CardHeader className="text-sm font-medium">권한 확인</CardHeader>
      <CardContent className="flex flex-col gap-1 text-xs">
        {loading && <span className="text-slate-500">확인 중…</span>}
        {!loading && allAllowed && <span className="text-green-700">모든 리소스 생성 권한 확인됨.</span>}
        {!loading && anyDenied && (
          <ul className="flex flex-col gap-0.5">
            {results.filter((r) => !r.allowed).map((r) => (
              <li key={r.resource} className="text-red-700">
                ❌ {r.resource}: {r.reason || "denied"}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
```

사용 측 `allowed` 여부로 배포 버튼 disable. 아래 Task 8.

- [ ] **Step 2: 빌드 확인**

Run: `cd frontend && pnpm lint && pnpm build`

- [ ] **Step 3: 커밋**

```bash
git add frontend/components/RBACCheckPanel.tsx
git commit -m "feat(frontend): RBACCheckPanel — SSAR checks for required k8s kinds"
```

---

### Task 8: `/catalog/[name]/deploy/page.tsx` 재작성 — 2-col 레이아웃 + preview + RBAC

**Files:**
- Modify: `frontend/app/catalog/[name]/deploy/page.tsx`
- Create: `frontend/app/catalog/[name]/deploy/DeployClient.tsx` (client component)

스펙 §5.2 레이아웃. server component 는 데이터 fetch 만, 상호작용은 client 에서.

- [ ] **Step 1: `DeployClient.tsx` 작성 (client, polling preview + RBAC)**

```tsx
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import YAML from "yaml";
import { useDebouncedCallback } from "use-debounce";

import { DynamicForm } from "@/components/DynamicForm";
import { ResourcesPreview } from "@/components/ResourcesPreview";
import { RBACCheckPanel } from "@/components/RBACCheckPanel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { UISpec } from "@/lib/ui-spec-to-zod";

type Props = {
  templateName: string;
  version: number;
  team: string | null;
  spec: UISpec;
  updateReleaseId?: string;
  initialValues?: Record<string, unknown>;
};

export function DeployClient({ templateName, version, team, spec, updateReleaseId, initialValues }: Props) {
  const router = useRouter();
  const [meta, setMeta] = useState({ name: "", cluster: "", namespace: "" });
  const [rendered, setRendered] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const preview = useDebouncedCallback(async (values: Record<string, unknown>) => {
    setPending(true);
    try {
      const res = await fetch(`/api/v1/templates/${templateName}/render?version=${version}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values }),
      });
      if (!res.ok) {
        setRendered(null);
        return;
      }
      const body = (await res.json()) as { rendered_yaml: string };
      setRendered(body.rendered_yaml);
    } finally {
      setPending(false);
    }
  }, 300);

  const kinds = useMemo(() => {
    if (!rendered) return [];
    try {
      return YAML.parseAllDocuments(rendered)
        .map((d) => (d.toJS() as { kind?: string })?.kind)
        .filter((k): k is string => !!k);
    } catch {
      return [];
    }
  }, [rendered]);

  async function submit(values: Record<string, unknown>) {
    setSubmitting(true);
    setErr(null);
    try {
      if (updateReleaseId) {
        const r = await fetch(`/api/v1/releases/${updateReleaseId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ version, values }),
        });
        if (!r.ok) throw new Error(await r.text());
        router.push(`/releases/${updateReleaseId}`);
      } else {
        const r = await fetch("/api/v1/releases", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            template: templateName,
            version,
            name: meta.name,
            cluster: meta.cluster,
            namespace: meta.namespace,
            values,
          }),
        });
        if (!r.ok) throw new Error(await r.text());
        const body = (await r.json()) as { id: string };
        router.push(`/releases/${body.id}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_0.85fr]">
      <div>
        <header className="mb-4">
          <h1 className="text-lg font-semibold">
            {updateReleaseId ? `v${version} 로 업데이트` : "새 배포"}
          </h1>
          <p className="text-xs text-slate-600">{templateName} · v{version}{team ? ` · ${team} 팀` : ""}</p>
        </header>
        {!updateReleaseId && (
          <div className="mb-4 grid grid-cols-2 gap-3">
            <Input placeholder="릴리스 이름" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} />
            <Input placeholder="클러스터" value={meta.cluster} onChange={(e) => setMeta({ ...meta, cluster: e.target.value })} />
            <Input placeholder="네임스페이스" className="col-span-2" value={meta.namespace} onChange={(e) => setMeta({ ...meta, namespace: e.target.value })} />
          </div>
        )}
        <DynamicForm
          spec={spec}
          initialValues={initialValues}
          submitLabel={updateReleaseId ? `v${version} 로 업데이트` : "배포하기"}
          onChange={preview}
          onSubmit={submit}
        />
        {err && <p className="mt-2 text-sm text-red-700">{err}</p>}
        {submitting && <p className="mt-2 text-sm text-slate-600">처리 중…</p>}
      </div>
      <aside className="flex flex-col gap-3">
        <ResourcesPreview renderedYaml={rendered} pending={pending} />
        {meta.cluster && meta.namespace && (
          <RBACCheckPanel cluster={meta.cluster} namespace={meta.namespace} kinds={kinds} />
        )}
      </aside>
    </div>
  );
}
```

- [ ] **Step 2: `page.tsx` 재작성 (server component)**

```tsx
import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import YAML from "yaml";
import { DeployClient } from "./DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

export default async function DeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ updateReleaseId?: string }>;
}) {
  const { name } = await params;
  const { updateReleaseId } = await searchParams;

  const tmplRes = await apiFetch(`/v1/templates/${name}`);
  if (!tmplRes.ok) notFound();
  const tmpl = (await tmplRes.json()) as {
    current_version: number;
    owning_team_name: string | null;
    current_ui_spec: string | null;
  };

  const spec = tmpl.current_ui_spec
    ? ((YAML.parse(tmpl.current_ui_spec) as UISpec) ?? { fields: [] })
    : { fields: [] };

  return (
    <DeployClient
      templateName={name}
      version={tmpl.current_version}
      team={tmpl.owning_team_name}
      spec={spec}
      updateReleaseId={updateReleaseId}
    />
  );
}
```

- [ ] **Step 3: 빌드·린트·테스트 통과**

Run: `cd frontend && pnpm test && pnpm lint && pnpm build`
Expected: 통과.

- [ ] **Step 4: 커밋**

```bash
git add frontend/app/catalog/[name]/deploy/page.tsx frontend/app/catalog/[name]/deploy/DeployClient.tsx
git commit -m "feat(frontend): redesign deploy page — 2-col + preview + RBAC + update flow"
```

---

### Task 9: `/catalog/[name]/versions/[v]/deploy` — 버전 고정 배포 라우트

**Files:**
- Create: `frontend/app/catalog/[name]/versions/[v]/deploy/page.tsx`

특정 버전 pin. 업데이트 플로우에서 쓰임 (`UpdateAvailableBadge` 가 이 URL 로 link).

- [ ] **Step 1: 구현**

```tsx
import { apiFetch } from "@/lib/api-server";
import { notFound } from "next/navigation";
import YAML from "yaml";
import { DeployClient } from "../../../deploy/DeployClient";
import type { UISpec } from "@/lib/ui-spec-to-zod";

export default async function VersionPinnedDeployPage({
  params,
  searchParams,
}: {
  params: Promise<{ name: string; v: string }>;
  searchParams: Promise<{ updateReleaseId?: string }>;
}) {
  const { name, v } = await params;
  const { updateReleaseId } = await searchParams;
  const version = Number(v);

  const verRes = await apiFetch(`/v1/templates/${name}/versions/${version}`);
  if (!verRes.ok) notFound();
  const ver = (await verRes.json()) as { ui_spec_yaml: string; owning_team_name?: string | null };

  const spec = (YAML.parse(ver.ui_spec_yaml) as UISpec) ?? { fields: [] };

  let initialValues: Record<string, unknown> | undefined;
  if (updateReleaseId) {
    const relRes = await apiFetch(`/v1/releases/${updateReleaseId}`);
    if (relRes.ok) {
      const rel = (await relRes.json()) as { values_json?: Record<string, unknown> };
      initialValues = rel.values_json;
    }
  }

  return (
    <DeployClient
      templateName={name}
      version={version}
      team={ver.owning_team_name ?? null}
      spec={spec}
      updateReleaseId={updateReleaseId}
      initialValues={initialValues}
    />
  );
}
```

- [ ] **Step 2: 빌드·린트 통과**

Run: `cd frontend && pnpm lint && pnpm build`

- [ ] **Step 3: 커밋**

```bash
git add frontend/app/catalog/[name]/versions/[v]/deploy/page.tsx
git commit -m "feat(frontend): version-pinned deploy route for update flow"
```

---

### Task 10: BFF Route Handler — render / SSAR / PUT release 프록시

**Files:**
- Create: `frontend/app/api/v1/templates/[name]/render/route.ts`
- Create: `frontend/app/api/v1/selfsubjectaccessreview/route.ts`
- Modify: `frontend/app/api/v1/releases/[id]/route.ts` (PUT 추가) — 없으면 새로 작성

기존 BFF 프록시 헬퍼가 있다면 그것 재사용. 없으면 `apiFetch` 래핑.

- [ ] **Step 1: `render/route.ts`**

```ts
import { apiFetch } from "@/lib/api-server";
import type { NextRequest } from "next/server";

export async function POST(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const body = await req.text();
  const res = await apiFetch(`/v1/templates/${name}/render${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
```

- [ ] **Step 2: `selfsubjectaccessreview/route.ts`** (같은 패턴, POST forward)

- [ ] **Step 3: releases PUT forward — 기존 route.ts 확장 또는 신규**

기존 `app/api/v1/releases/[id]/route.ts` 가 있으면 `PUT` 메서드 추가; 없으면 신규:

```ts
import { apiFetch } from "@/lib/api-server";
import type { NextRequest } from "next/server";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.text();
  const res = await apiFetch(`/v1/releases/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new Response(await res.text(), { status: res.status });
}
```

기존 DELETE 가 있으면 같은 파일에 추가.

- [ ] **Step 4: 빌드 통과 + 스모크 (dev 서버)**

Run: `cd frontend && pnpm build`
Expected: 통과.

브라우저: `/catalog/<template>/deploy` 에서 폼 입력 → 300ms 후 우측 미리보기 갱신 → cluster/namespace 입력 시 RBAC 카드 갱신 → 배포 성공 시 `/releases/<id>` 리다이렉트.

- [ ] **Step 5: 커밋**

```bash
git add frontend/app/api/v1/
git commit -m "feat(frontend): BFF proxies for render / SSAR / releases PUT"
```

---

## 검증 (End-to-end)

1. **백엔드**: `cd backend && go test ./... && go build ./...`
2. **프론트**: `cd frontend && pnpm test && pnpm lint && pnpm build`
3. **스모크** (local k3d + dev):
   - `/catalog/<t>/deploy` → 폼 변경 → 300ms 후 우측 리소스 미리보기 (kind/name 리스트) 갱신
   - cluster/namespace 입력 → "권한 확인" 카드에 ✓ 또는 ❌ 표시
   - 유효하지 않은 값 → FormMessage 로 필드 에러 노출
   - 정상 제출 → 새 릴리스 생성, `/releases/<id>` 리다이렉트
   - `/releases/<id>` 에서 UpdateAvailableBadge 클릭 → `/catalog/<t>/versions/<newV>/deploy?updateReleaseId=…` 이동, 기존 값이 폼에 채워짐
   - 업데이트 제출 → PUT 호출, 같은 릴리스로 리다이렉트, 새 버전으로 동작

4. **리그레션**: `/catalog` 카탈로그 페이지 (Plan 1), `/releases/<id>` 상세 (Plan 2) 모두 동작.

---

## 스코프 밖 (후속)

- RBAC 체크: 렌더된 YAML 에서 실제 리소스 목록을 파싱해 동적으로 체크 (현재는 고정 매핑). v1.1.
- `pattern` 필드의 "regex ✓" 성공 피드백 UI (스펙 §5.6) — Zod message 활용 개선, 후속.
- Update 플로우의 "새 필드만 ui-spec defaults 로 채움" 자동화 (스펙 §6.6 마지막 줄) — 현재는 whole `values_json` replace.
