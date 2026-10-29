# 공통 UI와 초기 로딩 개선

2026-10-28 적용. 기존 색상·SUIT·반응형 레이아웃을 유지하면서 공통 UI와 전송 단위를 정리한다.

## 공통 컴포넌트

`client/src/components/ui/index.tsx`는 Button, Input, Select, Textarea, Panel, StatusBadge, PageTitle, PageHeading을 제공한다. 11개 업무 화면과 3개 공통 영역의 159개 요소에 적용했다. 기존 `wf-*` 클래스·이벤트·입력값·검증 조건·ARIA·ref를 그대로 전달한다. Panel의 `as`는 기존 section/article 등의 의미를 보존하며 별도 DOM 래퍼를 만들지 않는다.

버튼의 `type`을 생략하면 브라우저의 기본 submit 동작을 유지한다. 저장 외의 버튼은 사용처에서 `type="button"`을 명시한다. 스타일만 공통화하며 API 호출·권한 판단·폼 상태를 UI 컴포넌트 안에 넣지 않는다. 기존 CSS와 클래스가 이미 있는 요소는 클래스 순서도 유지한다.

```tsx
import { Button, Input, Panel } from '../components/ui';

<Panel as="section" className="wf-panel company-editor">
  <Input aria-label="제목" value={title} onChange={handleTitle} required />
  <Button type="submit" className="wf-btn wf-btn-primary">저장</Button>
</Panel>
```

## 화면과 도구의 지연 로딩

인증 저장소·권한 판단·공개 랜딩/로그인·프로필 초기 설정은 즉시 로드한다. WorkspaceShell과 업무·관리 화면은 모듈 범위의 React.lazy로 분리하고, 권한이 필요한 화면의 Suspense는 기존 ProtectedRoute 안에 둔다. 거부된 업무 화면의 코드는 요청·평가·마운트하지 않는다. 지출결의 ZIP 도구와 플랫폼 세액표 Excel 도구는 해당 작업을 실행할 때만 가져온다. 사용되지 않는 Firebase Storage 클라이언트 초기화만 제거했으며 비공개 첨부의 인증 API와 서버 Storage는 유지한다.

`RouteContent`는 로딩 상태를 알리고 다운로드·렌더 실패를 화면 안에서 처리한다. 자동 새로고침은 하지 않는다. 사용자가 연결을 확인하고 `화면 다시 불러오기`를 눌러 새 배포의 HTML과 청크를 다시 받는다. React.lazy의 실패한 import는 캐시되므로 같은 화면의 단순 재렌더를 재시도로 표시하지 않는다. 다른 경로로 이동하면 오류 경계가 복구된다. 내부 화면의 Suspense만 pathname에 따라 새로 구성하여 느린 이동 중 이전 편집기에서 새 입력이 생기지 않도록 한다. 바깥 셸은 경로 이동에도 유지하고, 쿼리 문자열만 바뀌면 편집기도 유지한다. 기존 UID·회사·역할·본부 키는 유지한다.

문서 편집의 native 뒤로/앞으로 이동 보호는 작은 `documentNavigationGuards` 모듈이 라우터보다 먼저 capture 리스너를 등록한다. 지연 로딩된 기안/회사 템플릿은 마운트 시 현재 가드를 등록하고 해제 시 제거한다. 미저장 취소·저장 후 링크 이동·알림 쿼리 갱신의 기존 흐름을 유지한다. ZIP 도구의 비동기 로딩이 끝난 뒤에도 현재 계정 범위를 다시 확인하여 이전 계정의 영수증을 읽지 않는다.

## 캐시와 배포

Cloudflare Pages의 `/`와 `/index.html`은 `no-cache`로 재검증한다. 해시가 붙은 `/assets/*`와 버전이 고정된 SUIT 폰트만 1년 immutable 캐시를 사용한다. 기존 CSP·HSTS 등 보안 헤더는 유지한다. 이 정책은 공개 정적 파일에만 적용하며 회사 서류·PDF·첨부 API에는 적용하지 않는다. 서비스 워커나 업무 데이터 브라우저 캐시는 추가하지 않았다.

GitHub main 푸시 후 Cloudflare Pages 체크와 공개 HTML·모든 JS/CSS 청크·폰트의 바이트, 캐시와 CSP를 검증한다. 이번 변경은 웹 애플리케이션에 한정되어 Firebase 함수·보안규칙·인덱스는 별도로 배포하지 않는다.

## 측정과 검증

같은 Node gzipSync 기본 압축(level 6), 같은 빌드 설정으로 첫 페이지의 전체 정적 의존성 그래프를 합산했다. 이후 JS에는 작은 Rolldown 런타임도 포함한다.

| 최초 요청 대상 | 이전 바이트 | 이후 바이트 | 감소 |
| --- | ---: | ---: | ---: |
| JS 원본 | 1,528,334 | 897,351 | 41.3% |
| JS gzip | 436,082 | 267,313 | 38.7% |
| CSS 원본 | 248,763 | 88,604 | 64.4% |
| CSS gzip | 35,678 | 14,134 | 60.4% |
| JS+CSS gzip | 471,760 | 281,447 | 40.3% |

이는 당시 버전의 전송 대상 크기 비교이며 실제 사용자 로딩 시간 개선율은 아니다. 당시 익명 랜딩/비로그인 보호 경로는 초기 JS·런타임·초기 CSS만 요청하고 업무 화면·Excel·ZIP·SUIT 폰트는 요청하지 않는지 브라우저에서 검증했다. 2026-10-29 랜딩 디자인 통일 이후에는 공개 랜딩도 SUIT와 공통 테마 CSS를 사용한다([후속 디자인 변경](public-platform-design.md)). 로그인한 대시보드의 당시 셸·화면 포함 정적 JS 의존성은 967,287바이트(gzip 292,289바이트)이며, 사용자 데이터·폰트·HTML은 이 수치에 포함하지 않는다.

빌드·TypeScript·린트(오류/경고 0), 공통 컴포넌트와 native 이벤트/ref/폼 submit, 이동 가드 교체·해제·HMR, 관리자 재인증·결제 회귀를 검증한다. 기존 서버/규칙 930건도 로컬 에뮬레이터에서 다시 통과했다. 공통 UI의 단위 줄 커버리지는 95.35%이며 전체 저장소 커버리지로 해석하지 않는다. 브라우저에서는 실제 App과 화면을 사용하고 서버·결제 응답만 로컬 대역으로 대체하여 13화면×1440/1024/390/320px, 역할별 import 거부, 지연/실패/오프라인, 수동 복구, 미저장 이동, 계정 범위 전환을 확인한다. 운영 자료 변경과 실제 결제·메일 발송·암호 변경은 수행하지 않는다.

인증·세션 조회에 필요한 Firebase 코어가 초기 번들의 대부분이어서 500kB 초과 경고는 남아 있다. 경고 기준을 높여 숨기지 않는다. 다음 단계는 실제 사용 환경의 초기 표시·경로 전환 성능을 측정하고, 그 근거에 따라 인증/세션 SDK 초기화와 큰 데이터 목록의 렌더링을 개선하는 것이다.

최종 검증 결과는 다음과 같다. 빌드의 기존 Firebase 코어 크기 경고 외에 아래 실패는 없다.

| 검증 | 결과 |
| --- | --- |
| 프로덕션 빌드 / tsc -b | PASS |
| ESLint | PASS · 오류 0, 경고 0 |
| 서버·규칙 / 클라이언트 단위 / 관리자·결제·로딩 회귀 | PASS · 930 + 30 + 33 = 993건 |
| 실제 App 지연 로딩 / 기존 관리 기능 브라우저 대역 | PASS · 17 + 22 = 39그룹 |
| UI 컴포넌트 줄 / 분기·함수 커버리지 | 95.35% / 100% |
| 운영 자격 증명 비밀값 검사 / 변경 검토 | PASS · 비밀값 출력 없이 검사 |

재실행 가능한 추가 회귀는 `client/tests/ui-primitives.test.mjs`, `client/tests/document-navigation-guards.test.mjs`, `scripts/tests/loading-navigation-security.test.cjs`에 보관한다. 실제 브라우저 결과의 숫자는 로컬 대역 검증이며 운영 서버 응답시간 측정을 대신하지 않는다.
