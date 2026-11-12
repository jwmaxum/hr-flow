const { createHash, randomUUID } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { PROJECT_ID, WEB_ORIGIN, HOSTS, assertE2EEnvironment } = require('../../scripts/e2e/safety.cjs');
const { seedFixtures, clearFixtures, findExpenseByTitle, readAttachment, revokeTestUser, readProfile, readPayrollRecord, readHistoricalPayroll, seedErpBalance, readErpInventory, clearErpFixture } = require('../../scripts/e2e/fixtures.cjs');
const { workbook: erpWorkbook, opening: erpOpening, movement: erpMovement } = require('../../functions/tests/erp-import-fixtures.cjs');

assertE2EEnvironment();
const { CSV_TEMPLATE, HEADER_FIELDS } = require('../../functions/payroll-import-schema.mjs');

const attachmentHost = `us-central1-${PROJECT_ID}.cloudfunctions.net`;
const attachmentEndpoints = new Set(['/uploadCompanyAttachment', '/downloadCompanyAttachment']);
const localHosts = new Set([new URL(WEB_ORIGIN).host, HOSTS.auth, HOSTS.firestore, HOSTS.storage, HOSTS.functions]);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z5kAAAAASUVORK5CYII=', 'base64');

function blankPdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(content);
  content += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${content}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
}

const files = [
  { name: '자동점검-영수증.png', mimeType: 'image/png', buffer: png },
  { name: '자동점검-견적서.pdf', mimeType: 'application/pdf', buffer: blankPdf() },
];
let fixtures;
let actors = [];

function localUrl(value) {
  const url = new URL(value);
  return url.protocol === 'http:' && localHosts.has(url.host) && !url.username && !url.password;
}

function attachmentUrl(documentId, extra = {}) {
  const query = new URLSearchParams({ category: 'expenses', documentId, ...extra });
  return `https://${attachmentHost}/downloadCompanyAttachment?${query}`;
}

function firestoreUrl(documentId) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(documentId)) throw new Error('A synthetic document ID is required.');
  return `http://${HOSTS.firestore}/v1/projects/${PROJECT_ID}/databases/(default)/documents/expenses/${documentId}`;
}

function kstDate() {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

async function actorFor(browser, testInfo) {
  const settings = testInfo.project.use;
  const context = await browser.newContext({
    baseURL: WEB_ORIGIN, viewport: settings.viewport, isMobile: Boolean(settings.isMobile),
    hasTouch: Boolean(settings.hasTouch), locale: 'ko-KR', timezoneId: 'Asia/Seoul',
    reducedMotion: 'reduce', acceptDownloads: true, serviceWorkers: 'block',
  });
  const actor = { context, page: await context.newPage(), violations: [], pageErrors: 0, dialogs: 0, token: '', passwordChangeAlert: false, passwordChangeNotices: 0,
    expectedPayrollConfirmation: null, payrollConfirmations: 0, payrollRequests: [] };
  actors.push(actor);
  actor.page.on('pageerror', () => { actor.pageErrors += 1; });
  actor.page.on('dialog', async dialog => {
    if (actor.expectedPayrollConfirmation && dialog.type() === 'confirm' &&
        dialog.message() === actor.expectedPayrollConfirmation && actor.page.url() === `${WEB_ORIGIN}/#/admin/salary`) {
      actor.expectedPayrollConfirmation = null; actor.payrollConfirmations += 1;
      await dialog.accept(); return;
    }
    if (actor.passwordChangeAlert && dialog.type() === 'alert' && dialog.message() === '비밀번호를 변경했습니다. 1초 후 새 비밀번호로 다시 로그인해 주세요.') {
      actor.passwordChangeAlert = false; actor.passwordChangeNotices += 1;
    } else actor.dialogs += 1;
    await dialog.dismiss();
  });
  actor.page.on('request', async request => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' && url.host === HOSTS.functions &&
        url.pathname === `/${PROJECT_ID}/us-central1/managePayroll` && request.method() === 'POST') {
      try {
        const input = request.postDataJSON()?.data;
        if (input && typeof input.action === 'string') actor.payrollRequests.push({ action: input.action,
          year: input.year, month: input.month, expectedFingerprint: input.expectedFingerprint,
          ...(input.id ? { id: input.id } : {}), ...(input.revision !== undefined ? { revision: input.revision } : {}) });
      } catch { actor.violations.push('local-payroll-request-shape'); }
    }
    if (url.protocol === 'http:' && url.host === HOSTS.functions &&
        url.pathname === `/${PROJECT_ID}/us-central1/accountSecurity` && request.method() === 'POST') {
      try {
        const authorization = (await request.allHeaders()).authorization || '';
        if (authorization.startsWith('Bearer ')) actor.token = authorization.slice(7);
      } catch { actor.violations.push('local-session-header-capture'); }
    }
  });
  await context.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.protocol === 'ws:' && url.host === new URL(WEB_ORIGIN).host && !url.username && !url.password) {
      socket.connectToServer();
      return;
    }
    actor.violations.push(url.hostname || 'unsupported-websocket');
    socket.close();
  });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'https:' && url.hostname === attachmentHost && !url.port &&
        attachmentEndpoints.has(url.pathname) && !url.username && !url.password) {
      // Only change transport for the exact demo endpoints. The production handler,
      // bearer verification, CORS, payload and Firestore/Storage rules remain real.
      const target = `http://${HOSTS.functions}/${PROJECT_ID}/us-central1${url.pathname}${url.search}`;
      if (!localUrl(target)) throw new Error('Invalid local attachment transport.');
      const headers = { ...await request.allHeaders(), origin: WEB_ORIGIN };
      delete headers.host;
      try {
        const response = await route.fetch({ url: target, method: request.method(), headers,
          postData: request.postDataBuffer() || undefined, maxRedirects: 0, timeout: 65000 });
        if (response.status() >= 300 && response.status() < 400) {
          actor.violations.push('attachment-redirect');
          await route.abort('blockedbyclient');
          return;
        }
        await route.fulfill({ response });
      } catch {
        // Playwright transport errors can include Authorization in their call log.
        actor.violations.push('local-attachment-transport');
        await route.abort('failed').catch(() => {});
      }
      return;
    }
    if (localUrl(url.href)) return route.continue();
    if (['blob:', 'data:', 'about:'].includes(url.protocol)) return route.continue();
    actor.violations.push(url.hostname || 'unsupported-scheme');
    await route.abort('blockedbyclient');
  });
  return actor;
}

async function login(actor, account, { denied = false, passwordRequired = false, invalidPassword = false } = {}) {
  actor.token = '';
  await actor.page.goto('/#/login');
  await actor.page.getByPlaceholder('admin@yourcompany.com').fill(account.email);
  try {
    await actor.page.getByPlaceholder('비밀번호 입력', { exact: true }).fill(account.password);
  } catch {
    throw new Error('Could not enter the generated test-account password.');
  }
  await actor.page.locator('form').getByRole('button', { name: '로그인', exact: true }).click();
  if (invalidPassword) {
    await expect(actor.page.getByText(/이메일 또는 비밀번호가 올바르지 않습니다|auth\/(?:wrong-password|invalid-credential)/).first()).toBeVisible();
    await expect(actor.page).toHaveURL(/#\/login$/);
    return;
  }
  if (passwordRequired) {
    await expect(actor.page.getByRole('dialog', { name: '비밀번호 변경', exact: true })).toBeVisible({ timeout: 65000 });
    await expect(actor.page.getByRole('heading', { name: '대시보드', exact: true })).toHaveCount(0);
    await expect.poll(() => Boolean(actor.token)).toBe(true);
    return;
  }
  if (denied) {
    await expect(actor.page.getByText(/활성 계정의 권한이 필요합니다|사용 중지|비활성화|auth\/user-disabled/).first()).toBeVisible({ timeout: 65000 });
    await expect(actor.page).toHaveURL(/#\/login$/);
    await expect(actor.page.getByRole('heading', { name: '대시보드', exact: true })).toHaveCount(0);
    return;
  }
  await expect(actor.page).toHaveURL(account.role === 'SUPER_ADMIN' ? /#\/super-admin$/ : /#\/dashboard$/, { timeout: 65000 });
  await expect(actor.page.getByRole('heading', { name: account.role === 'SUPER_ADMIN' ? '플랫폼 관리 센터' : '대시보드', exact: true })).toBeVisible({ timeout: 65000 });
  await expect.poll(() => Boolean(actor.token), { message: 'The real session request supplies an in-memory bearer token.' }).toBe(true);
}

async function createExpense(actor, file, label) {
  const title = `자동점검 ${label} ${randomUUID()}`;
  await actor.page.goto('/#/expense');
  await expect(actor.page.getByRole('heading', { name: '지출결의 신청', exact: true })).toBeVisible();
  const additional = actor.page.getByRole('button', { name: '추가 신청하기', exact: true });
  if (await additional.isVisible()) await additional.click();
  await expect(actor.page.locator('#expense-title')).toBeVisible();
  const monthValues = await actor.page.locator('#expense-filter-month option').evaluateAll(options => options.map(option => option.value));
  expect(monthValues.length).toBe(13);
  expect(new Set(monthValues).size).toBe(13);
  expect(monthValues.filter(value => /^\d{4}-\d{2}$/.test(value)).length).toBe(12);
  expect(monthValues.filter(value => value === 'all').length).toBe(1);
  await actor.page.locator('#expense-title').fill(title);
  await actor.page.locator('#expense-category').selectOption('비품/소모품');
  await actor.page.locator('#expense-amount').fill('1200');
  await actor.page.locator('#expense-date').fill(kstDate());
  await actor.page.locator('#expense-description').fill('실제 회사 자료가 없는 자동 점검용 첨부입니다.');
  await actor.page.locator('#expense-file').setInputFiles(file);
  await actor.page.getByRole('button', { name: '지출결의 제출', exact: true }).click();
  await expect(actor.page.getByRole('heading', { name: '신청 완료!', exact: true })).toBeVisible({ timeout: 65000 });
  const record = await findExpenseByTitle(title);
  expect(record.attachmentName).toBe(file.name);
  expect(record.attachmentPath.startsWith(`companies/${record.companyId}/expenses/${record.userId}/`)).toBe(true);
  expect((await readAttachment(record.attachmentPath)).equals(file.buffer)).toBe(true);
  return record;
}

async function downloadExpense(actor, record, file) {
  await actor.page.goto('/#/expense');
  await actor.page.getByRole('button', { name: `${record.title} 상세 보기`, exact: true }).click();
  const dialog = actor.page.getByRole('dialog', { name: '지출결의 상세서', exact: true });
  await expect(dialog).toBeVisible();
  const downloaded = actor.page.waitForEvent('download');
  await dialog.getByRole('button', { name: '다운로드', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(file.name);
  const stream = await download.createReadStream();
  if (!stream) throw new Error('The generated test attachment could not be downloaded.');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(file.buffer)).toBe(true);
  await dialog.getByRole('button', { name: '지출결의 상세 닫기', exact: true }).click();
}

async function probe(actor, url, { method = 'GET', body, anonymous = false } = {}) {
  const destination = new URL(url);
  const demoAttachment = destination.protocol === 'https:' && destination.hostname === attachmentHost &&
    !destination.port && attachmentEndpoints.has(destination.pathname) && !destination.username && !destination.password;
  if (!demoAttachment && !localUrl(url)) throw new Error('Only guarded local E2E HTTP requests are permitted.');
  if (!anonymous && !actor.token) throw new Error('A real test-account session is required.');
  try {
    return await actor.page.evaluate(async input => {
      try {
        const response = await fetch(input.url, { method: input.method, credentials: 'omit', cache: 'no-store', redirect: 'error',
          headers: { ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}), ...(input.body ? { 'Content-Type': 'application/json' } : {}) },
          body: input.body ? JSON.stringify(input.body) : undefined });
        const bytes = new Uint8Array(await response.arrayBuffer());
        return { status: response.status, bytes: Array.from(bytes), cacheControl: response.headers.get('cache-control') || '' };
      } catch { return { status: 0, bytes: [], cacheControl: '' }; }
    }, { url, method, body, token: anonymous ? '' : actor.token });
  } catch {
    throw new Error('The isolated authenticated HTTP probe did not complete.');
  }
}

const payrollEndpoint = `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/managePayroll`;
const payrollProbe = (actor, data) => probe(actor, payrollEndpoint, { method: 'POST', body: { data } });
function callableResult(response) {
  if (response.status !== 200) throw new Error('The guarded E2E payroll callable did not succeed.');
  const body = JSON.parse(Buffer.from(response.bytes).toString('utf8'));
  if (!body.result || typeof body.result !== 'object') throw new Error('The E2E payroll result is missing.');
  return body.result;
}
function payrollFirestoreUrl(id) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('A synthetic payroll document ID is required.');
  return `http://${HOSTS.firestore}/v1/projects/${PROJECT_ID}/databases/(default)/documents/payroll_records/${id}`;
}
async function payrollDownload(actor, button, year = 2026) {
  const downloadPromise = actor.page.waitForEvent('download', { timeout: 65000 });
  await button.click();
  const downloaded = await downloadPromise;
  expect(downloaded.suggestedFilename()).toMatch(new RegExp(`${year}.*\\.pdf$`));
  const stream = await downloaded.createReadStream();
  if (!stream) throw new Error('The real approved payroll PDF did not download.');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(-100).toString()).toMatch(/%%EOF\s*$/);
  return bytes;
}
async function payrollSourceDownload(actor, button, expectedName) {
  const pending = actor.page.waitForEvent('download', { timeout: 65000 });
  await button.click(); const downloaded = await pending;
  expect(downloaded.suggestedFilename()).toBe(expectedName);
  const stream = await downloaded.createReadStream();
  if (!stream) throw new Error('The generated historical source could not be downloaded.');
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function historicalCsv(rows) {
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return Buffer.from(CSV_TEMPLATE + rows.map(row => HEADER_FIELDS.map(field => cell(row[field.key])).join(',')).join('\r\n') + '\r\n');
}
function confirmHistoricalPayroll(actor, draft) {
  const won = value => `${value.toLocaleString('ko-KR')}원`;
  const refunds = draft.rows.filter(row => ['pension', 'health', 'longTerm', 'employment', 'incomeTax', 'localTax', 'otherDeductions'].some(key => (row.amounts[key] ?? 0) < 0)).length;
  actor.expectedPayrollConfirmation = `${draft.year}년 ${draft.month}월 회사 전체 ${draft.rows.length}명의 자료를 승인·발행합니까?\n\n총 지급액: ${won(draft.sums.monthlyGross)}\n공제합계: ${won(draft.sums.totalDeductions)}\n실지급액: ${won(draft.sums.netPay)}\n추가 ${draft.diff.added.length}명 · 제외 ${draft.diff.removed.length}명 · 변경 ${draft.diff.changed.length}명\n환급 등 음수 공제 포함 ${refunds}명\n\n이 월 전체를 새 개정본으로 발행합니다. 이전 승인본과 원본·수정 이력은 보관하며 연간 명세서에는 새 승인본이 반영됩니다. 승인 전까지 기존 승인본은 유지됩니다.`;
}

function forgedExpense(account, overrides = {}) {
  const data = { companyId: account.companyId, userId: account.uid, userName: account.name,
    divisionId: account.divisionId, teamId: account.teamId, title: '자동점검 격리 검증', amount: 1200,
    date: kstDate(), category: '비품/소모품', description: '격리 검증용 데이터', status: 'PENDING',
    attachmentName: '', attachmentPath: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides };
  return { fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key,
    typeof value === 'number' ? { doubleValue: value } : { stringValue: value }])) };
}

test.beforeAll(async () => { fixtures = await seedFixtures(); });
test.afterAll(async () => { await clearFixtures(); });
test.beforeEach(() => { actors = []; });
test.afterEach(async ({}, testInfo) => {
  try {
    if (testInfo.status !== testInfo.expectedStatus) {
      for (let index = 0; index < actors.length; index += 1) {
        await actors[index].page.screenshot({ path: testInfo.outputPath(`synthetic-account-${index + 1}.png`), fullPage: true }).catch(() => {});
      }
    }
    expect(actors.flatMap(actor => actor.violations), 'Unexpected external traffic or local transport failure.').toEqual([]);
    expect(actors.reduce((count, actor) => count + actor.pageErrors, 0), 'Uncaught application errors.').toBe(0);
    expect(actors.reduce((count, actor) => count + actor.dialogs, 0), 'Unexpected application dialogs.').toBe(0);
  } finally {
    for (const actor of actors) { actor.token = ''; await actor.context.close(); }
  }
});

test('public landing preserves guide navigation and login with the shared theme', async ({ browser }, testInfo) => {
  const actor = await actorFor(browser, testInfo);
  await actor.page.goto('/');
  const preview = actor.page.getByRole('tab', { name: '기능 한눈에 보기', exact: true });
  const manual = actor.page.getByRole('tab', { name: '기능요약 설명서', exact: true });
  await expect(preview).toBeVisible();
  await expect(actor.page.locator('.landing-page')).toHaveCSS('font-family', /SUIT Variable/);
  await actor.page.evaluate(() => document.fonts.ready);
  expect(await actor.page.evaluate(() => document.fonts.check('14px "SUIT Variable"'))).toBe(true);
  expect(await actor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await preview.focus();
  await actor.page.keyboard.press('End');
  await expect(manual).toHaveAttribute('aria-selected', 'true');
  await expect(actor.page.locator('#guide-panel-manual')).toBeVisible();
  await actor.page.getByRole('navigation', { name: '기능 설명서 목차', exact: true })
    .getByRole('link', { name: /역할과 메뉴 권한/ }).click();
  await expect(actor.page.locator('#guide-roles')).toBeFocused();
  await manual.focus();
  await actor.page.keyboard.press('Home');
  await expect(preview).toHaveAttribute('aria-selected', 'true');
  await actor.page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(actor.page).toHaveURL(/#\/login$/);
  await expect(actor.page.getByPlaceholder('admin@yourcompany.com')).toBeVisible();
});

test('real platform, company-owner and member logins preserve role navigation', async ({ browser }, testInfo) => {
  for (const [key, displayRole] of [['platform', 'SYSTEM_ADMIN'], ['adminA', 'SUPER_ADMIN'], ['memberA', 'MEMBER']]) {
    const actor = await actorFor(browser, testInfo);
    await login(actor, fixtures.accounts[key]);
    await expect(actor.page.locator('.sidebar-user').first()).toContainText(displayRole);
    if (key === 'platform') {
      await expect(actor.page.locator('.workspace-shell.workflow-theme')).toBeVisible();
      await expect(actor.page.locator('.workspace-shell')).toHaveCSS('font-family', /SUIT Variable/);
      if (testInfo.project.use.isMobile) {
        await actor.page.getByRole('button', { name: '메뉴 열기', exact: true }).click();
        await expect(actor.page.getByRole('link', { name: '플랫폼 관리', exact: true })).toBeVisible();
        await actor.page.keyboard.press('Escape');
        await expect(actor.page.getByRole('button', { name: '메뉴 열기', exact: true })).toBeFocused();
      }
    }
    if (key === 'memberA') {
      await expect(actor.page.getByRole('link', { name: '플랫폼 관리', exact: true })).toHaveCount(0);
      await expect(actor.page.getByRole('link', { name: '조직관리', exact: true })).toHaveCount(0);
    }
    // This check needs one role at a time; do not keep the platform's global
    // collection listeners alive while the next isolated browser signs in.
    actor.token = '';
    await actor.context.close();
  }
});

test('ERP company masters and name search show independent inventory on desktop and mobile', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  const owner = await actorFor(browser, testInfo);
  await login(owner, fixtures.accounts.adminA);
  await owner.page.locator('a.erp-entry:visible').first().click();
  await expect(owner.page.getByRole('heading', { name: '재고관리 ERP', exact: true })).toBeVisible();
  // The first emulator callable can start slowly. Wait for the actual list
  // response before switching tabs and starting a separate mutation.
  await expect(owner.page.getByRole('region', { name: '품목 목록', exact: true }).locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  await owner.page.getByRole('button', { name: '창고 관리', exact: true }).click();
  await expect(owner.page.getByRole('region', { name: '창고 목록', exact: true }).locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  await owner.page.getByRole('button', { name: '창고 등록', exact: true }).click();
  await owner.page.getByLabel('창고코드 *', { exact: true }).fill('WH-001');
  await owner.page.getByLabel('창고명 *', { exact: true }).fill('자동점검 A창고');
  await owner.page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(owner.page.getByRole('status').filter({ hasText: '저장 완료' })).toBeVisible({ timeout: 65000 });
  await owner.page.getByRole('button', { name: '품목·재고현황', exact: true }).click();
  async function createItem(actor, name, price) {
    await actor.page.getByRole('button', { name: '품목 정보만 등록', exact: true }).click();
    await actor.page.getByLabel('품목코드 *', { exact: true }).fill('ERP-001');
    await actor.page.getByLabel('품목명 *', { exact: true }).fill(name);
    await actor.page.getByLabel('단위 *', { exact: true }).fill('EA');
    await actor.page.getByLabel('매입단가 (원) *', { exact: true }).fill(String(price));
    await actor.page.getByLabel('판매단가 (원) *', { exact: true }).fill(String(price * 2));
    await actor.page.getByRole('button', { name: '저장', exact: true }).click();
    await expect(actor.page.getByRole('status').filter({ hasText: '저장 완료' })).toBeVisible();
    await expect(actor.page.getByText('재고 미등록', { exact: true })).toBeVisible();
  }
  await createItem(owner, '자동점검 A품목', 1000);
  const stock = await seedErpBalance(fixtures.companyA, 'ERP-001', 'WH-001');
  await owner.page.getByLabel('품목명 검색', { exact: true }).fill('자동점검 A');
  const panel = owner.page.getByRole('region', { name: '품목 재고현황' });
  await expect(panel.getByRole('cell', { name: '7', exact: true })).toBeVisible();
  await expect(panel.getByRole('cell', { name: '7,000', exact: true })).toBeVisible();
  await owner.page.getByRole('button', { name: '자동점검 A품목 재고 보기', exact: true }).click();
  await expect(panel.getByRole('cell', { name: '7', exact: true })).toBeVisible();
  await owner.page.getByRole('button', { name: '품목 수정', exact: true }).click();
  await owner.page.getByLabel('판매단가 (원) *', { exact: true }).fill('2200');
  await owner.page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(panel.getByText('2,200원', { exact: true })).toBeVisible();
  await owner.page.screenshot({ path: testInfo.outputPath('erp-inventory.png'), fullPage: true });
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await owner.page.getByRole('button', { name: '거래처 관리', exact: true }).click();
  await owner.page.getByRole('button', { name: '거래처 등록', exact: true }).click();
  await owner.page.getByLabel('거래처코드 *', { exact: true }).fill('PART-001');
  await owner.page.getByLabel('거래처명 *', { exact: true }).fill('자동점검 재사용 거래처');
  await owner.page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(owner.page.getByRole('button', { name: '자동점검 재사용 거래처 수정' })).toBeVisible();
  await owner.page.reload();
  await owner.page.getByRole('button', { name: '거래처 관리', exact: true }).click();
  await owner.page.getByLabel('거래처명 검색', { exact: true }).fill('자동점검 재사용');
  await expect(owner.page.getByRole('button', { name: '자동점검 재사용 거래처 수정' })).toBeVisible();

  const foreign = await actorFor(browser, testInfo);
  await login(foreign, fixtures.accounts.adminB); await foreign.page.goto('/#/erp');
  await createItem(foreign, '자동점검 B품목', 9000);
  await expect(foreign.page.getByText('자동점검 A품목', { exact: true })).toHaveCount(0);
  const erpEndpoint = `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/manageErp`;
  expect((await probe(foreign, erpEndpoint, { method: 'POST', body: { data: { action: 'inventory', companyId: fixtures.companyA, itemId: stock.itemId } } })).status).toBe(403);

  const member = await actorFor(browser, testInfo);
  await login(member, fixtures.accounts.memberA); await member.page.goto('/#/erp');
  await member.page.getByLabel('품목명 검색', { exact: true }).fill('자동점검 A');
  await expect(member.page.getByRole('region', { name: '품목 재고현황' }).getByRole('cell', { name: '7', exact: true })).toBeVisible();
  await expect(member.page.getByRole('button', { name: '품목 정보만 등록', exact: true })).toHaveCount(0);
  await expect(member.page.getByText('기본 매입단가', { exact: true })).toHaveCount(0);
  await expect(member.page.getByRole('button', { name: '거래처 관리', exact: true })).toHaveCount(0);
});

test('ERP Excel opening and transactions preview then commit once with exact inventory on desktop and mobile', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  await clearErpFixture(fixtures.companyA);
  const foreignBefore = await readErpInventory(fixtures.companyB);
  const actor = await actorFor(browser, testInfo); await login(actor, fixtures.accounts.adminA); await actor.page.goto('/#/erp');
  await expect(actor.page.getByRole('region', { name: '품목 목록', exact: true }).locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  await actor.page.getByRole('button', { name: '창고 관리', exact: true }).click();
  await expect(actor.page.getByRole('region', { name: '창고 목록', exact: true }).locator('[aria-busy]')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  await actor.page.getByRole('button', { name: '창고 등록', exact: true }).click();
  await actor.page.getByLabel('창고코드 *', { exact: true }).fill('WH-01');
  await actor.page.getByLabel('창고명 *', { exact: true }).fill('본사 창고');
  await actor.page.getByRole('button', { name: '저장', exact: true }).click();
  await expect(actor.page.getByRole('status').filter({ hasText: '저장 완료' })).toBeVisible({ timeout: 65000 });
  await actor.page.getByRole('button', { name: 'Excel 업로드', exact: true }).click();
  const input = actor.page.getByLabel('Excel 파일 (.xlsx, 최대 3MB·200행)', { exact: true });
  const opening = await erpWorkbook('OPENING', [erpOpening({ 8: '', 9: '' })]);
  await input.setInputFiles({ name: opening.name, mimeType: opening.mimeType, buffer: Buffer.from(opening.base64, 'base64') });
  await actor.page.getByRole('combobox', { name: '창고 공란에 적용할 회사 창고', exact: true }).selectOption({ label: 'WH-01 · 본사 창고' });
  await actor.page.getByRole('checkbox', { name: /^신규 품목 등록 확인/ }).check();
  const verify = actor.page.getByRole('button', { name: '검증 및 미리보기', exact: true });
  const confirm = actor.page.getByRole('button', { name: 'DB 반영 확정', exact: true });
  const consent = actor.page.getByRole('checkbox', { name: '로그인 회사의 품목·창고·거래처와 위 재고 변동을 확인했습니다.', exact: true });
  await verify.click(); await expect(actor.page.getByRole('status').filter({ hasText: '검증 완료' })).toBeVisible();
  expect(await readErpInventory(fixtures.companyA)).toEqual({ balances: [], itemCount: 0, partnerCount: 0, ledgerCount: 0 });
  await expect(confirm).toBeDisabled(); await consent.check(); await confirm.click();
  await expect(actor.page.getByRole('status').filter({ hasText: 'DB 반영 완료' })).toBeVisible();
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 10, value: 1000 }]);
  await actor.page.getByRole('combobox', { name: '업로드 종류', exact: true }).selectOption('MOVEMENTS');
  const transaction = await erpWorkbook('MOVEMENTS', [erpMovement({ 9: '', 10: '' }), erpMovement({ 1: 2, 2: '출고', 3: 'OUT-001', 9: '', 10: '', 11: 5, 12: 300 })]);
  await input.setInputFiles({ name: transaction.name, mimeType: transaction.mimeType, buffer: Buffer.from(transaction.base64, 'base64') });
  await actor.page.getByRole('checkbox', { name: /^신규 거래처 등록 확인/ }).check();
  await verify.click(); await expect(actor.page.getByRole('status').filter({ hasText: '검증 완료' })).toBeVisible();
  const preview = actor.page.getByRole('region', { name: '업로드 미리보기', exact: true });
  await expect(preview.getByRole('cell', { name: '3,000 → 2,250', exact: true })).toBeVisible();
  await expect(preview.getByRole('cell', { name: '750', exact: true })).toBeVisible();
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 10, value: 1000 }]);
  await consent.check(); await confirm.click();
  await expect(actor.page.getByRole('status').filter({ hasText: 'DB 반영 완료' })).toBeVisible();
  const final = await readErpInventory(fixtures.companyA);
  expect(final).toEqual({ balances: [{ quantity: 15, value: 2250 }], itemCount: 1, partnerCount: 1, ledgerCount: 3 });
  const downloaded = actor.page.waitForEvent('download'); await preview.getByRole('button', { name: '원본 받기', exact: true }).click();
  const source = await downloaded; expect(source.suggestedFilename()).toBe(transaction.name);
  const stream = await source.createReadStream(); const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).equals(Buffer.from(transaction.base64, 'base64'))).toBe(true);
  await actor.page.getByRole('button', { name: '반영된 재고 확인', exact: true }).click();
  await actor.page.getByLabel('품목명 검색', { exact: true }).fill('합성 품목');
  const inventory = actor.page.getByRole('region', { name: '품목 재고현황' });
  await expect(inventory.getByRole('cell', { name: '15', exact: true })).toBeVisible();
  await expect(inventory.getByRole('cell', { name: '2,250', exact: true })).toBeVisible();
  await actor.page.getByRole('button', { name: 'Excel 업로드', exact: true }).click();
  await actor.page.getByRole('combobox', { name: '업로드 종류', exact: true }).selectOption('MOVEMENTS');
  await input.setInputFiles({ name: transaction.name, mimeType: transaction.mimeType, buffer: Buffer.from(transaction.base64, 'base64') });
  await actor.page.getByRole('combobox', { name: '창고 공란에 적용할 회사 창고', exact: true }).selectOption({ label: 'WH-01 · 본사 창고' });
  await verify.click(); await expect(actor.page.getByRole('status').filter({ hasText: '검증 완료' })).toBeVisible();
  await expect(actor.page.getByRole('alert').filter({ hasText: '이미 확정한 파일' })).toBeVisible();
  await expect(confirm).toBeDisabled(); expect(await readErpInventory(fixtures.companyA)).toEqual(final);
  await actor.page.getByRole('heading', { name: 'Excel 재고 업로드', exact: true }).scrollIntoViewIfNeeded();
  await actor.page.screenshot({ path: testInfo.outputPath('erp-import.png'), fullPage: true });
  expect(await actor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await readErpInventory(fixtures.companyB)).toEqual(foreignBefore);
});

test('ERP manual inbound and outbound preserve receipt prices, value inventory and prepare a statement on desktop and mobile', async ({ browser }, testInfo) => {
  test.setTimeout(360000); await clearErpFixture(fixtures.companyA);
  const foreignBefore = await readErpInventory(fixtures.companyB), actor = await actorFor(browser, testInfo);
  await login(actor, fixtures.accounts.adminA);
  async function call(name, data) {
    const response = await probe(actor, `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/${name}`, { method: 'POST', body: { data: { companyId: fixtures.companyA, ...data } } });
    expect(response.status).toBe(200); return JSON.parse(Buffer.from(response.bytes).toString('utf8')).result;
  }
  await call('manageErp', { action: 'save', kind: 'warehouses', id: 'warehouse', expectedRevision: 0, values: { code: 'WH-01', name: '본사 창고', active: true, address: '', notes: '' } });
  const opening = await call('manageErpImport', { action: 'preview', id: randomUUID(), type: 'OPENING', source: await erpWorkbook('OPENING', [erpOpening()]), options: { allowNewItems: true, allowNewPartners: true } });
  await call('manageErpImport', { action: 'commit', id: opening.import.id, fingerprint: opening.import.preview.fingerprint });
  await actor.page.goto('/#/erp');
  await expect(actor.page.getByRole('button', { name: '입고등록', exact: true })).toBeVisible();
  await actor.page.getByRole('button', { name: '0001 입고등록', exact: true }).click();
  await expect(actor.page.getByRole('heading', { name: '입고등록', exact: true })).toBeVisible();
  await expect(actor.page.getByLabel('품목코드 *', { exact: true })).toHaveValue('0001');
  await expect(actor.page.getByLabel('품목명 *', { exact: true })).toHaveValue('합성 품목');
  await expect(actor.page.getByLabel('입고 창고 *', { exact: true }).locator('option')).toHaveCount(2, { timeout: 65000 });
  await actor.page.getByLabel('입고 창고 *', { exact: true }).selectOption('warehouse');
  await actor.page.getByLabel('거래일 *', { exact: true }).fill('2026-11-02');
  await actor.page.getByLabel('거래처 *', { exact: true }).selectOption('NEW');
  await actor.page.getByLabel('거래처 코드', { exact: true }).fill('MANPART');
  await actor.page.getByLabel('거래처명 *', { exact: true }).fill('직접 거래처');
  await actor.page.getByLabel('입고수량 *', { exact: true }).fill('10');
  await actor.page.getByLabel('신규 입고단가 (KRW) *', { exact: true }).fill('200');
  await actor.page.getByRole('checkbox', { name: '입력한 거래처를 이 회사에 저장하고 재사용합니다.', exact: true }).check();
  const history = actor.page.getByRole('region', { name: '기존 입고단가 비교', exact: true });
  await expect(history.getByRole('cell', { name: /100 KRW/ })).toBeVisible({ timeout: 65000 });
  await actor.page.getByRole('button', { name: '검증·미리보기', exact: true }).click();
  const preview = actor.page.getByRole('region', { name: '입출고 미리보기', exact: true });
  await expect(preview.getByRole('cell', { name: '1,000 → 3,000', exact: true })).toBeVisible({ timeout: 65000 });
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 10, value: 1000 }]);
  await actor.page.getByLabel('신규 입고단가 (KRW) *', { exact: true }).fill('250'); await expect(preview).toHaveCount(0);
  await actor.page.getByLabel('신규 입고단가 (KRW) *', { exact: true }).fill('200');
  await actor.page.getByRole('button', { name: '검증·미리보기', exact: true }).click();
  await expect(preview.getByRole('cell', { name: '100 → 150', exact: true })).toBeVisible({ timeout: 65000 });
  await preview.getByRole('checkbox', { name: '수량·단가·거래처와 재고 변동을 확인했습니다.', exact: true }).check();
  await actor.page.screenshot({ path: testInfo.outputPath('erp-manual-inbound.png'), fullPage: true });
  expect(await actor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await preview.getByRole('button', { name: '입고 확정', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '입고 확정 완료', exact: true })).toBeVisible({ timeout: 65000 });
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 20, value: 3000 }]);
  await actor.page.getByRole('button', { name: '출고등록', exact: true }).click();
  await expect(actor.page.getByLabel('등록 품목 선택 *', { exact: true }).locator('option')).toHaveCount(2, { timeout: 65000 });
  await actor.page.getByLabel('등록 품목 선택 *', { exact: true }).selectOption({ label: '0001 · 합성 품목' });
  await actor.page.getByLabel('출고 창고 *', { exact: true }).selectOption('warehouse');
  await actor.page.getByLabel('거래일 *', { exact: true }).fill('2026-11-03');
  await actor.page.getByLabel('거래처 *', { exact: true }).selectOption({ label: 'MANPART · 직접 거래처' });
  await actor.page.getByLabel('단가기준 *', { exact: true }).selectOption('세금포함');
  await actor.page.getByLabel('출고수량 *', { exact: true }).fill('5');
  await actor.page.getByLabel('판매단가 (KRW) *', { exact: true }).fill('330');
  await actor.page.getByRole('button', { name: '검증·미리보기', exact: true }).click();
  await expect(preview.getByText('매출액 (공급가액)', { exact: true })).toBeVisible({ timeout: 65000 });
  await expect(preview.getByRole('cell', { name: '3,000 → 2,250', exact: true })).toBeVisible();
  await expect(preview.getByText('원화 매출액 1,500원 · 매출총이익 750원', { exact: true })).toBeVisible();
  await preview.getByRole('checkbox', { name: '수량·단가·거래처와 재고 변동을 확인했습니다.', exact: true }).check();
  await preview.getByRole('button', { name: '출고 확정', exact: true }).click();
  await expect(preview.getByRole('heading', { name: '출고 확정 완료', exact: true })).toBeVisible({ timeout: 65000 });
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 15, value: 2250 }]);
  await preview.getByRole('button', { name: '이 출고로 거래명세표 작성', exact: true }).click();
  await expect(actor.page.getByRole('heading', { name: '거래명세표 · 초안', exact: true })).toBeVisible({ timeout: 65000 });
  await expect(actor.page.getByLabel('확정 출고 문서번호 *', { exact: true })).toHaveValue(/^MAN-/);
  await actor.page.screenshot({ path: testInfo.outputPath('erp-manual-statement.png'), fullPage: true });
  expect(await actor.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await readErpInventory(fixtures.companyB)).toEqual(foreignBefore);
});

test('ERP warehouse transfers allocate to three warehouses, validate stock, commit and cancel without company-wide changes', async ({ browser }, testInfo) => {
  test.setTimeout(360000);
  await clearErpFixture(fixtures.companyA);
  const foreignBefore = await readErpInventory(fixtures.companyB);
  const owner = await actorFor(browser, testInfo); await login(owner, fixtures.accounts.adminA);
  async function erpCall(name, data) {
    const response = await probe(owner, `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/${name}`, { method: 'POST', body: { data: { companyId: fixtures.companyA, ...data } } });
    expect(response.status, `Synthetic ${name} request failed`).toBe(200);
    return JSON.parse(Buffer.from(response.bytes).toString('utf8')).result;
  }
  for (const [id, code, name] of [['opening', 'WH-01', '기초재고 통합'], ['head', 'HEAD', '본사'], ['lab', 'LAB', '연구소'], ['pack', 'PACK', '상품구성']]) {
    await erpCall('manageErp', { action: 'save', kind: 'warehouses', id, expectedRevision: 0, values: { code, name, active: true, address: '', notes: '' } });
  }
  const source = await erpWorkbook('OPENING', [erpOpening({ 9: '기초재고 통합' })]);
  const pending = await erpCall('manageErpImport', { action: 'preview', id: randomUUID(), type: 'OPENING', source, options: { allowNewItems: true, allowNewPartners: false } });
  expect(pending.import.preview.canCommit).toBe(true);
  await erpCall('manageErpImport', { action: 'commit', id: pending.import.id, fingerprint: pending.import.preview.fingerprint });
  await owner.page.goto('/#/erp'); await owner.page.getByRole('button', { name: '창고 이동', exact: true }).click();
  const panel = owner.page.getByRole('region', { name: '창고 간 재고 이동', exact: true });
  await expect(panel.getByRole('combobox', { name: '출발 창고', exact: true }).locator('option')).toHaveCount(5, { timeout: 65000 });
  await panel.getByRole('combobox', { name: '출발 창고', exact: true }).selectOption('opening');
  for (const name of ['본사', '연구소', '상품구성']) await panel.getByRole('checkbox', { name, exact: true }).check();
  await panel.getByLabel('이동일', { exact: true }).fill('2026-11-02');
  await panel.getByLabel('이동 사유', { exact: true }).fill('합성 기초재고 창고별 배분');
  await panel.getByRole('button', { name: '출발 재고 불러오기', exact: true }).click();
  const head = panel.getByRole('textbox', { name: '0001 본사 이동수량', exact: true });
  await expect(head).toBeVisible({ timeout: 65000 }); await head.fill('11');
  const previewButton = panel.getByRole('button', { name: '창고 이동 미리보기', exact: true });
  await expect(previewButton).toBeDisabled(); await expect(panel.getByText('현재고 초과', { exact: true })).toBeVisible();
  await head.fill('4'); await panel.getByRole('textbox', { name: '0001 연구소 이동수량', exact: true }).fill('3');
  await panel.getByRole('textbox', { name: '0001 상품구성 이동수량', exact: true }).fill('2');
  await previewButton.click(); await expect(panel.getByRole('heading', { name: '이동 전후 재고 · 3개 배분', exact: true })).toBeVisible({ timeout: 65000 });
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{ quantity: 10, value: 1000 }]);
  const commit = panel.getByRole('button', { name: '창고 이동 확정', exact: true }); await expect(commit).toBeDisabled();
  await panel.getByRole('checkbox', { name: '출발·도착 창고와 전체 이동 수량·금액을 확인했습니다.', exact: true }).check();
  // Editing invalidates the preview and requires review again.
  await head.fill('5'); await expect(commit).toHaveCount(0); await previewButton.click();
  await expect(panel.getByRole('heading', { name: '이동 전후 재고 · 3개 배분', exact: true })).toBeVisible({ timeout: 65000 });
  await panel.getByRole('checkbox', { name: '출발·도착 창고와 전체 이동 수량·금액을 확인했습니다.', exact: true }).check();
  await commit.click(); await expect(panel.getByRole('status').filter({ hasText: '창고 이동 완료' })).toBeVisible({ timeout: 65000 });
  const stock = await readErpInventory(fixtures.companyA);
  expect(stock.balances.map(row => row.quantity).sort((a,b) => a-b)).toEqual([0,2,3,5]);
  expect(stock.balances.reduce((sum,row) => sum+row.value,0)).toBe(1000);
  await owner.page.screenshot({ path: testInfo.outputPath('erp-warehouse-transfer.png'), fullPage: true });
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await owner.page.getByRole('button', { name: '입출고 총괄·원장', exact: true }).click();
  await expect(owner.page.getByText(/기초재고 마감일 2026-11-01/)).toBeVisible({ timeout: 65000 });
  await owner.page.getByLabel('조회 시작일', { exact: true }).fill('2026-11-02'); await owner.page.getByLabel('조회 종료일', { exact: true }).fill('2026-11-30');
  await owner.page.getByRole('button', { name: '원장 조회', exact: true }).click();
  const summary = owner.page.getByRole('region', { name: '입출고 총괄 결과', exact: true });
  await expect(summary.getByRole('columnheader', { name: '이동입고수량', exact: true })).toBeVisible({ timeout: 65000 });
  await owner.page.getByRole('button', { name: '상세 원장', exact: true }).click(); await owner.page.getByRole('button', { name: '원장 조회', exact: true }).click();
  const detail = owner.page.getByRole('region', { name: '품목별 상세 원장 결과', exact: true });
  await detail.getByRole('button', { name: /행 문서 취소$/ }).first().click();
  const form = owner.page.getByRole('region', { name: '취소 반품 조정 처리', exact: true });
  await form.getByLabel('처리일', { exact: true }).fill('2026-11-03'); await form.getByLabel('처리 사유', { exact: true }).fill('합성 창고 배분 취소');
  await form.getByRole('button', { name: '변동 미리보기', exact: true }).click();
  await expect(form.getByRole('heading', { name: '변동 미리보기 · 6행', exact: true })).toBeVisible({ timeout: 65000 });
  await form.getByRole('checkbox', { name: '사유와 전체 변동 내역을 확인했습니다.', exact: true }).check();
  await form.getByRole('button', { name: '취소·반품·조정 확정', exact: true }).click();
  await expect(form.getByRole('status').filter({ hasText: '처리 완료' })).toBeVisible({ timeout: 65000 });
  expect((await readErpInventory(fixtures.companyA)).balances.map(row => row.quantity).sort((a,b) => a-b)).toEqual([0,0,0,10]);
  const member = await actorFor(browser, testInfo); await login(member, fixtures.accounts.memberA); await member.page.goto('/#/erp');
  await expect(member.page.getByRole('button', { name: '창고 이동', exact: true })).toHaveCount(0);
  expect(await readErpInventory(fixtures.companyB)).toEqual(foreignBefore);
});

test('ERP period reports, returns, count/value adjustments and immutable cancellation reconcile with Excel', async ({ browser }, testInfo) => {
  test.setTimeout(360000);
  await clearErpFixture(fixtures.companyA);
  const foreignBefore = await readErpInventory(fixtures.companyB);
  const owner = await actorFor(browser,testInfo); await login(owner,fixtures.accounts.adminA);
  async function erpCall(name,data) {
    const response = await probe(owner,`http://${HOSTS.functions}/${PROJECT_ID}/us-central1/${name}`,{method:'POST',body:{data:{companyId:fixtures.companyA,...data}}});
    expect(response.status,`Synthetic ${name} request failed`).toBe(200); return JSON.parse(Buffer.from(response.bytes).toString('utf8')).result;
  }
  await erpCall('manageErp',{action:'save',kind:'warehouses',id:'report-warehouse',expectedRevision:0,values:{code:'WH-01',name:'본사 창고',active:true,address:'',notes:''}});
  for (const [type,rows] of [['OPENING',[erpOpening()]],['MOVEMENTS',[erpMovement(),erpMovement({1:2,2:'출고',3:'OUT-001',11:5,12:300})]]]) {
    const source=await erpWorkbook(type,rows),p=await erpCall('manageErpImport',{action:'preview',id:randomUUID(),type,source,options:{allowNewItems:true,allowNewPartners:true}});
    expect(p.import.preview.canCommit).toBe(true);await erpCall('manageErpImport',{action:'commit',id:p.import.id,fingerprint:p.import.preview.fingerprint});
  }
  await owner.page.goto('/#/erp');await owner.page.getByRole('button',{name:'입출고 총괄·원장',exact:true}).click();
  await expect(owner.page.getByText(/기초재고 마감일 2026-11-01/)).toBeVisible({timeout:65000});
  await owner.page.getByLabel('조회 시작일',{exact:true}).fill('2026-11-02');await owner.page.getByLabel('조회 종료일',{exact:true}).fill('2026-11-30');
  await owner.page.getByRole('button',{name:'원장 조회',exact:true}).click();
  const summary=owner.page.getByRole('region',{name:'입출고 총괄 결과',exact:true});await expect(summary.getByRole('cell',{name:'2,250',exact:true})).toBeVisible({timeout:65000});
  await summary.getByRole('button',{name:/상세 원장$/}).click();
  const detail=owner.page.getByRole('region',{name:'품목별 상세 원장 결과',exact:true});
  const form=owner.page.getByRole('region',{name:'취소 반품 조정 처리',exact:true});
  async function confirm(date,quantity,value) {
    await form.getByLabel('처리일',{exact:true}).fill(date);await form.getByLabel('처리 사유',{exact:true}).fill('자동 점검 실물 대사');
    if(quantity!==undefined)await form.getByRole('textbox',{name:/반품 수량|실사 후 총수량/}).fill(quantity);
    if(value!==undefined)await form.getByRole('textbox',{name:/조정 후 총 장부금액|수량 증가분 재고금액/}).fill(value);
    await form.getByRole('button',{name:'변동 미리보기',exact:true}).click();
    await expect(form.getByRole('heading',{name:/변동 미리보기 ·/})).toBeVisible({timeout:65000});
    const button=form.getByRole('button',{name:'취소·반품·조정 확정',exact:true});await expect(button).toBeDisabled();
    await form.getByRole('checkbox',{name:'사유와 전체 변동 내역을 확인했습니다.',exact:true}).check();await button.click();
    await expect(form.getByRole('status').filter({hasText:'처리 완료'})).toBeVisible({timeout:65000});
    await expect(form.getByRole('button',{name:'처리 닫기',exact:true})).toBeEnabled();await form.getByRole('button',{name:'처리 닫기',exact:true}).click();
  }
  await detail.getByRole('button',{name:'OUT-001 1행 반품',exact:true}).click();await confirm('2026-11-03','2');
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{quantity:17,value:2550}]);
  await detail.getByRole('row').filter({hasText:'입고'}).getByRole('button',{name:/행 반품$/}).click();await confirm('2026-11-04','3');
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{quantity:14,value:2100}]);
  await owner.page.getByRole('button',{name:'재고 조정',exact:true}).click();
  await form.getByRole('combobox',{name:'조정 품목',exact:true}).selectOption({index:1});await form.getByRole('combobox',{name:'조정 창고',exact:true}).selectOption('report-warehouse');
  await confirm('2026-11-05','12');expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{quantity:12,value:1800}]);
  await detail.getByRole('row').filter({hasText:'실사조정'}).getByRole('button',{name:/문서 취소$/}).click();await confirm('2026-11-06');
  expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{quantity:14,value:2100}]);
  await owner.page.getByRole('button',{name:'재고 조정',exact:true}).click();
  await form.getByRole('combobox',{name:'조정 방식',exact:true}).selectOption('VALUE');
  await form.getByRole('combobox',{name:'조정 품목',exact:true}).selectOption({index:1});await form.getByRole('combobox',{name:'조정 창고',exact:true}).selectOption('report-warehouse');
  await confirm('2026-11-07',undefined,'2000');expect((await readErpInventory(fixtures.companyA)).balances).toEqual([{quantity:14,value:2000}]);
  await owner.page.getByRole('button',{name:'입출고 총괄',exact:true}).click();await owner.page.getByRole('button',{name:'원장 조회',exact:true}).click();
  await expect(summary.getByRole('cell',{name:'2,000',exact:true})).toBeVisible({timeout:65000});await expect(summary.getByRole('cell',{name:'450',exact:true})).toHaveCount(2);
  const download=owner.page.waitForEvent('download');await summary.getByRole('button',{name:'전체 Excel 내려받기',exact:true}).click();const file=await download;
  expect(file.suggestedFilename()).toBe('입출고총괄_2026-11-02_2026-11-30.xlsx');const stream=await file.createReadStream(),chunks=[];for await(const chunk of stream)chunks.push(chunk);
  const readExcel=require('read-excel-file/node').default,workbook=await readExcel(Buffer.concat(chunks));
  expect(workbook[0].data[1][12]).toBe(14);expect(workbook[0].data[1][20]).toBe(2000);expect(workbook[0].data[1][23]).toBe(450);
  await summary.locator('.erp-table-scroll').scrollIntoViewIfNeeded();await owner.page.screenshot({path:testInfo.outputPath('erp-period-report.png'),fullPage:true});
  expect(await owner.page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  const member=await actorFor(browser,testInfo);await login(member,fixtures.accounts.memberA);await member.page.goto('/#/erp');await member.page.getByRole('button',{name:'입출고 총괄·원장',exact:true}).click();
  await expect(member.page.getByText(/수량 조회 전용/)).toBeVisible();await member.page.getByLabel('조회 시작일',{exact:true}).fill('2026-11-02');await member.page.getByLabel('조회 종료일',{exact:true}).fill('2026-11-30');await member.page.getByRole('button',{name:'원장 조회',exact:true}).click();
  const memberSummary=member.page.getByRole('region',{name:'입출고 총괄 결과',exact:true});await expect(memberSummary.getByRole('cell',{name:'14',exact:true})).toBeVisible();await expect(member.page.getByRole('button',{name:'재고 조정',exact:true})).toHaveCount(0);
  await expect(memberSummary.getByRole('columnheader',{name:'기말금액',exact:true})).toHaveCount(0);
  const memberDownload=member.page.waitForEvent('download');await memberSummary.getByRole('button',{name:'전체 Excel 내려받기',exact:true}).click();const memberFile=await memberDownload,memberStream=await memberFile.createReadStream(),memberChunks=[];for await(const chunk of memberStream)memberChunks.push(chunk);
  const memberWorkbook=await readExcel(Buffer.concat(memberChunks));expect(memberWorkbook[0].data[0]).toHaveLength(13);expect(JSON.stringify(memberWorkbook)).not.toContain('2000');
  expect(await readErpInventory(fixtures.companyB)).toEqual(foreignBefore);
});

test('ERP trade documents issue three PDFs with the registered seal and immutable revisions without changing stock', async ({ browser }, testInfo) => {
  test.setTimeout(420000);
  await clearErpFixture(fixtures.companyA);
  const foreignBefore = await readErpInventory(fixtures.companyB), owner = await actorFor(browser, testInfo);
  await login(owner, fixtures.accounts.adminA);
  async function erpCall(name, data) {
    const response = await probe(owner, `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/${name}`, { method: 'POST', body: { data: { companyId: fixtures.companyA, ...data } } });
    expect(response.status, `Synthetic ${name} ${data.action} request failed`).toBe(200); return JSON.parse(Buffer.from(response.bytes).toString('utf8')).result;
  }
  const docs = (action, data = {}) => erpCall('manageErpDocuments', { action, ...data });
  await erpCall('manageErp', { action: 'save', kind: 'warehouses', id: 'document-warehouse', expectedRevision: 0, values: { code: 'WH-01', name: '본사 창고', active: true, address: '', notes: '' } });
  for (const [type, rows] of [['OPENING', [erpOpening()]], ['MOVEMENTS', [erpMovement({ 2: '출고', 3: 'OUT-001', 11: 5, 12: 300 })]]]) {
    const source = await erpWorkbook(type, rows), preview = await erpCall('manageErpImport', { action: 'preview', id: randomUUID(), type, source, options: { allowNewItems: true, allowNewPartners: true } });
    expect(preview.import.preview.canCommit).toBe(true); await erpCall('manageErpImport', { action: 'commit', id: preview.import.id, fingerprint: preview.import.preview.fingerprint });
  }
  const official = await erpCall('manageOfficialLetters', { action: 'bootstrap' });
  const stamp = require('../../functions/tests/erp-document-pdf-fixtures.cjs').sealPng();
  const template = { companyName: 'PDF 검증 회사', companyNameEn: 'PDF Sample Company', address: '서울 검증로 10', representative: '김검증', phone: '02-000-0000', email: 'sample@example.invalid', logoData: `data:image/png;base64,${stamp.toString('base64')}`, sealData: `data:image/png;base64,${stamp.toString('base64')}`, sealWidthMm: 28, sealHeightMm: 18 };
  await erpCall('manageOfficialLetters', { action: 'saveSettings', expectedVersion: official.settings?.version || 0, settings: template });
  const stockBefore = await readErpInventory(fixtures.companyA);
  await owner.page.goto('/#/erp'); await owner.page.getByRole('button', { name: '거래서류 발행', exact: true }).click();
  await expect(owner.page.locator('.erp-documents')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  await owner.page.locator('.erp-print-profile summary').click();
  await owner.page.getByLabel('영문 회사명', { exact: true }).fill('PDF Sample Company');
  await owner.page.getByLabel('영문 회사 주소', { exact: true }).fill('10 Sample Road, Seoul, Korea');
  await owner.page.getByLabel('영문 대표자', { exact: true }).fill('Sample Kim');
  await owner.page.getByLabel('공급자 사업자등록번호', { exact: true }).fill('000-00-00000');
  await owner.page.getByRole('button', { name: '출력 설정 저장', exact: true }).click();
  await expect(owner.page.getByRole('status').filter({ hasText: '공급자 출력 설정을 저장했습니다.' })).toBeVisible({ timeout: 65000 });
  async function downloadPdf(buttonName, artifact) {
    const pending = owner.page.waitForEvent('download'); await owner.page.getByRole('button', { name: buttonName, exact: true }).click(); const file = await pending;
    const stream = await file.createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk); const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-'); expect(bytes.length).toBeGreaterThan(10000);
    if (artifact) await file.saveAs(testInfo.outputPath(artifact));
    await expect(owner.page.locator('.erp-documents')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
    return bytes;
  }
  async function confirm(expectedTotal) {
    await owner.page.getByRole('button', { name: '초안 저장·금액 확인', exact: true }).click();
    await expect(owner.page.getByRole('heading', { name: '발행 내용 확인', exact: true })).toBeVisible({ timeout: 65000 });
    await expect(owner.page.locator('.erp-document-total')).toHaveText(`합계 ${expectedTotal} KRW`);
    const issue = owner.page.getByRole('button', { name: '발행 확정', exact: true }); await expect(issue).toBeDisabled();
    await owner.page.getByRole('checkbox', { name: '거래처·금액·등록 인감을 확인했습니다.', exact: true }).check(); await issue.click();
    await expect(owner.page.getByRole('status').filter({ hasText: '발행이 완료되었습니다.' })).toBeVisible({ timeout: 65000 });
  }
  await owner.page.getByRole('button', { name: '영문 Proforma Invoice 작성', exact: true }).click();
  await owner.page.getByRole('combobox', { name: '거래처 *', exact: true }).selectOption({ index: 1 });
  await owner.page.getByLabel('Buyer name (영문) *', { exact: true }).fill('Sample Buyer Ltd.');
  await owner.page.getByLabel('Buyer address (영문) *', { exact: true }).fill('20 Buyer Road, London');
  await owner.page.getByRole('button', { name: '견적 품목 추가', exact: true }).click();
  await owner.page.getByRole('combobox', { name: '품목 선택 *', exact: true }).selectOption({ index: 1 });
  await owner.page.getByLabel('영문 품목명 *', { exact: true }).fill('Sample monitor');
  await owner.page.getByLabel('수량 *', { exact: true }).fill('2'); await owner.page.getByLabel('단가 *', { exact: true }).fill('100');
  await owner.page.getByRole('button', { name: '초안 저장·금액 확인', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '발행 내용 확인', exact: true })).toBeVisible({ timeout: 65000 });
  await downloadPdf('초안 PDF 미리보기', 'erp-proforma-draft.pdf');
  await owner.page.getByRole('checkbox', { name: '거래처·금액·등록 인감을 확인했습니다.', exact: true }).check(); await owner.page.getByRole('button', { name: '발행 확정', exact: true }).click();
  await expect(owner.page.locator('.erp-documents')).toHaveAttribute('aria-busy', 'false', { timeout: 65000 });
  const initialIssue = (await docs('list')).documents.find(doc => doc.kind === 'PROFORMA');
  if (initialIssue && !initialIssue.pdfReady) {
    const retry = await probe(owner, `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/manageErpDocuments`, { method: 'POST', body: { data: { companyId: fixtures.companyA, action: 'pdf', id: initialIssue.id } } });
    const error = JSON.parse(Buffer.from(retry.bytes).toString('utf8')).error;
    expect(retry.status, `Synthetic PDF creation: ${error?.status || ''} ${error?.message || ''}`).toBe(200);
  }
  await expect(owner.page.getByRole('status').filter({ hasText: '발행이 완료되었습니다.' })).toBeVisible({ timeout: 65000 });
  const proformaBytes = await downloadPdf('발행 PDF 내려받기', 'erp-proforma.pdf');
  const proforma = (await docs('list')).documents.find(doc => doc.kind === 'PROFORMA'); expect(proforma.totalMinor).toBe(220);
  let invoice, invoiceBytes;
  for (const [kind, label, amount] of [['INVOICE', '한글 Invoice', '1,650'], ['STATEMENT', '거래명세표', '1,650']]) {
    await owner.page.getByRole('button', { name: `${label} 작성`, exact: true }).click();
    await owner.page.getByLabel('확정 출고 문서번호 *', { exact: true }).fill('OUT-001');
    await owner.page.getByRole('button', { name: '출고 불러오기', exact: true }).click();
    await expect(owner.page.getByText(/발행 가능 5 EA/)).toBeVisible({ timeout: 65000 });
    await confirm(amount); const bytes = await downloadPdf('발행 PDF 내려받기', `erp-${kind.toLowerCase()}.pdf`);
    if (kind === 'INVOICE') { invoice = (await docs('list')).documents.find(doc => doc.kind === kind); invoiceBytes = bytes; }
    else expect(/\/Count 2\b/.test(bytes.toString('latin1'))).toBe(true);
  }
  const setting = await erpCall('manageOfficialLetters', { action: 'bootstrap' });
  const replacementSeal = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  await erpCall('manageOfficialLetters', { action: 'saveSettings', expectedVersion: setting.settings.version, settings: { ...template, companyName: '변경 후 회사명', sealData: replacementSeal, sealWidthMm: 20, sealHeightMm: 20 } });
  expect(Buffer.from((await docs('pdf', { id: proforma.id })).base64, 'base64').equals(proformaBytes)).toBe(true);
  await owner.page.getByRole('button', { name: `${invoice.number} 열기`, exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '한글 Invoice · 발행', exact: true })).toBeVisible();
  await owner.page.getByLabel('문서 취소 사유', { exact: true }).fill('거래 조건 정정');
  await owner.page.getByRole('checkbox', { name: '문서만 취소하고 재고는 유지함을 확인했습니다.', exact: true }).check();
  await owner.page.getByRole('button', { name: '발행 문서 취소', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '한글 Invoice · 취소', exact: true })).toBeVisible({ timeout: 65000 });
  expect((await downloadPdf('취소된 원본 PDF 내려받기')).equals(invoiceBytes)).toBe(true);
  await owner.page.getByRole('button', { name: '정정 초안 만들기', exact: true }).click();
  await expect(owner.page.getByRole('heading', { name: '한글 Invoice · 초안', exact: true })).toBeVisible({ timeout: 65000 });
  await owner.page.getByLabel('문서 비고', { exact: true }).fill('거래 조건을 정정한 새 발행본'); await confirm('1,650');
  const revised = (await docs('list')).documents.find(doc => doc.replacesId === invoice.id); expect(revised.number).not.toBe(invoice.number);
  expect((await docs('get', { id: revised.id })).document.preview.branding.companyName).toBe('변경 후 회사명');
  await owner.page.getByRole('region', { name: '거래서류 목록', exact: true }).scrollIntoViewIfNeeded();
  await owner.page.screenshot({ path: testInfo.outputPath('erp-documents.png'), fullPage: true });
  expect(await owner.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await readErpInventory(fixtures.companyA)).toEqual(stockBefore); expect(await readErpInventory(fixtures.companyB)).toEqual(foreignBefore);
  const member = await actorFor(browser, testInfo); await login(member, fixtures.accounts.memberA); await member.page.goto('/#/erp');
  await expect(member.page.getByRole('button', { name: '거래서류 발행', exact: true })).toHaveCount(0);
  const denied = await probe(member, `http://${HOSTS.functions}/${PROJECT_ID}/us-central1/manageErpDocuments`, { method: 'POST', body: { data: { action: 'pdf', companyId: fixtures.companyA, id: proforma.id } } }); expect(denied.status).toBe(403);
});

test('real expense UI uploads PNG/PDF and downloads the original bytes and filename', async ({ browser }, testInfo) => {
  const actor = await actorFor(browser, testInfo);
  await login(actor, fixtures.accounts.memberA);
  for (const file of files) {
    const record = await createExpense(actor, file, file.mimeType === 'image/png' ? '이미지' : 'PDF');
    expect(record.companyId).toBe(fixtures.companyA);
    expect(record.userId).toBe(fixtures.accounts.memberA.uid);
    await downloadExpense(actor, record, file);
  }
});

test('required and manual password changes keep business gates, logout and new-password login', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  for (const key of ['requiredA', 'passwordA']) {
    const account = fixtures.accounts[key];
    const actor = await actorFor(browser, testInfo);
    await login(actor, account, { passwordRequired: key === 'requiredA' });
    if (key === 'passwordA') await actor.page.getByRole('button', { name: '보안 설정', exact: true }).click();
    const dialog = actor.page.getByRole('dialog', { name: '비밀번호 변경', exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveCSS('font-family', /SUIT Variable/);
    if (key === 'requiredA') {
      await expect(dialog.getByLabel('현재 비밀번호', { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole('button', { name: '비밀번호 변경 닫기', exact: true })).toHaveCount(0);
      await actor.page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
    }
    const nextPassword = randomUUID().replaceAll('-', '').slice(0, key === 'requiredA' ? 6 : 15);
    try {
      if (key === 'passwordA') await dialog.getByLabel('현재 비밀번호', { exact: true }).fill(account.password);
      await dialog.getByLabel('새 비밀번호', { exact: true }).fill(nextPassword);
      await dialog.getByLabel('새 비밀번호 확인', { exact: true }).fill(nextPassword);
    } catch { throw new Error('Could not fill the isolated password-change form.'); }
    actor.passwordChangeAlert = true;
    await dialog.getByRole('button', { name: '비밀번호 변경 후 다시 로그인', exact: true }).click();
    // Required-password routing can remount HashRouter. Check the signed-out
    // form and absence of the private shell before explicitly reopening login.
    await expect(actor.page.getByPlaceholder('admin@yourcompany.com')).toBeVisible({ timeout: 65000 });
    await expect(actor.page.locator('.workspace-shell')).toHaveCount(0);
    await expect.poll(() => actor.passwordChangeNotices).toBe(1);
    const profile = await readProfile(account);
    expect(profile.mustChangePassword).toBe(false);
    expect(profile.companyId).toBe(account.companyId);
    expect(profile.role).toBe(account.role);
    // The service intentionally delays signing in again for one second.
    await actor.page.waitForTimeout(1200);
    await login(actor, account, { invalidPassword: true });
    await login(actor, { ...account, password: nextPassword });
    actor.token = '';
    await actor.context.close();
  }
});

test('company, document and path tampering cannot cross tenant or division boundaries', async ({ browser }, testInfo) => {
  const owner = await actorFor(browser, testInfo);
  await login(owner, fixtures.accounts.memberA);
  const ownRecord = await createExpense(owner, files[0], 'A 격리');
  const other = await actorFor(browser, testInfo);
  await login(other, fixtures.accounts.memberB);
  const foreignRecord = await createExpense(other, files[1], 'B 격리');
  const granted = await probe(owner, attachmentUrl(ownRecord.id));
  expect(granted.status).toBe(200);
  expect(granted.cacheControl).toContain('no-store');
  expect(Buffer.from(granted.bytes).equals(files[0].buffer)).toBe(true);
  expect((await probe(owner, attachmentUrl(foreignRecord.id))).status).toBe(403);
  expect((await probe(other, attachmentUrl(ownRecord.id))).status).toBe(403);
  expect((await probe(owner, attachmentUrl(foreignRecord.id, { companyId: fixtures.companyB, path: foreignRecord.attachmentPath }))).status).toBe(403);
  const ignoredInjection = await probe(owner, attachmentUrl(ownRecord.id, { companyId: fixtures.companyB, path: foreignRecord.attachmentPath }));
  expect(ignoredInjection.status).toBe(200);
  expect(Buffer.from(ignoredInjection.bytes).equals(files[0].buffer)).toBe(true);
  expect((await probe(owner, attachmentUrl(ownRecord.id), { anonymous: true })).status).toBe(401);
  expect((await probe(owner, firestoreUrl(foreignRecord.id))).status).toBe(403);
  const foreignCompany = forgedExpense(fixtures.accounts.memberA, { companyId: fixtures.companyB });
  expect((await probe(owner, `${firestoreUrl(`e2e-denied-${randomUUID()}`)}?currentDocument.exists=false`, { method: 'PATCH', body: foreignCompany })).status).toBe(403);
  const foreignPath = forgedExpense(fixtures.accounts.memberA, { attachmentPath: foreignRecord.attachmentPath, attachmentName: files[1].name });
  expect((await probe(owner, `${firestoreUrl(`e2e-denied-${randomUUID()}`)}?currentDocument.exists=false`, { method: 'PATCH', body: foreignPath })).status).toBe(403);
  const wrongOwnerPath = forgedExpense(fixtures.accounts.memberA, {
    attachmentPath: `companies/${fixtures.companyA}/expenses/${fixtures.accounts.managerA.uid}/${randomUUID()}.png`, attachmentName: files[0].name,
  });
  expect((await probe(owner, `${firestoreUrl(`e2e-denied-${randomUUID()}`)}?currentDocument.exists=false`, { method: 'PATCH', body: wrongOwnerPath })).status).toBe(403);
  const wrongCategoryPath = forgedExpense(fixtures.accounts.memberA, {
    attachmentPath: `companies/${fixtures.companyA}/notices/${fixtures.accounts.memberA.uid}/${randomUUID()}.png`, attachmentName: files[0].name,
  });
  expect((await probe(owner, `${firestoreUrl(`e2e-denied-${randomUUID()}`)}?currentDocument.exists=false`, { method: 'PATCH', body: wrongCategoryPath })).status).toBe(403);
  const updateMask = new URLSearchParams({ 'currentDocument.exists': 'true' });
  updateMask.append('updateMask.fieldPaths', 'attachmentPath');
  updateMask.append('updateMask.fieldPaths', 'attachmentName');
  const changedPath = { fields: { attachmentPath: { stringValue: foreignRecord.attachmentPath }, attachmentName: { stringValue: files[1].name } } };
  expect((await probe(owner, `${firestoreUrl(ownRecord.id)}?${updateMask}`, { method: 'PATCH', body: changedPath })).status).toBe(403);
  const manager = await actorFor(browser, testInfo);
  await login(manager, fixtures.accounts.managerA);
  expect((await probe(manager, attachmentUrl(ownRecord.id))).status).toBe(200);
  const wrongDivision = await actorFor(browser, testInfo);
  await login(wrongDivision, fixtures.accounts.otherManagerA);
  expect((await probe(wrongDivision, attachmentUrl(ownRecord.id))).status).toBe(403);
  expect((await probe(wrongDivision, firestoreUrl(ownRecord.id))).status).toBe(403);
});

test('real payroll UI confirms full-company saved wages and downloads immutable monthly and annual PDFs with tenant isolation', async ({ browser }, testInfo) => {
  test.setTimeout(240000);
  const admin = await actorFor(browser, testInfo);
  await login(admin, fixtures.accounts.adminA);
  await admin.page.goto('/#/admin/salary');
  await expect(admin.page.getByRole('heading', { name: '급여관리', exact: true })).toBeVisible();
  const year = 2026, month = testInfo.project.use.isMobile ? 11 : 10;
  const yearSelector = admin.page.getByRole('combobox', { name: '급여 대상 연도', exact: true });
  if (await yearSelector.inputValue() !== String(year)) await yearSelector.selectOption(String(year));
  await admin.page.getByRole('combobox', { name: '급여 대상 월', exact: true }).selectOption(String(month));
  await expect(admin.page.locator('.pyre-screen')).toHaveCSS('font-family', /SUIT Variable/);
  await expect(admin.page.getByRole('button', { name: '포함', exact: true })).toHaveCount(0);
  await expect(admin.page.getByRole('button', { name: '별도', exact: true })).toHaveCount(0);
  await expect(admin.page.getByRole('button', { name: /메일.*발송/ })).toHaveCount(0);
  const eligible = Object.values(fixtures.accounts).filter(account => account.companyId === fixtures.companyA && account.status !== 'RESIGNED');
  await expect(admin.page.locator('.pyre-employee')).toHaveCount(eligible.length);
  await admin.page.getByRole('searchbox', { name: '급여 대상 직원 검색', exact: true }).fill(fixtures.accounts.adminA.name);
  await expect(admin.page.locator('.pyre-employee')).toHaveCount(1);
  await expect(admin.page.locator('.pyre-summary h2')).toContainText('1명');

  // Exercise the real profile transaction before approving: unsaved input may
  // affect the visible estimate but cannot silently enter an approved snapshot.
  const card = admin.page.locator('.pyre-employee');
  await card.getByRole('textbox', { name: `${fixtures.accounts.adminA.name} 연봉`, exact: true }).fill('25,200,000');
  await expect(admin.page.getByRole('button', { name: '회사 전체 급여 확정', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: '설정 저장', exact: true }).click();
  await expect.poll(async () => (await readProfile(fixtures.accounts.adminA)).annualSalary).toBe(25200000);
  await expect.poll(async () => (await readProfile(fixtures.accounts.adminA)).isSeveranceIncluded).toBe(false);
  await expect(card.getByRole('button', { name: '설정 저장', exact: true })).toBeDisabled();
  await expect(admin.page.locator('.pyre-summary')).toContainText('2,100,000원');
  await expect(admin.page.locator('.pyre-report-actions')).toContainText(`회사 전체 직원 ${eligible.length}명`);

  const preview = callableResult(await payrollProbe(admin, { action: 'preview', year, month }));
  expect(preview.employeeCount).toBe(eligible.length);
  expect(preview.totalGross).toBe(eligible.length * 2000000 + 100000);
  expect(preview.zeroCount).toBe(0);
  expect(preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const won = value => `${value.toLocaleString('ko-KR')}원`;
  const taxName = preview.taxTable.source === 'uploaded' ? '관리자 등록 세액표' : '2026.03 공식 기본 세액표';
  admin.expectedPayrollConfirmation = `${year}년 ${month}월 회사 전체 ${preview.employeeCount}명의 급여를 확정합니다.\n\n총 지급액: ${won(preview.totalGross)}\n총 공제액: ${won(preview.totalDeductions)}\n실지급액: ${won(preview.totalNet)}\n급여 0원: ${preview.zeroCount}명\n계산 기준: ${taxName}\n\n검색·본부·팀 필터와 관계없이 저장된 전체 직원 설정으로 확정되며 승인 후에는 정정·재승인 절차로만 변경할 수 있습니다. 계속하시겠습니까?`;
  admin.payrollRequests = [];
  await admin.page.getByRole('button', { name: '회사 전체 급여 확정', exact: true }).click();
  await expect(admin.page.getByRole('button', { name: '확정 완료', exact: true })).toBeDisabled({ timeout: 65000 });
  expect(admin.payrollConfirmations).toBe(1);
  expect(admin.expectedPayrollConfirmation).toBe(null);
  const approvalCalls = admin.payrollRequests.filter(input => input.action === 'approve');
  expect(admin.payrollRequests.some(input => input.action === 'preview' && input.year === year && input.month === month)).toBe(true);
  expect(approvalCalls).toEqual([{ action: 'approve', year, month, expectedFingerprint: preview.fingerprint }]);
  const record = await readPayrollRecord(fixtures.companyA, year, month);
  expect(record.schemaVersion).toBe(2);
  expect(record.rows.length).toBe(eligible.length);
  expect(record.sums.monthlyGross).toBe(preview.totalGross);
  expect(record.sums.netPay).toBe(preview.totalNet);
  expect(record.rows.every(row => row.companyId === fixtures.companyA)).toBe(true);

  const monthly = await payrollDownload(admin, admin.page.getByRole('button', { name: '월별 급여대장 PDF', exact: true }));
  await admin.page.getByRole('combobox', { name: '연간 급여명세서 직원 선택', exact: true }).selectOption(fixtures.accounts.adminA.uid);
  const annual = await payrollDownload(admin, admin.page.getByRole('button', { name: '연간 급여명세서 PDF', exact: true }));
  expect(monthly.equals(annual)).toBe(false);
  expect(admin.payrollRequests.some(input => input.action === 'monthlyPdf')).toBe(true);
  expect(admin.payrollRequests.some(input => input.action === 'annualPdf')).toBe(true);
  await admin.page.evaluate(() => document.fonts.ready);
  expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await admin.page.screenshot({ path: testInfo.outputPath(`payroll-${testInfo.project.use.viewport.width}px.png`), fullPage: true });

  await admin.page.getByRole('button', { name: '과거 승인 내역', exact: true }).click();
  const history = admin.page.getByRole('dialog', { name: '급여 지출 승인 이력', exact: true });
  await expect(history).toBeVisible();
  await history.getByLabel('급여 이력 시작월', { exact: true }).fill('2026-01');
  await history.getByLabel('급여 이력 종료월', { exact: true }).fill('2026-12');
  await expect(history.getByRole('button', { name: '조회', exact: true })).toBeEnabled();
  await history.getByRole('button', { name: '조회', exact: true }).click();
  await expect(history.getByRole('row').filter({ hasText: `${year}년 ${month}월` })).toContainText('회사 전체 확정');
  await expect(history.getByRole('button', { name: /삭제/ })).toHaveCount(0);
  expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await history.getByRole('button', { name: '급여 지출 승인 이력 닫기', exact: true }).click();

  const snapshotUrl = payrollFirestoreUrl(record.id);
  expect((await probe(admin, snapshotUrl, { method: 'DELETE' })).status).toBe(403);
  expect((await probe(admin, `${snapshotUrl}?updateMask.fieldPaths=totalGross`, {
    method: 'PATCH', body: { fields: { totalGross: { integerValue: '1' } } },
  })).status).toBe(403);
  expect((await payrollProbe(admin, { action: 'monthlyPdf', id: fixtures.foreignPayrollId })).status).toBe(403);
  expect((await payrollProbe(admin, { action: 'list', year, companyId: fixtures.companyB })).status).toBe(400);
  // Every export is authenticated as a live company ADMIN. A member of another
  // company, a first approver, and the platform operator cannot export payroll.
  for (const key of ['memberB', 'managerA', 'platform']) {
    const denied = await actorFor(browser, testInfo);
    await login(denied, fixtures.accounts[key]);
    for (const data of [{ action: 'list', year }, { action: 'preview', year, month },
      { action: 'approve', year, month, expectedFingerprint: preview.fingerprint },
      { action: 'monthlyPdf', id: record.id }, { action: 'annualPdf', year, employeeId: fixtures.accounts.adminA.uid }]) {
      expect((await payrollProbe(denied, data)).status).toBe(403);
    }
    expect((await payrollProbe(denied, { action: 'list', year, companyId: fixtures.companyA })).status).toBe(403);
    await denied.page.goto('/#/admin/salary');
    await expect(denied.page.getByRole('heading', { name: '급여관리', exact: true })).toHaveCount(0);
    denied.token = ''; await denied.context.close();
  }
});

test('historical source import, correction and reapproval preserve original files and prior financial versions', async ({ browser }, testInfo) => {
  test.setTimeout(300000);
  const admin = await actorFor(browser, testInfo);
  await login(admin, fixtures.accounts.adminA);
  const month = testInfo.project.use.isMobile ? 2 : 1, year = 2020;
  const name = '자동점검 과거, 관리자', archiveCode = `retired-${fixtures.runId}`;
  const sourceBytes = historicalCsv([
    { employeeLoginId: fixtures.accounts.adminA.email, name, employeeNumber: 'H-1', joinDate: '2019-01-01',
      divisionName: '이전 본부', teamName: '이전 팀', monthlyGross: 2500000, nonTaxable: 200000,
      pension: 109250, health: 82680, longTerm: 10860, employment: 20700,
      incomeTax: -66480, localTax: -6630, otherDeductions: 10000, totalDeductions: 160380, netPay: 2339620 },
    { archiveCode, name: '자동점검 삭제된 과거직원', employeeNumber: 'H-2', joinDate: '2018-01-01',
      monthlyGross: 1000000, nonTaxable: 0, pension: 0, health: 0, longTerm: 0, employment: 0,
      incomeTax: 0, localTax: 0, otherDeductions: 0, totalDeductions: 0, netPay: 1000000 },
  ]);
  const filename = '자동점검-과거급여.csv', sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  await admin.page.goto('/#/admin/salary');
  await admin.page.getByRole('button', { name: '과거 급여 등록·정정', exact: true }).click();
  const manager = admin.page.getByRole('dialog', { name: '과거 급여 등록·정정', exact: true });
  await expect(manager).toBeVisible();
  await manager.getByLabel('과거 급여 원본 귀속월', { exact: true }).fill(`${year}-${String(month).padStart(2, '0')}`);
  await manager.getByLabel('과거 급여 원본 파일', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/csv', buffer: sourceBytes });
  await manager.getByLabel('과거 급여 등록 사유', { exact: true }).fill('과거 실제 지급 자료 검토');
  await manager.getByRole('button', { name: '원본 검증·승인 대기 저장', exact: true }).click();
  await expect(manager.getByRole('heading', { name: `${year}년 ${month}월 과거 원본 검토`, exact: true })).toBeVisible({ timeout: 65000 });
  const pending = callableResult(await payrollProbe(admin, { action: 'listDrafts', year })).drafts.find(item => item.month === month && item.status === 'PENDING');
  expect(Boolean(pending?.id)).toBe(true);
  let draft = callableResult(await payrollProbe(admin, { action: 'getDraft', id: pending.id })).draft;
  expect(draft.rows.length).toBe(2);
  expect(draft.source.sha256).toBe(sourceHash);
  expect(draft.rows.find(row => row.userId === fixtures.accounts.adminA.uid).amounts.incomeTax).toBe(-66480);
  const archiveId = 'archive_' + createHash('sha256').update(JSON.stringify([fixtures.companyA, archiveCode])).digest('hex');
  expect(draft.rows.some(row => row.userId === archiveId)).toBe(true);
  expect(callableResult(await payrollProbe(admin, { action: 'list', year })).records.length).toBe(0);
  const originalDownload = await payrollSourceDownload(admin, manager.getByRole('button', { name: '등록 원본', exact: true }), filename);
  expect(originalDownload.equals(sourceBytes)).toBe(true);

  const reviewRow = manager.locator('.pymi-roster article').filter({ hasText: name });
  await reviewRow.getByRole('button', { name: '금액 수정', exact: true }).click();
  await reviewRow.getByLabel(`${name} 기타 공제`, { exact: true }).fill('20000');
  await manager.getByLabel('급여 검토·정정 사유', { exact: true }).fill('원본 기타 공제 검토 후 보정');
  await expect(manager.getByRole('button', { name: '검토 완료·승인 발행', exact: true })).toBeDisabled();
  await manager.getByRole('button', { name: '검토 내용 저장', exact: true }).click();
  await expect(manager.getByRole('button', { name: '검토 완료·승인 발행', exact: true })).toBeEnabled({ timeout: 65000 });
  draft = callableResult(await payrollProbe(admin, { action: 'getDraft', id: pending.id })).draft;
  expect(draft.draftVersion).toBe(2);
  expect(draft.sums.netPay).toBe(3329620);
  const versions = callableResult(await payrollProbe(admin, { action: 'listDraftVersions', id: draft.id })).versions;
  expect(versions.length).toBe(2);
  const firstDraft = callableResult(await payrollProbe(admin, { action: 'getDraftVersion', id: draft.id, draftVersion: 1 })).draft;
  expect(firstDraft.rows.find(row => row.userId === fixtures.accounts.adminA.uid).amounts.otherDeductions).toBe(10000);
  confirmHistoricalPayroll(admin, draft);
  await manager.getByRole('button', { name: '검토 완료·승인 발행', exact: true }).click();
  await expect(manager.getByRole('button', { name: '개정 1 PDF', exact: true })).toBeVisible({ timeout: 65000 });
  let approved = await readHistoricalPayroll(month);
  expect(approved.revision).toBe(1); expect(approved.sums.netPay).toBe(3329620);
  await payrollDownload(admin, manager.getByRole('button', { name: '개정 1 PDF', exact: true }), year);

  await manager.getByRole('button', { name: '정정 시작', exact: true }).click();
  await manager.getByLabel('급여 정정 시작 사유', { exact: true }).fill('확정 원장의 기타 공제 재확인');
  await manager.getByRole('button', { name: '정정 초안 만들기', exact: true }).click();
  await expect(manager.getByRole('heading', { name: `${year}년 ${month}월 승인본 정정`, exact: true })).toBeVisible({ timeout: 65000 });
  const correctionRow = manager.locator('.pymi-roster article').filter({ hasText: name });
  await correctionRow.getByRole('button', { name: '금액 수정', exact: true }).click();
  await correctionRow.getByLabel(`${name} 기타 공제`, { exact: true }).fill('30000');
  await manager.getByLabel('급여 검토·정정 사유', { exact: true }).fill('기타 공제 정정 승인 요청');
  await manager.getByRole('button', { name: '검토 내용 저장', exact: true }).click();
  await expect(manager.getByRole('button', { name: '검토 완료·승인 발행', exact: true })).toBeEnabled({ timeout: 65000 });
  const corrections = callableResult(await payrollProbe(admin, { action: 'listDrafts', year })).drafts;
  const correction = corrections.find(item => item.kind === 'CORRECTION' && item.month === month && item.status === 'PENDING');
  draft = callableResult(await payrollProbe(admin, { action: 'getDraft', id: correction.id })).draft;
  expect(draft.diff.changed.length).toBe(1); expect(draft.sums.netPay).toBe(3319620);
  expect((await readHistoricalPayroll(month)).sums.netPay).toBe(3329620);
  confirmHistoricalPayroll(admin, draft);
  await manager.getByRole('button', { name: '검토 완료·승인 발행', exact: true }).click();
  await expect(manager.getByRole('button', { name: '개정 2 PDF', exact: true })).toBeVisible({ timeout: 65000 });
  approved = await readHistoricalPayroll(month);
  expect(approved.revision).toBe(2); expect(approved.sums.netPay).toBe(3319620);
  const original = await readHistoricalPayroll(month, 1), current = await readHistoricalPayroll(month, 2);
  expect(original.sums.netPay).toBe(3329620); expect(current.sums.netPay).toBe(3319620);
  expect(original.source.sha256).toBe(sourceHash); expect(current.source.sha256).toBe(sourceHash);
  await payrollDownload(admin, manager.getByRole('button', { name: '개정 1 PDF', exact: true }), year);
  await payrollDownload(admin, manager.getByRole('button', { name: '개정 2 PDF', exact: true }), year);
  const oldSource = manager.locator('.pymi-revisions article').filter({ hasText: '개정 1 · 이전 승인본' });
  expect((await payrollSourceDownload(admin, oldSource.getByRole('button', { name: '보관 원본', exact: true }), filename)).equals(sourceBytes)).toBe(true);
  expect(admin.payrollRequests.some(input => input.action === 'monthlyPdf' && input.id === approved.id && input.revision === 1)).toBe(true);
  expect(admin.payrollConfirmations).toBe(2);
  expect(await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await admin.page.screenshot({ path: testInfo.outputPath(`payroll-revisions-${testInfo.project.use.viewport.width}px.png`), fullPage: true });
  await manager.getByRole('button', { name: '과거 급여 등록·정정 닫기', exact: true }).click();
  await expect(admin.page.getByRole('combobox', { name: '급여 대상 연도', exact: true })).toHaveValue(String(year));
  await expect(admin.page.getByRole('combobox', { name: '급여 대상 월', exact: true })).toHaveValue(String(month));
  await admin.page.getByRole('combobox', { name: '연간 급여명세서 직원 선택', exact: true }).selectOption(archiveId);
  await payrollDownload(admin, admin.page.getByRole('button', { name: '연간 급여명세서 PDF', exact: true }), year);

  expect((await probe(admin, `${payrollFirestoreUrl(approved.id)}/revisions/r000001`, { method: 'DELETE' })).status).toBe(403);
  const foreign = await actorFor(browser, testInfo); await login(foreign, fixtures.accounts.adminB);
  for (const payload of [{ action: 'getDraft', id: pending.id }, { action: 'listDraftVersions', id: pending.id },
    { action: 'sourceDownload', draftId: pending.id }, { action: 'sourceDownload', recordId: approved.id, revision: 1 },
    { action: 'monthlyPdf', id: approved.id, revision: 1 }, { action: 'listRevisions', id: approved.id },
    { action: 'approveDraft', id: pending.id, expectedDraftVersion: 2 }]) {
    // Hide whether another company's financial document exists.
    expect((await payrollProbe(foreign, payload)).status).toBe(404);
  }
  expect((await payrollProbe(foreign, { action: 'importSource', year, month, reason: '회사 ID 변조 거부', companyId: fixtures.companyA,
    source: { name: filename, mimeType: 'text/csv', base64: sourceBytes.toString('base64') } })).status).toBe(400);
});

test('suspended, resigned, disabled and revoked test accounts cannot retain attachment access', async ({ browser }, testInfo) => {
  const owner = await actorFor(browser, testInfo);
  await login(owner, fixtures.accounts.memberA);
  const record = await createExpense(owner, files[0], '계정 상태');
  for (const key of ['suspendedA', 'resignedA']) {
    const inactive = await actorFor(browser, testInfo);
    await login(inactive, fixtures.accounts[key], { denied: true });
    expect((await probe(inactive, attachmentUrl(record.id))).status).toBe(403);
    expect((await probe(inactive, firestoreUrl(record.id))).status).toBe(403);
  }
  const disabled = await actorFor(browser, testInfo);
  await login(disabled, fixtures.accounts.disabledA, { denied: true });
  expect(Boolean(disabled.token)).toBe(false);
  // Revocation timestamps have second precision; move beyond the sign-in second.
  const claims = JSON.parse(Buffer.from(owner.token.split('.')[1], 'base64url').toString());
  await expect.poll(() => Math.floor(Date.now() / 1000) > Number(claims.auth_time), { timeout: 5000 }).toBe(true);
  await revokeTestUser(fixtures.accounts.memberA);
  expect((await probe(owner, attachmentUrl(record.id))).status).toBe(401);
});
