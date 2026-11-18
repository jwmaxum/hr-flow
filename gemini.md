# HR FLOW 개발 및 배포 가이드 (gemini.md)

이 문서는 프로젝트의 빌드 환경 및 핵심 개발 정책을 명시하여 개발 시 항상 반영되도록 합니다.

## 0. [필수] 4단계 코드 구현 표준 워크플로
모든 코드 작성 및 수정 시 **`search-first → 구현 → security-review → verification-loop`** 파이프라인을 준수합니다:
1. **search-first**: 코드 작성 전 기존 컴포넌트, Zustand 스토어, Firebase 모델, 타입 선언을 먼저 검색·분석합니다 (추측 코딩 금지).
2. **구현 (Implementation)**: 외과적 정밀 구현, Null Safety(`userData?.`), 데이터 격리(`companyId`) 및 로컬 보호 방어벽을 준수합니다.
3. **security-review**: 멀티테넌트 `companyId` 누락 방지, Firestore Security Rules 검토, RBAC 권한 체크, 시크릿 노출 차단.
4. **verification-loop**: TypeScript 타입 검사(`npx tsc --noEmit`) 및 빌드 테스트 실행, 결함 발견 시 수정-보안-재검증 루프 완료.

## 현재 작업 기준
- 1차 개발 완료. 이후 작업은 추가 개발 단계입니다.
- 웹 배포 대상은 Cloudflare Pages 프로젝트 `hr-flow` (`https://hr-flow.pages.dev/`)입니다. GitHub `main` 푸시가 자동 배포를 시작합니다. Firebase Authentication, Firestore, Storage, Cloud Functions는 백엔드 서비스로 사용합니다.
- `npm run deploy`는 Firebase Hosting을 포함하는 레거시 명령입니다. Cloudflare 배포 명령으로 사용하지 않습니다.
- GitHub 접근 토큰은 로컬 `.env.local`에 있습니다. 향후 `git push`에 필요할 때만 안전하게 사용하고, 값을 출력하거나 커밋하지 않습니다. Git은 이 파일을 자동으로 읽지 않습니다.

## 1. 빌드 및 배포 환경
- **Node.js**: `v24` 이상 권장 (Node.js 24 런타임 네이티브 지원 및 GitHub Actions 최신 규격 준수)
- **PackageManager**: `npm`
- **Frontend Framework**: `React v19` + `Vite`
- **CI/CD**: Cloudflare Pages의 GitHub `main` 연동으로 자동 배포합니다. 기존 Firebase Hosting 및 GitHub Pages 배포 워크플로는 수동 실행 전용입니다.

## 2. 데이터베이스 및 보안 (SaaS 아키텍처)
- **Firebase Database**: Firestore (**ID: `(default)`** 사용)
- **데이터베이스 정책**: 모든 코드에서 Firestore 초기화 시 기본 데이터베이스인 `(default)`를 사용합니다.
- **멀티테넌트 정책**: 모든 데이터 문서는 `companyId` 필드를 포함해야 하며, 모든 Firestore 쿼리는 반드시 이 필드를 통한 필터링을 포함해야 합니다.
- **Null Safety**: `useAuthStore`의 `userData` 접근 시 반드시 옵셔널 체이닝(`?.`) 또는 조기 반환(early return)을 사용하여 런타임 에러를 방지합니다.

## 3. 주요 환경 변수 (.env)
- `VITE_FIREBASE_DATABASE_ID=(default)`
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN` 등 (GitHub Secrets에 등록됨)

## 4. 본 시스템은 단일 코드 베이스로 여러 기업을 서비스하는 
- **Multi-tenant SaaS 모델을 채택하고 있습니다. 모든 데이터는 companyId를 기준으로 물리적/논리적으로 격리되어 보안을 보장합니다.
- ** Frontend: React + TypeScript + Tailwind CSS + Zustand (상태 관리)
- ** Backend/DB: Firebase Auth (인증) + Firestore
- **Serverless Logic: Firebase Cloud Functions (비밀번호 강제 초기화 등 관리자 기능)

## 5. 권한별 접근 메뉴 (RBAC Matrix)

| 구분 | 메뉴명 | SUPER_ADMIN | ADMIN (Owner) | SUB_ADMIN | MEMBER |
| :--- | :--- | :---: | :---: | :---: | :---: |
| 플랫폼 | 플랫폼 관리 (기업 관리) | ✅ | ❌ | ❌ | ❌ |
| 공통 | 대시보드 | ❌ | ✅ | ✅ | ✅ |
| 공통 | **휴가신청** | ❌ | ✅ | ✅ | ✅ |
| 공통 | 지출결의 신청 | ❌ | ✅ | ✅ | ✅ |
| 공통 | **공지 게시판** | ❌ | ✅ | ✅ | ✅ |
| 관리자 | 결재/승인 관리함 | ❌ | ✅ | ✅ | ❌ |
| 관리자 | 조직관리 | ❌ | ✅ | ❌ | ❌ |
| 관리자 | **급여관리** | ❌ | ✅ | ❌ | ❌ |
| 관리자 | **지출결의 조회** | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 인사관리 (직원 등록/수정) | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 시스템 설정 (도메인 등) | ❌ | ✅ | ❌ | ❌ |
| 관리자 | **결제/구독 관리** | ❌ | ✅ | ❌ | ❌ |

> [!NOTE]
> - **SUPER_ADMIN**: 플랫폼 전체 관리. 특정 회사 데이터 전체 삭제, 사용제한 관리. 특정 회사에 소속되지 않으며 플랫폼 관리 대시보드(`/super-admin`)만 접근합니다.
> - **SUB_ADMIN**: 팀 단위 관리자. 본인 소속 본부/팀의 결재 승인만 가능하며 인사/재무 데이터 접근은 차단됩니다.

---
## 6. 보안 및 권한 관리 정책
- **ADMIN 권한 자가 보호 및 Owner 보호**: SaaS 서비스에 회원가입하여 최초 등재된 최고 관리자(Owner)의 `role`은 본인 포함 그 누구도 강등시킬 수 없습니다. 또한 ADMIN은 자신의 역할(`role`)이나 소속(`companyId`)을 스스로 수정할 수 없습니다. (운영 실수 및 악의적 권한 탈취 방지)
- **SUB_ADMIN 제한**: `SUB_ADMIN`은 소속 본부/팀의 데이터만 관리하며, 인사/급여 등 민감 정보가 포함된 상위 데이터 및 타 조직 데이터에 접근할 수 없습니다.
- **연차 관리 정책**: 
    - 입사일 기준 근로기준법에 의거한 연차가 자동 산정됩니다.
    - **추가 연차 부여**: ADMIN은 인사관리 상세 팝업을 통해 직원별로 '추가 연차'를 직접 부여하거나 차감할 수 있으며, 이는 사용자의 총 연차에 즉시 합산 반영됩니다.

---
## 7. 구독 및 결제 정책 (SaaS Subscription)
- **3개월 무료 체험**: 모든 기업은 가입 후 3개월(90일) 동안 모든 기능을 무료로 사용할 수 있습니다.
- **자동 차단 정책**: 가입일 기준 3개월이 경과했음에도 유효한 구독 정보가 없는 경우, 해당 기업의 모든 사용자 접근이 차단됩니다. (단, ADMIN의 결제 페이지 접근은 허용)
- **구독 플랜**: 월간 구독(Monthly) 및 연간 구독(Yearly)으로 운영됩니다.
- **결제 서비스**: PayPal Hosted Buttons를 통해 결제가 이루어지며, 결제 성공 시 `companies` 컬렉션의 구독 정보가 즉시 업데이트됩니다.
- **SUPER_ADMIN 권한**: 모든 기업의 결제 내역을 조회하고, 필요 시 수동으로 구독 기간을 연장하거나 플랜을 수정할 수 있습니다.

---
*이 가이드는 시스템의 무결성과 안정적인 배포를 위해 반드시 준수되어야 합니다.*
