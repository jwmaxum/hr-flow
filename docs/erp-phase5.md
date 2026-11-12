# ERP 5단계: 운영 배포와 첫 회사 시범 운영

2026-11-12. 0~4단계의 회사별 기준정보, Excel 이관·입출고, 취소·반품·조정, 기간별 총괄·원장, 세 종류 거래서류 PDF를 함께 서비스에 반영한다. 참고 파일의 품목·수량·가격은 Mockup이며 운영 회사에 자동으로 넣지 않는다.

## 배포 대상과 순서

- 저장소: `jwmaxum/hr-flow`, 운영 브랜치: `main`.
- 웹: 이 저장소와 연결된 Cloudflare Pages `hr-flow`, 공개 주소 `https://hr-flow-chj.pages.dev/`.
- Firebase: `weberp-8f25f`, Firestore `(default)`, 함수 리전 `us-central1`.
- 먼저 Firestore 규칙·인덱스와 `manageErp`, `manageErpImport`, `manageErpCorrection`, `manageErpReport`, `manageErpDocuments`, `adminDeleteCompanyData`를 적용한다. 마지막 함수는 회사 삭제 시 ERP 하위 자료도 정리하도록 변경됐다.
- ERP 원장의 복합 인덱스 4개가 모두 `READY`이고 함수가 `ACTIVE`인지 확인한 뒤 웹을 반영한다. Firebase Hosting과 기존 다른 계정의 웹은 배포 대상이 아니다.
- `main` 푸시는 GitHub `Verify HR Flow` 검사와 Cloudflare Git 연동 배포를 시작한다. 같은 SHA의 Actions·Cloudflare 결과, 공개 HTML과 JS/CSS·폰트 파일, 보안·캐시 헤더를 확인한다.

## 첫 회사의 입력과 확인

1. 회사 관리자가 로그인해 **ERP**에서 회사명이 맞는지 확인한다. 회원·부관리자에게 관리·금액·인감 발행 권한을 주지 않는다.
2. 품목·단가·창고·거래처를 회사의 실제 자료로 등록한다. 기초재고 기준일을 확정하고 표준 Excel의 필수값·음수·중복 오류를 수정한다.
3. 업로드 **미리보기**의 품목별 수량·금액을 원본 장부와 대사한다. 확인 전에는 확정하지 않는다. 같은 파일을 다시 확정해도 재고가 중복 증가하지 않는지 점검한다.
4. 소량의 실제 거래로 기간별 총괄·품목 원장·Excel의 기초/입고/출고/기말 수량과 금액을 비교한다. 반품·취소·실사 조정은 실제 업무 사유가 있을 때만 처리한다.
5. 등록 인감을 확인하고 공급자 출력 설정의 영문 회사명·주소·대표자와 사업자 정보를 입력한다. Proforma 초안과 확정 출고에 연결된 Invoice·거래명세표를 검토한다.
6. 원본 크기/100%로 A4 인쇄해 등록된 mm와 실물 인감 크기, 한글·영문·장문 품목, 두 보관용 거래명세표를 담당자가 확인한다.
7. 재다운로드 원본, 취소 원본·정정본 번호 연결, 발행 전후 재고 불변을 확인한 뒤 적용 회사를 확대한다.

시범 회사의 실제 재고나 출고가 아직 없으면 2~4번과 출고 기반 문서 발행을 완료한 것으로 표시하지 않는다. 합성 자료로 수행한 자동 검사와 실제 장부 대사는 구분한다. 고객 자료·인감 원본·로그인 정보·운영 DB 덤프는 Git 저장소에 올리지 않는다.

## 백업과 복구 범위

현재 설정 화면의 JSON 다운로드는 HR 컬렉션과 회사 기본 정보다. ERP 회사 하위 컬렉션과 Storage의 인감·PDF·첨부 파일은 포함하지 않으므로 버튼과 설명을 **HR 데이터 백업** 범위로 명확히 표시했다.

ERP 복구 준비에는 다음 자료를 함께 보호해야 한다.

- 회사 하위 `erpItems`, `erpWarehouses`, `erpPartners`, `erpKeys`, `erpInventory`, `erpAudit`, `erpImports`, `erpMovements`, `erpDocuments`, `erpState`, `erpImportReceipts`, `erpCorrections`, `erpMovementLinks`, `erpIssuedDocuments`, `erpIssueCounters`, `erpIssueAllocations`, `erpPrintSettings`.
- 회사의 `officialLetterSettings`와 회사별 Storage의 원본 이미지·업로드·`erp-issue-assets`·`erp-issued-pdfs`.
- PDF 파일뿐 아니라 객체 세대·크기·해시와 발행 스냅샷·번호 카운터·발행 수량 연결. 일부 파일만 덮어쓰면 원본 무결성 검사를 통과하지 못할 수 있다.

DB 백업/PITR, Storage 삭제 보존·버전 정책은 별도 운영 설정이다. 설정 유무를 읽기 전용으로 확인하고, 보호 기간·비용을 결정한 다음 관리형 백업을 구성한다. 복원 검증은 운영 회사에 덮어쓰지 않고 별도 대상에서 수량·금액·번호·PDF 바이트를 대사한다. 실제 별도 대상 복원을 수행하기 전에는 복구 검증 완료로 보고하지 않는다.

## 검증 근거와 장애 대응

[4단계 검증](erp-phase4.md)의 빌드·타입·린트, 단위 128건, 서버 회귀, 규칙 1,179건과 PC·모바일 ERP 검사를 바탕으로 배포한다. 배포 준비 중 추가로 관리자·결제·화면 로딩 회귀 34건과 수정한 백업 안내 화면의 린트·빌드를 확인했다. GitHub CI는 격리된 demo 에뮬레이터에서 전체 브라우저 시나리오를 다시 수행한다.

배포 실패 시 실패한 단계와 SHA를 기록하고 동일 커밋의 상태를 먼저 확인한다. 웹만 복구할 때는 Cloudflare의 이전 정상 배포를 사용한다. DB 원장·기발행 PDF·번호를 삭제하거나 이전 덤프로 덮어써 코드 롤백을 대신하지 않는다. 확정 재고의 업무 수정은 취소·반품·조정 원장을 남긴다.

첫 회사 확인 이후의 다음 개발은 **ERP 전용 백업·복원 절차, 운영 오류 관측과 대량 데이터 성능 점검**이다.

참고: [Cloudflare 운영 절차](cloudflare-deployment.md), [Firestore 백업과 별도 DB 복원](https://docs.cloud.google.com/firestore/native/docs/backups), [Storage 객체 버전 관리](https://docs.cloud.google.com/storage/docs/object-versioning).
