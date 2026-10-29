# Cloudflare 배포 운영

2026-10-29 기준 기본 저장소는 [jwmaxum/hr-flow](https://github.com/jwmaxum/hr-flow), 새 웹 주소는 [hr-flow-chj.pages.dev](https://hr-flow-chj.pages.dev/)다. 새 Cloudflare 계정의 Pages 프로젝트 이름은 `hr-flow`다. 기존 [hr-flow.pages.dev](https://hr-flow.pages.dev/)는 다른 계정의 기존 서비스이며 그대로 유지한다. 새 배포를 검증할 때 두 주소를 혼동하지 않는다.

## 빌드와 검증

| 항목 | 값 |
| --- | --- |
| Git 저장소 / 운영 브랜치 | `jwmaxum/hr-flow` / `main` |
| 프로젝트 / 루트 | `hr-flow` / `client` |
| Cloudflare 빌드 명령 | `npm run lint && npm run test:unit && npm run build` |
| 출력 / Node.js | `dist` / `24` |
| 정적 파일의 저장소 내 위치 | `client/dist` |

Cloudflare의 Git 연동이 `main`의 운영 배포를 담당한다. `.github/workflows/deploy.yml`의 `Verify HR Flow`는 main 푸시·main 대상 PR·수동 실행에서 린트(경고 0), 클라이언트 단위 검사, 관리자·결제·화면 로딩 회귀, TypeScript와 프로덕션 빌드만 실행한다. Actions 권한은 `contents: read`이며 GitHub Pages·Firebase Hosting·Cloudflare 배포 작업을 하지 않는다. 외부 fork PR에는 저장소 secrets가 제공되지 않으므로 해당 PR 빌드는 배포 환경값이 없는 구조 검증이다. `pull_request_target`으로 바꾸어 secrets를 제공하지 않는다.

처음 연결할 때는 자동 배포를 끈 상태에서 운영·미리보기 환경변수와 빌드 설정을 저장한다. 코드 푸시 후 설정과 대상 커밋을 확인하고 운영 자동 배포를 켠다. 같은 커밋의 배포가 이미 진행 중이면 중복 배포를 만들지 않는다. 미리보기 자동 배포는 필요한 브랜치만 허용한다.

## 환경변수 보관 위치

로컬 템플릿은 루트 `.env.example`과 `client/.env.example`이며 실제 값은 `.env.local`, `client/.env` 또는 `client/.env.local`에만 보관한다. 예제 파일에는 값이 없고 실제 환경 파일은 Git에서 제외한다. 값·토큰·키를 로그, 커밋, 이 문서에 기록하지 않는다.

로컬 자격 증명에 같은 키가 여러 번 있으면 마지막 값만 읽어 인증하지 않는다. 인증 사용자와 대상 `jwmaxum/hr-flow`의 쓰기 권한을 확인해 적절한 토큰을 선택하며, 확인 없이 실제 자격 증명 파일을 고치지 않는다.

다음 10개 클라이언트 설정은 Cloudflare Pages의 **Production·Preview Variables and Secrets**와 새 GitHub 저장소의 **Actions secrets**에 같은 이름으로 등록한다. Cloudflare는 Git 빌드에서 자체 설정을 사용하고 GitHub Actions 빌드는 저장소 secrets를 사용하므로 두 위치를 함께 관리한다.

| 키 | 용도 |
| --- | --- |
| `VITE_FIREBASE_API_KEY` | Firebase 웹 클라이언트 API 설정 |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase Auth 도메인 |
| `VITE_FIREBASE_PROJECT_ID` | 기존 Firebase 프로젝트 |
| `VITE_FIREBASE_STORAGE_BUCKET` | 기존 Firebase Storage 버킷 설정 |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | Firebase 웹 설정 |
| `VITE_FIREBASE_APP_ID` | Firebase 웹 앱 식별자 |
| `VITE_FIREBASE_MEASUREMENT_ID` | 기존 분석 설정 보존; 현재 Firebase 초기화에서는 사용하지 않음 |
| `VITE_FIREBASE_DATABASE_ID` | 기존 Firestore DB ID를 그대로 유지 |
| `VITE_API_URL` | 기존 API 설정 보존; 현재 클라이언트 코드에서는 사용하지 않음 |
| `VITE_PAYPAL_CLIENT_ID` | 기존 결제 설정 보존; 현재 고정 Hosted PayPal 링크에서는 사용하지 않음 |

`VITE_*` 값은 빌드 시 브라우저 코드에 포함될 수 있다. Cloudflare나 GitHub에서 암호화해 저장하더라도 비공개 서버 자격 증명으로 사용할 수 없다. 회사 자료는 Firebase 서버의 인증·권한·회사 격리 검증으로 보호하며 클라이언트 API 설정의 비공개성에 의존하지 않는다.

관리 자격 증명은 다음 별칭으로 새 GitHub 저장소의 암호화된 Actions secrets에 보관한다. 현재 검증 워크플로는 이 값들을 환경에 주입하지 않는다. 기존 R2 데이터나 Firebase 리소스는 이 등록만으로 이전·배포되지 않는다.

| 로컬 키 | Actions secret | 사용 범위 |
| --- | --- | --- |
| `Account_ID` | `CLOUDFLARE_ACCOUNT_ID` | 대상 Cloudflare 계정 식별 |
| `API_Key` | `CLOUDFLARE_API_TOKEN` | 기존 Cloudflare API 토큰; 권한 변경·신규 발급 없음 |
| `Access_key_id` | `R2_ACCESS_KEY_ID` | 기존 R2 자격 증명 보관 |
| `Secret_access_key` | `R2_SECRET_ACCESS_KEY` | 기존 R2 자격 증명 보관 |
| `S3_API_endpoint` | `R2_S3_API_ENDPOINT` | 기존 R2 엔드포인트 보관 |
| `client/.env`의 `FIREBASE_TOKEN` | `FIREBASE_TOKEN` | 별도 Firebase 배포 자격 증명 보관 |
| `GITHUB_ACCESS_TOKEN` | 등록하지 않음 | 로컬 Git 인증 전용; Actions는 기본 읽기 전용 `GITHUB_TOKEN` 사용 |

Secrets 갱신 시 키 이름·성공 여부만 기록한다. Cloudflare 비밀값은 등록 후 다시 읽을 수 없으므로 등록 성공과 필요한 변수 이름·유형을 확인한다. 실제 사용하지 않는 관리자 키를 `VITE_*`, 정적 JSON 또는 번들에 넣지 않는다.

## 새 주소와 기존 백엔드 연결

Firebase Authentication·Firestore·Storage·Cloud Functions는 기존 백엔드를 사용한다. 새 호스트를 Firebase Auth의 허용 도메인으로 확인하고, 첨부 HTTP API의 CORS에는 `https://hr-flow-chj.pages.dev`라는 정확한 출처를 허용한다. 기존 `https://hr-flow.pages.dev` 출처도 유지한다. `*.pages.dev` 전체를 허용하거나 인증·회사 검사 조건을 줄이지 않는다.

새 호스트의 Auth 도메인 추가와 두 첨부 함수의 운영 배포는 별도 승인 대상이다. 이번 전환에서는 해당 운영 변경이 승인 대기 중이며, 승인·반영·검증이 끝나기 전까지 새 호스트의 로그인·첨부 연결 완료로 보고하지 않는다. 웹 소스 연결이나 환경변수 등록만으로 백엔드 반영이 완료되지는 않는다.

CORS 변경이 필요하면 `uploadCompanyAttachment`, `downloadCompanyAttachment` 두 HTTP 함수만 대상과 검증을 확인해 별도로 배포한다. 공문 발급 PDF의 callable API와 기존 다른 함수·Hosting을 함께 재배포할 이유는 없다. 새 웹 주소 등록은 R2 이전이나 Firestore 회사 데이터 이전을 뜻하지 않는다.

## 배포 확인과 실패 대응

1. `jwmaxum/hr-flow`의 main 커밋과 `Verify HR Flow` 및 Cloudflare 체크를 확인한다.
2. Cloudflare 배포 상세에서 저장소·브랜치·실제 커밋과 성공 상태를 대조한다.
3. 새 공개 주소의 HTML, 참조된 전체 JS·CSS 청크, SUIT 폰트·라이선스를 빌드와 대조한다. CSP·HSTS와 HTML `no-cache`, 해시 정적 파일 `immutable` 정책을 확인한다.
4. 새 출처의 첨부 API OPTIONS와 비로그인 차단, 필요한 경우 승인된 테스트 계정으로 로그인·기능·조직 간 격리를 검증한다. 운영 회사 자료를 테스트로 생성·변경하지 않는다.

`Cloning repository`에서 `HTTP/2 ... CANCEL`, `early EOF`, `invalid index-pack output`이 발생하면 앱 빌드 전 Git 전송 실패다. 동일 커밋을 한 번 재시도하고 단계별 로그를 확인한다. 반복될 때는 Cloudflare의 GitHub 접근·네트워크·저장소 상태를 조사하며 Git 이력 삭제나 강제 푸시를 기본 대응으로 사용하지 않는다.

`npm run deploy`는 Firebase Hosting을 포함한 레거시 루트 명령이다. Cloudflare 웹 배포에는 사용하지 않는다. 백엔드 변경은 함수·규칙·인덱스를 필요한 범위로 지정하고 별도 검증한다.

다음 개발 단계는 새 배포의 실제 사용자 로딩 성능과 배포 실패 알림을 측정·점검하는 것이다.

공식 참고: [Git 연동](https://developers.cloudflare.com/pages/configuration/git-integration/), [Pages 환경변수·Secrets](https://developers.cloudflare.com/pages/functions/bindings/), [Vite 환경변수](https://vite.dev/guide/env-and-mode), [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
