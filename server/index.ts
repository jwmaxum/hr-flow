import express from 'express';
import { isValidNewPassword, PASSWORD_LENGTH_ERROR } from '../functions/password-policy.mjs';
import cors from 'cors';
import dotenv from 'dotenv';
import { adminAuth, adminDb } from './firebaseAdmin';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// CORS 설정: 클라이언트 개발 서버(5173)에서의 요청 허용
app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Express 확장 규격: req.user 인터페이스 확장 정의
interface AuthenticatedRequest extends express.Request {
  user?: any;
}

// [보안 미들웨어] Firebase ID Token 검증 및 인증 처리
const authenticate = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '인증 헤더가 누락되었거나 유효하지 않습니다.' });
  }

  const parts = authHeader.split('Bearer ');
  const idToken = parts[1];
  if (!idToken) {
    return res.status(401).json({ error: '인증 헤더 내 토큰 구조가 유효하지 않습니다.' });
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(idToken, true);
    req.user = decodedToken;
    next();
  } catch (error: any) {
    console.error('[Auth Middleware] Token verification failed:', error.message);
    return res.status(401).json({ error: '인증 세션이 만료되었거나 검증에 실패하였습니다.' });
  }
};

// 서버 상태 확인용
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// [보안 패치 완료] 비밀번호 초기화 엔드포인트
// 1. authenticate 미들웨어를 장착하여 로그인 사용자만 접근 허용
// 2. 권한 인가 절차(SUPER_ADMIN 또는 동일 소속 ADMIN) 검사 추가
// 3. 평문 비밀번호 콘솔 로깅 제거
app.post('/api/reset-password', authenticate, async (req: AuthenticatedRequest, res) => {
  const { uid, password } = req.body;
  const callerUid = req.user?.uid;

  if (!callerUid) {
    return res.status(401).json({ error: '유효한 사용자 인증 정보가 확인되지 않습니다.' });
  }

  if (!uid || !password) {
    return res.status(400).json({ error: '사용자 UID와 새 비밀번호가 필요합니다.' });
  }

  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
    return res.status(400).json({ error: '유효한 사용자 ID가 필요합니다.' });
  }
  if (!isValidNewPassword(password)) return res.status(400).json({ error: PASSWORD_LENGTH_ERROR });

  try {
    const db = adminDb;
    // 호출자(caller) 정보 및 대상(target) 정보 조회
    const callerRef = db.collection('UserProfile').doc(callerUid);
    const targetRef = db.collection('UserProfile').doc(uid);

    const [callerSnap, targetSnap] = await Promise.all([callerRef.get(), targetRef.get()]);

    if (!callerSnap.exists) {
      return res.status(403).json({ error: '호출자 계정 정보를 데이터베이스에서 찾을 수 없습니다.' });
    }

    const callerData = callerSnap.data();

    if ((callerData?.status || 'ACTIVE') !== 'ACTIVE' || callerData?.mustChangePassword ||
        (callerData?.sessionValidAfter && req.user.auth_time < callerData.sessionValidAfter)) {
      return res.status(403).json({ error: '활성 계정에서 비밀번호 변경을 완료한 후 이용해 주세요.' });
    }
    if (callerData?.role === 'SUPER_ADMIN' && callerData.companyId !== 'PLATFORM') {
      return res.status(403).json({ error: '플랫폼 관리자 권한이 필요합니다.' });
    }
    if (callerData?.role === 'ADMIN') {
      const tenant = await db.collection('companies').doc(callerData.companyId).get();
      if (!tenant.exists || tenant.data()?.status !== 'ACTIVE' ||
          !(tenant.data()?.accessUntil?.toMillis?.() > Date.now())) {
        return res.status(403).json({ error: '활성 구독 중인 회사에서만 이용할 수 있습니다.' });
      }
    }
    if (!targetSnap.exists || targetSnap.data()?.role === 'SUPER_ADMIN') {
      return res.status(403).json({ error: '관리할 수 없는 계정입니다.' });
    }

    // 권한 검증 분기
    if (callerData?.role === 'SUPER_ADMIN') {
      console.log(`[Admin API] SUPER_ADMIN ${callerUid} is resetting password for target user ${uid}`);
    } else if (callerData?.role === 'ADMIN') {
      if (!targetSnap.exists) {
        return res.status(404).json({ error: '대상이 되는 사용자를 찾을 수 없습니다.' });
      }
      const targetData = targetSnap.data();
      // 소속 회사(companyId) 일치 확인
      if (callerData.companyId !== targetData?.companyId) {
        return res.status(403).json({ error: '소속 조직이 다른 사용자의 비밀번호는 관리할 수 없습니다.' });
      }
      const companySnap = await db.collection('companies').doc(callerData.companyId).get();
      if (uid === callerUid || targetData?.role === 'ADMIN' ||
          companySnap.data()?.adminUid === uid) {
        return res.status(403).json({ error: '관리자 계정의 비밀번호는 재설정할 수 없습니다.' });
      }
      console.log(`[Admin API] ADMIN ${callerUid} (Company: ${callerData.companyId}) is resetting password for target user ${uid}`);
    } else {
      return res.status(403).json({ error: '비밀번호를 강제로 재설정할 관리자 권한이 없습니다.' });
    }

    // Firebase Admin SDK를 통해 실제 인증 시스템의 비밀번호를 업데이트합니다.
    await targetRef.update({ mustChangePassword: true });
    await adminAuth.updateUser(uid, { password: password });
    await adminAuth.revokeRefreshTokens(uid);
    
    // [보안 개선] 평문 비밀번호가 로깅되지 않도록 식별자만 로그에 남김
    console.log(`[Admin API] User ${uid} password reset successfully by ${callerUid}`);
    
    res.json({ 
      success: true, 
      message: '인증 시스템의 비밀번호가 성공적으로 업데이트되었습니다.' 
    });
  } catch (error: any) {
    console.error(`[Admin API] Reset failed for user ${uid}:`, error);
    res.status(500).json({ 
      success: false, 
      error: '비밀번호 업데이트 중 오류가 발생했습니다. 로그를 검토해주십시오.' 
    });
  }
});

app.listen(port, () => {
  console.log('--------------------------------------------------');
  console.log(`🚀 HR Management Admin Server is running!`);
  console.log(`📡 URL: http://localhost:${port}`);
  console.log(`🛠️ API: POST /api/reset-password`);
  console.log('--------------------------------------------------');
});
