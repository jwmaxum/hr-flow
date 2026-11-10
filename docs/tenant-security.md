# 회사 격리와 계정 접근 통제

2026-10-24 보안 수정. 회사 ADMIN과 SUB_ADMIN은 다른 회사 자료에 접근할 수 없다. 플랫폼 운영용 SUPER_ADMIN은 별도 PLATFORM 소속으로 유지한다.

## 서버가 관리하는 정보

- 회사 등록은 이메일 인증 후 `accountSecurity.createCompany`에서 처리한다. 회사 ID는 서버 UUID이며 브라우저가 선택하거나 재사용할 수 없다. `tenantRegistry`와 도메인 예약은 영구 보관한다.
- 회사·직원 상태, 초기 비밀번호 변경 완료 여부, 세션 유효 시각과 구독 접근기간은 서버만 변경한다. 업무 요청과 보안규칙은 현재 DB의 회사·역할·상태를 조회하며 요청 본문의 회사 ID를 권한으로 사용하지 않는다.
- 기존 요청에 따라 신규 직원의 공통 초기 비밀번호는 유지한다. 변경 전에는 최소 본인 세션 정보와 비밀번호 변경 화면만 허용한다. 6~15자 새 비밀번호를 서버에서 설정한 후 기존 세션을 폐기하고 재로그인한다. 같은 초에 발급된 이전 토큰도 다음 초부터 유효한 세션 기준으로 차단한다.
- 회원가입, 최초·수동 변경, 관리자 초기화에서 새 비밀번호는 문자 조합 제한 없이 6~15자를 허용한다. 기존 비밀번호로 로그인하거나 재인증할 때는 이 제한을 적용하지 않는다. 비밀번호는 Firebase Authentication에서 관리하고 Firestore 프로필에는 평문이나 해시를 저장하지 않는다.
- 회사의 `accessUntil`은 Firestore Timestamp다. 체험 90일과 플랫폼 관리자가 연장한 기간을 서버가 관리한다. 만료된 회사 ADMIN은 구독 안내와 결제 확인 요청만 이용할 수 있다. 브라우저 결제 콜백은 구독을 활성화하지 않는다.
- 구독 구매는 동일 월간·연간 플랜의 [PayPal 공식 결제 페이지](https://www.paypal.com/ncp/payment/36DMV6NKPEZYW)를 새 탭으로 연다. 결제 후 ADMIN이 거래/주문번호를 제출하며 플랫폼 관리자가 실제 거래를 대조한다. 실패 시 입력을 유지하고 같은 거래 요청을 재시도할 수 있다. 결제 SDK를 회사 인사 데이터가 있는 페이지에서 실행하지 않아 강제 CSP와의 충돌도 제거했다. 실제 유료 결제는 자동 테스트에서 실행하지 않는다.
- 직원 정지·복직·삭제는 서버에서 Auth와 프로필을 함께 처리한다. 회사 삭제는 먼저 DELETING으로 잠그고 Auth·Storage·하위 문서까지 정리한다. 실패하면 잠금을 유지하며 재시도할 수 있다. 삭제한 회사 ID와 도메인 예약은 남긴다.

## 자료 권한

- 근태·급여·신청·공지의 회사와 작성자 식별자는 변경할 수 없다. 신청의 팀·본부는 작성 당시 인증된 프로필과 일치해야 하며, 조직 간 참조는 같은 회사인지 검사한다.
- SUB_ADMIN은 본부 범위의 근태·신청을 조회하고 결재한다. 직원 목록은 서버의 최소 directory로 제공하며 연봉·주소·주민번호 등 인사 프로필 전체를 반환하지 않는다.
- 공문·증명서·인감·프린터 점검은 기존 서버 승인·개정본 검사를 유지하면서 같은 활성 계정·비밀번호·구독 검사를 적용한다.
- 지출·휴가·공지 첨부는 인증된 업로드 API를 사용한다. 최대 10MiB, PNG/JPEG/GIF/WebP/PDF의 MIME과 파일 서명을 검사하고 변경 불가능한 비공개 경로에 저장한다. 회사 로고·인감의 기존 3MiB 제한은 유지한다.
- 다운로드는 경로 대신 신청 문서 ID를 받는다. 현재 회사·작성자·결재 본부를 확인하고 파일을 읽은 뒤 다시 검사한다. 공개·서명 URL은 발급하지 않으며 브라우저의 Blob 미리보기도 계정·회사 전환 시 폐기한다.
- 원본 Storage에 대한 브라우저 직접 접근은 차단한다. 기존 Firebase 다운로드 토큰은 마이그레이션에서 회수하고 파일 내용은 보존한다.

## 운영 전환

웹은 main 푸시로 Cloudflare Pages에 배포하고 Firebase Hosting은 사용하지 않는다. Firebase Functions·규칙·인덱스는 별도로 배포한다.

1. 운영 인덱스와 로컬 정의를 대조해 기존 인덱스를 보존한다. 본부별 근태·휴가 조회 인덱스를 추가한다.
2. `scripts/migrate-tenant-security.cjs`를 Admin SDK로 읽기 전용 실행해 계획을 확인한다. `apply:true, scope:'backfill'`은 서버 접근기간과 회사 ID 예약만 설정한다. 체험 시작일은 서버 문서 생성시각보다 미래로 설정할 수 없다.
3. 계정·관리·공문·첨부 Functions와 웹을 배포한 뒤 새 클라이언트 동작을 확인한다. Firestore·Storage 규칙을 반영한다.
4. `apply:true, scope:'all'`로 기존 첨부 URL을 회사 경로로 변환하고 토큰을 회수한다. 이전 링크의 익명 접근이 거부되는지 확인한다. 문서와 파일은 삭제하지 않는다. 회사가 없는 잔존 자료의 ID도 영구 예약한다.
5. 배포된 함수 상태·규칙 내용·인덱스 READY·공개 웹 번들과 Cloudflare 체크를 확인한다. 기존 브라우저는 새로고침 후 재로그인한다.

마이그레이션은 토큰·파일명·개인정보를 출력하지 않으며 집계 건수만 반환한다. 과거 신청의 조직 정보와 현재 프로필의 불일치는 보고만 하고 자동 수정하지 않는다. 전직으로 인한 정상 이력을 보존하기 위해서다. 직원 기록에만 남아 있고 프로필이 삭제된 Auth 계정은 정지·세션 폐기한다. 가입 복구 중인 기존 회사 소유자는 이 처리에서 제외한다.

메인 페이지에는 CSP와 HSTS를 강제한다. 공개 정적 배포 구조는 유지하며, 별도 Pages Worker나 결제 iframe은 추가하지 않는다. PayPal HostedButtons의 동적 폼 스크립트가 nonce를 전파하지 않고 opaque sandbox에서도 실행되지 않는 점을 실제 브라우저에서 확인했으므로 공식 호스팅 결제 방식을 사용한다.

## 검증

루프백 에뮬레이터 이외의 주소에서는 API 테스트가 실행되지 않는다. Auth와 Storage는 메모리 대역이며 운영 계정·문서는 테스트로 생성하지 않는다.

```powershell
$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8080'
$env:FIREBASE_STORAGE_EMULATOR_HOST='127.0.0.1:9199'
$env:NO_PROXY='localhost,127.0.0.1,::1'
npm run test:rules
npm run test:security-api
npm run test:official-letters
npm run test:members
npm run test:auth-state
node --test scripts/tests/admin-ui-security.test.cjs scripts/tests/payment-security.test.cjs
npm --prefix client run test:payroll
npm --prefix client run build
npm --prefix server run build
```

테스트는 정상 회사별 동작을 허용하는 대조군과 함께 회사 ID 변조·역할/상태 변경·퇴사·정지·만료·초기 암호 우회·급여 노출·첨부 공개 링크·부분 삭제 실패·동시 도메인 예약을 확인한다. 에뮬레이터는 운영 인덱스 필요 여부를 재현하지 않으므로 인덱스는 운영 정의와 별도 대조한다.

## 남은 운영 강화 단계

공통 초기 비밀번호는 사용자의 유지 결정에 따른 예외다. 최초 변경 전 데이터 접근은 차단되지만, 누구나 아는 비밀번호로 최초 로그인을 먼저 시도하는 위험은 남는다. 계정별 초대 링크나 임시 비밀번호로 전환할 수 있도록 후속 정책을 마련한다.

다음 서비스 개발 단계는 관리자 MFA, 로그인 이상 탐지와 보안 알림, 접근 거부·계정 상태 변경의 감사 이력 및 운영 회귀 테스트 자동화다. 전체 기존 린트 부채는 보안 변경과 구분해 정리한다.

참고: [Firebase 세션 폐기](https://firebase.google.com/docs/auth/admin/manage-sessions), [Cloud Storage 메타데이터 변경](https://cloud.google.com/storage/docs/viewing-editing-metadata).
