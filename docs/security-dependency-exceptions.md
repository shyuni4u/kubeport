# 보안 의존성 예외 (2026-11-24 재검토)

`frontend/package.json`의 `pnpm.auditConfig.ignoreGhsas`는 아래에 문서화된 권고에만 적용되는 임시 예외다. 감사 임계값은 유지하며 다른 권고는 계속 게이트를 막는다.

## DOMPurify 예외 해제 (2026-11-24)

이슈 #478에서 Monaco 0.57.0이 DOMPurify 3.4.15를 포함해 두 예외를 두었다. 2026-11-24 npm 레지스트리를 다시 확인한 결과 최신 Monaco 0.58.0은 DOMPurify 3.4.17을 포함한다. 배포 tarball의 무결성 값을 npm 메타데이터와 대조하고, `esm/vs/base/browser/dompurify/dompurify.js`의 버전 및 실제 자체 호스팅하는 `min/vs/editor-CG9c2pE-.js`의 `version="3.4.17"`도 확인했다.

이에 Monaco 핀과 `frontend/lib/monaco-cdn.ts`를 0.58.0으로 함께 올리고 `GHSA-cg2g-xh64-v4q7`·`GHSA-mrv2-3pqr-j5jr` 예외를 제거한다. 현재 두 권고는 모두 low이며 수정 버전은 3.4.17이다. 예외 해제는 심각도 하향이 아니라 실제 배포 코드의 패치를 근거로 한다. npm overrides는 사용하지 않는다.

근거: [Monaco 0.58.0 배포 메타데이터](https://registry.npmjs.org/monaco-editor/0.58.0), [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7), [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr).

## picomatch 감사 예외 (2026-11-18, 사용자 승인)

대상은 `GHSA-fc5q-39xc-vjpf` 하나다. 2026-11-18 확인 시 npm 최신 picomatch는 4.0.7이고 권고에는 수정 버전이 없다. `next-intl > @parcel/watcher > picomatch` 경로가 production 감사 high 게이트를 막는다.

현재 next-intl 설정은 `createNextIntlPlugin("./i18n/request.ts")`이며 `experimental.extract`를 사용하지 않는다. watcher는 추출 컴파일러에 속하고 추출 설정이 없으면 초기화되지 않는다. 현재 production 빌드의 NFT trace와 `.next/standalone`에 npm picomatch와 @parcel/watcher가 포함되지 않는 것을 확인했다. 추출 기능이 사용하는 ignore 패턴도 고정된 node_modules/.next/.git 경로다.

이는 모든 picomatch 구현이 없거나 취약점이 해결됐다는 뜻이 아니다. Next가 자체 포함한 `next/dist/compiled/picomatch`는 존재한다. 현재 앱은 사용자 지정 glob을 받지 않고 `images.unoptimized=true`이며 remotePatterns도 설정하지 않는다. Next 보안 업데이트도 별도로 적용한다.

사용자가 2026-11-18 명시적으로 승인한 범위에 따라 기존 감사 임계값을 유지하면서 위 GHSA만 일시적으로 제외한다. 수정 버전이 출시되면 잠금 파일을 갱신하고 즉시 예외를 제거한다. 매 의존성 업데이트에서 재검토하며, 추출 기능·사용자 입력 glob·이미지 최적화를 도입하기 전에도 재평가한다. `pnpm build`의 `scripts/verify-runtime-dependencies.mjs`가 실제 빌드 trace에 npm picomatch/Parcel watcher가 없고 이미지 최적화와 원격 패턴이 비활성 상태인지 검사한다. 2026-11-24 재조회에서도 npm 최신 picomatch는 4.0.7이며 이 권고의 수정 버전은 없다. 이 예외 한 건은 유지하고 다음 주간 점검(2026-12-01)에 수정 버전과 유지 필요성을 재검토한다. next-intl 4.15.3의 picomatch 업데이트 안내는 다른 권고에 대한 것으로, 이 권고의 해제를 뜻하지 않는다.

근거: https://github.com/advisories/GHSA-fc5q-39xc-vjpf
