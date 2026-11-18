# 보안 의존성 예외 (2026-10-26)

이슈 #478: Next.js는 16.4.3, Zod는 4.6.7로 갱신한다. Monaco 0.57.0은 DOMPurify 3.4.15를 배포 파일에 포함하며, 확인 시점의 최신 Monaco에도 패치가 없다.

`frontend/package.json`의 `pnpm.auditConfig.ignoreGhsas`는 아래에 문서화된 권고에만 적용되는 임시 예외다.

- GHSA-cg2g-xh64-v4q7 (critical)
- GHSA-mrv2-3pqr-j5jr (high)

이는 취약점 해결을 뜻하지 않는다. 관리자 편집기에서 취약한 sanitizer가 계속 실행될 수 있다. #442의 자체 호스팅은 런타임 CDN 코드 공급 경로를 제거하지만 이 취약점을 고치지는 않는다. 감사 임계값은 유지하며, 다른 권고는 계속 게이트를 막는다.

DOMPurify 3.4.17 이상을 실제 배포 파일에 포함하는 Monaco가 나오면 npm 핀과 `frontend/lib/monaco-cdn.ts` 버전을 함께 갱신하고 두 예외를 제거한다. npm overrides만으로 감사 결과를 숨기지 않는다. 다음 의존성 업데이트 시 예외를 재검토한다.

## picomatch 감사 예외 (2026-11-18, 사용자 승인)

대상은 `GHSA-fc5q-39xc-vjpf` 하나다. 2026-11-18 확인 시 npm 최신 picomatch는 4.0.7이고 권고에는 수정 버전이 없다. `next-intl > @parcel/watcher > picomatch` 경로가 production 감사 high 게이트를 막는다.

현재 next-intl 설정은 `createNextIntlPlugin("./i18n/request.ts")`이며 `experimental.extract`를 사용하지 않는다. watcher는 추출 컴파일러에 속하고 추출 설정이 없으면 초기화되지 않는다. 현재 production 빌드의 NFT trace와 `.next/standalone`에 npm picomatch와 @parcel/watcher가 포함되지 않는 것을 확인했다. 추출 기능이 사용하는 ignore 패턴도 고정된 node_modules/.next/.git 경로다.

이는 모든 picomatch 구현이 없거나 취약점이 해결됐다는 뜻이 아니다. Next가 자체 포함한 `next/dist/compiled/picomatch`는 존재한다. 현재 앱은 사용자 지정 glob을 받지 않고 `images.unoptimized=true`이며 remotePatterns도 설정하지 않는다. Next 보안 업데이트도 별도로 적용한다.

사용자가 2026-11-18 명시적으로 승인한 범위에 따라 기존 감사 임계값을 유지하면서 위 GHSA만 일시적으로 제외한다. 수정 버전이 출시되면 잠금 파일을 갱신하고 즉시 예외를 제거한다. 매 의존성 업데이트에서 재검토하며, 추출 기능·사용자 입력 glob·이미지 최적화를 도입하기 전에도 재평가한다. `pnpm build`의 `scripts/verify-runtime-dependencies.mjs`가 실제 빌드 trace에 npm picomatch/Parcel watcher가 없고 이미지 최적화와 원격 패턴이 비활성 상태인지 검사한다. 다음 주간 점검(2026-11-24)에 수정 버전과 예외 유지 필요성을 재검토한다.

근거: https://github.com/advisories/GHSA-fc5q-39xc-vjpf
