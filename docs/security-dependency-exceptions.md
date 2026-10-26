# 보안 의존성 예외 (2026-10-26)

이슈 #478: Next.js는 16.4.3, Zod는 4.6.7로 갱신한다. Monaco 0.57.0은 DOMPurify 3.4.15를 배포 파일에 포함하며, 확인 시점의 최신 Monaco에도 패치가 없다.

`frontend/package.json`의 `pnpm.auditConfig.ignoreGhsas`는 다음 두 권고에만 적용되는 임시 예외다.

- GHSA-cg2g-xh64-v4q7 (critical)
- GHSA-mrv2-3pqr-j5jr (high)

이는 취약점 해결을 뜻하지 않는다. 관리자 편집기에서 취약한 sanitizer가 계속 실행될 수 있다. #442의 자체 호스팅은 런타임 CDN 코드 공급 경로를 제거하지만 이 취약점을 고치지는 않는다. 감사 임계값은 유지하며, 다른 권고는 계속 게이트를 막는다.

DOMPurify 3.4.17 이상을 실제 배포 파일에 포함하는 Monaco가 나오면 npm 핀과 `frontend/lib/monaco-cdn.ts` 버전을 함께 갱신하고 두 예외를 제거한다. npm overrides만으로 감사 결과를 숨기지 않는다. 다음 의존성 업데이트 시 예외를 재검토한다.
