const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { createOfficialLetterService } = require('./official-letter-service');
const { renderOfficialLetterPdf } = require('./official-letter-pdf');
const { createMemberService } = require('./member-service');
const { createAccountSecurityService } = require('./account-security-service');
const { createAdminSecurityService } = require('./admin-security-service');
const { createAttachmentService } = require('./attachment-service');
const { createPayrollService } = require('./payroll-service');
const { renderMonthlyPayrollPdf, renderAnnualPayrollPdf } = require('./payroll-pdf');
const { authorizeContext } = require('./security-context');

initializeApp();
const dependencies = () => ({ db: getFirestore('(default)'), auth: getAuth(), bucket: getStorage().bucket('weberp-8f25f.firebasestorage.app') });
const callable = (handler, options = {}) => onCall({ maxInstances: 10, timeoutSeconds: 60, ...options }, async request => {
  try {
    const dep = dependencies();
    if (request.auth) {
      const bearer = /^Bearer ([^\s]+)$/.exec(request.rawRequest.headers.authorization || '');
      try {
        if (!bearer) throw new Error('missing');
        await dep.auth.verifyIdToken(bearer[1], true);
      } catch { throw new HttpsError('unauthenticated', '로그인을 다시 확인해 주세요.'); }
    }
    return await handler(request, dep);
  }
  catch (error) {
    if (error instanceof HttpsError) throw error;
    console.error('[ServiceError]', error.code || 'internal');
    throw new HttpsError('internal', '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }
});
exports.manageOfficialLetters = callable((request, dep) => createOfficialLetterService({ ...dep,
  renderPdf: renderOfficialLetterPdf })(request), { memory: '512MiB' });
exports.adminCreateMember = callable((request, dep) => createMemberService(dep)(request));
exports.accountSecurity = callable((request, dep) => createAccountSecurityService(dep)(request));
exports.managePayroll = callable((request, dep) => createPayrollService({ ...dep,
  renderMonthlyPdf: renderMonthlyPayrollPdf, renderAnnualPdf: renderAnnualPayrollPdf })(request), { memory: '512MiB', timeoutSeconds: 120, concurrency: 1 });
exports.checkDomainAvailability = callable((request, dep) => createAdminSecurityService(dep).checkDomain(request));
exports.adminResetPassword = callable((request, dep) => createAdminSecurityService(dep).resetPassword(request));
exports.adminSyncCompanyDomain = callable((request, dep) => createAdminSecurityService(dep).syncDomain(request), { timeoutSeconds: 300, memory: '512MiB' });
exports.adminDeleteCompanyData = callable((request, dep) => createAdminSecurityService(dep).deleteCompany(request), { timeoutSeconds: 540, memory: '512MiB' });
exports.checkDeploymentStatus = callable(async (request, { db }) => {
  await authorizeContext({ db, request, roles: ['SUPER_ADMIN'] });
  return { version: '3.0.0', deployedAt: new Date().toISOString(), environment: 'production', databaseId: '(default)', status: 'healthy' };
});
exports.uploadCompanyAttachment = onRequest({ maxInstances: 10, memory: '512MiB', timeoutSeconds: 120 }, (req, res) => createAttachmentService(dependencies()).upload(req, res));
exports.downloadCompanyAttachment = onRequest({ maxInstances: 10, memory: '512MiB', timeoutSeconds: 120 }, (req, res) => createAttachmentService(dependencies()).download(req, res));
