# 프로젝트 작업 지침

- 현재 상태: 1차 개발 완료. 이후 작업은 기존 기능을 기반으로 한 추가 개발 단계이다.
- 기본 저장소는 `https://github.com/jwmaxum/hr-flow`다. 서비스 웹은 해당 저장소의 `main`과 연동된 Cloudflare Pages 프로젝트 `hr-flow`에서 배포한다. 새 계정의 공개 주소는 `https://hr-flow-chj.pages.dev/`다. 기존 `https://hr-flow.pages.dev/` 서비스는 별도 계정에서 유지하며 이번 배포 대상으로 간주하지 않는다.
- Cloudflare 빌드 설정은 root `client`, 명령 `npm run lint && npm run test:unit && npm run build`, 출력 `dist`, Node.js `24`다. 배포 후 GitHub의 Cloudflare Pages 체크와 새 공개 주소의 HTML·정적 파일·보안 헤더를 확인한다. 상세 절차는 `docs/cloudflare-deployment.md`를 따른다.
- Firebase Authentication, Firestore, Storage, Cloud Functions는 애플리케이션의 백엔드 서비스로 사용한다. 웹 배포와 Firebase 리소스 배포를 구분한다.
- 기존 `npm run deploy`는 Firebase Hosting을 포함하는 레거시 명령이다. Cloudflare 웹 배포 명령으로 사용하지 않는다.
- `.github/workflows/deploy.yml`은 빌드·린트·회귀 검증 전용이며 배포 권한을 갖지 않는다. 실제 웹 배포는 Cloudflare Pages의 GitHub 연동을 사용한다. 이 워크플로에 Firebase Hosting·GitHub Pages 배포를 추가하지 않는다.
- GitHub 접근 토큰은 로컬 `.env.local`에 있다. 향후 `git push`가 필요할 때만 안전하게 사용하고, 값은 출력하거나 커밋하거나 문서에 기록하지 않는다. 같은 키가 중복돼 있으면 마지막 값을 무조건 선택하지 말고 인증 사용자와 대상 `jwmaxum/hr-flow`의 쓰기 권한을 검증하여 선택한다. 확인 없이 자격 증명 파일을 수정하지 않는다. Git은 `.env.local`을 자동으로 읽지 않는다.
- `.env.local`은 Git 추적 대상에서 제외한다. 배포용 자격 증명은 로컬 파일과 별도로 해당 배포 환경의 비밀 변수에 설정한다.
- `VITE_*`는 최종 브라우저 코드에 포함될 수 있는 공개 클라이언트 설정이다. GitHub·Cloudflare·R2·Firebase 관리 자격 증명은 이 접두사로 전달하지 않는다. 새 호스트를 추가할 때 Firebase Auth 허용 도메인과 첨부 API의 정확한 CORS 허용 출처를 확인하며 회사·사용자 접근 검증은 유지한다.
