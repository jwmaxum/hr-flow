# hr-flow

management works — 인사·근태·결재를 관리하는 HR Flow(Easy Works ERP) 개발 및 배포 가이드입니다.

이 문서는 프로젝트의 빌드 환경 및 핵심 개발 정책을 명시하여 개발 시 항상 반영되도록 합니다.

## 현재 개발 단계 및 배포 원칙

- **개발 단계**: 1차 개발이 완료되었으며, 현재는 추가 개발 단계입니다.
- **저장소 / 웹 배포**: [jwmaxum/hr-flow](https://github.com/jwmaxum/hr-flow)의 `main`을 Cloudflare Pages 프로젝트 `hr-flow`에 연동합니다. 새 공개 주소는 [hr-flow-chj.pages.dev](https://hr-flow-chj.pages.dev/)이며 기존 `hr-flow.pages.dev` 서비스는 유지합니다. [배포 운영 가이드](docs/cloudflare-deployment.md)에서 환경변수와 확인 절차를 안내합니다.
- **백엔드 서비스**: Firebase Authentication, Firestore, Storage, Cloud Functions를 사용합니다.
- **배포 구분**: `npm run deploy`는 Firebase Hosting을 포함하는 레거시 명령이며 Cloudflare 배포에 사용하지 않습니다. GitHub Actions는 검증 전용이고 실제 웹 배포는 Cloudflare의 Git 연동이 담당합니다.
- **GitHub 인증**: 로컬 `.env.local`에 GitHub 접근 토큰이 저장되어 있습니다. 향후 `git push`에 필요할 때만 안전하게 사용하며, 토큰 값은 출력하거나 Git에 포함하지 않습니다. Git은 `.env.local`을 자동으로 읽지 않습니다.

후속 개발 작업의 지속 지침은 [AGENTS.md](AGENTS.md)를 참고하세요.

`서류 발급`에서는 회사 공통 로고·주소·대표자·인감으로 공문·재직증명서·경력증명서를 작성합니다. `001-261105` 형식의 번호 자동 발행, ADMIN 본인 작성 서류의 제출 즉시 발급, ADMIN이 지정한 같은 본부 SUB_ADMIN의 최종 승인, 결재 알림·재배정·수정 이력과 비공개 PDF 보관을 지원합니다. 결재 관리함과 대시보드의 본인 발급내역에서 상태·PDF를 확인할 수 있습니다. [서류 기능 운영 가이드](docs/official-letters.md)를 참고하세요. 웹과 별도로 서류 Firebase 함수·보안규칙·인덱스를 배포하며, 기존 지출결의의 1단계 승인은 유지합니다.

회사 템플릿의 이미지 선택과 서버 저장 상태를 구분하고, 저장 후 DB 재조회로 등록을 확인합니다. 인감은 가로·세로 5~50mm를 각각 지정하며 PDF 인쇄는 A4 실제 크기(100%)로 합니다. 조직관리에서 새 직원을 만들면 서버가 요청된 초기 임시비밀번호를 지정하고 최초 로그인 비밀번호 변경을 요구합니다. 신규 영구비밀번호와 관리자 초기화 비밀번호의 기존 12자 이상 정책은 유지합니다.

급여관리의 소득세는 [2026년 3월 1일 시행 근로소득 간이세액표](https://www.law.go.kr/LSW/flDownload.do?bylClsCd=110201&flSeq=161861245&gubun=)를 사용합니다. 관리자 등록 세액표를 읽지 못하면 저장소에 포함된 공식 기본표를 적용합니다. `childrenUnder20` 저장 필드는 기존 데이터 호환을 위해 유지하지만, 화면에서는 **공제대상인 8~20세 자녀 수**로 입력해야 합니다. 기존 값에 8세 미만 자녀가 포함되어 있다면 관리자가 확인해야 합니다. 계산 검증은 `npm --prefix client run test:payroll`로 실행합니다.

## 1. 빌드 및 배포 환경
- **Node.js**: Cloudflare와 GitHub Actions 모두 `24`를 사용합니다.
- **PackageManager**: `npm`
- **Frontend Framework**: `React v19` + `Vite`
- **CI/CD**: Cloudflare는 root `client`, 명령 `npm run lint && npm run test:unit && npm run build`, 출력 `dist`로 배포합니다. `Verify HR Flow` Actions는 린트·단위/관리자 보안 회귀·타입·빌드를 검증하며 배포 자격 증명을 사용하지 않습니다.

### 로그인·첨부파일 자동 점검

Node.js `24`·Java `21` 환경에서 실제 로그인과 PNG/PDF 업로드·다운로드, 회사·본부 격리를 데스크톱·모바일 브라우저로 검증합니다. 운영 계정이나 자격 증명은 사용하지 않습니다. 준비 과정과 점검 범위는 [브라우저 E2E 가이드](docs/e2e-testing.md)를 참고하세요.

```sh
npm ci
npm --prefix client ci
npm --prefix functions ci
npx playwright install chromium
npm run test:e2e:safety
npm run test:e2e
```

## 2. 데이터베이스 및 보안 (SaaS 아키텍처)
- **Firebase Database**: Firestore (**ID: `(default)`** 사용)
- **데이터베이스 정책**: 기존 운영 `VITE_FIREBASE_DATABASE_ID`를 유지합니다. 값을 생략하면 코드가 `(default)`를 사용하므로 새 배포에 다른 DB를 잘못 연결하지 않도록 확인합니다.
- **멀티테넌트 정책**: 모든 데이터 문서는 `companyId` 필드를 포함해야 하며, 모든 Firestore 쿼리는 반드시 이 필드를 통한 필터링을 포함해야 합니다.
- **Null Safety**: `useAuthStore`의 `userData` 접근 시 반드시 옵셔널 체이닝(`?.`) 또는 조기 반환(early return)을 사용하여 런타임 에러를 방지합니다.

## 3. 주요 환경 변수 (.env)
- `VITE_FIREBASE_DATABASE_ID=(default)`
- `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN` 등 클라이언트 설정 10개를 Cloudflare Production·Preview와 GitHub Actions secrets에 등록합니다. 루트 및 client의 `.env.example`은 값이 없는 예제입니다.
- `VITE_*`는 공개 브라우저 설정입니다. GitHub·Cloudflare·R2·Firebase 관리 토큰은 이 접두사로 전달하지 않습니다. 전체 키의 보관 위치와 별칭은 [환경변수 안내](docs/cloudflare-deployment.md#환경변수-보관-위치)를 따릅니다.

## 4. 본 시스템은 단일 코드 베이스로 여러 기업을 서비스하는 
- **Multi-tenant SaaS**: 회사 자료는 `companyId` 기준의 논리적 격리와 서버 권한 검증으로 보호합니다. 쿼리 필터만으로 권한 검증을 대신하지 않습니다.
- ** Frontend: React + TypeScript + Tailwind CSS + Zustand (상태 관리)
- ** Backend/DB: Firebase Auth (인증) + Firestore
- **Serverless Logic: Firebase Cloud Functions (비밀번호 강제 초기화 등 관리자 기능)

## 5. 권한별 접근 메뉴 (RBAC Matrix)

| 구분 | 메뉴명 | SYSTEM_ADMIN | SUPER_ADMIN / ADMIN (회사) | SUB_ADMIN | MEMBER |
| :--- | :--- | :---: | :---: | :---: | :---: |
| 플랫폼 | 플랫폼 관리 (기업 관리) | ✅ | ❌ | ❌ | ❌ |
| 공통 | 대시보드 | ❌ | ✅ | ✅ | ✅ |
| 공통 | 내 휴가 및 근태 | ❌ | ✅ | ✅ | ✅ |
| 공통 | 지출결의 신청 | ❌ | ✅ | ✅ | ✅ |
| 공통 | 서류 발급 (공문·재직·경력) | ❌ | ✅ | ✅ | ✅ |
| 공통 | 공지사항 게시판 | ❌ | ✅ | ✅ | ✅ |
| 관리자 | 결재/승인 관리함 | ❌ | ✅ | ✅ | ❌ |
| 관리자 | 조직관리 | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 급여 및 연봉 관리 | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 지출결의 통합 조회 | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 인사관리 (직원 등록/수정) | ❌ | ✅ | ❌ | ❌ |
| 관리자 | 시스템 설정 (도메인 등) | ❌ | ✅ | ❌ | ❌ |

> [!NOTE]
> - **SYSTEM_ADMIN**: 플랫폼 운영자 표시명입니다. 기존 저장 역할 코드는 `SUPER_ADMIN`으로 유지하며 플랫폼 관리 대시보드(`/super-admin`)를 사용합니다. 회사 최초 가입자는 `SUPER_ADMIN`, 추가 회사 관리자는 `ADMIN`으로 표시하고 기존 저장 역할 코드 `ADMIN`을 유지합니다. 표시명만으로 권한을 부여하지 않습니다.
> - **SUB_ADMIN**: 본인 소속 본부/팀의 결재 승인만 가능하며 인사/재무 데이터 접근은 차단됩니다. 서류 최종 승인은 ADMIN이 별도로 권한을 부여한 같은 본부의 활성 SUB_ADMIN만 가능하고, 순차 결재를 완료한 타인의 서류에 한합니다. 회사 템플릿·인감·번호 설정 권한은 부여되지 않습니다.

---
*이 가이드는 시스템의 무결성과 안정적인 배포를 위해 반드시 준수되어야 합니다.*
