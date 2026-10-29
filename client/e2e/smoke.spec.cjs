const { randomUUID } = require('node:crypto');
const { test, expect } = require('@playwright/test');
const { PROJECT_ID, WEB_ORIGIN, HOSTS, assertE2EEnvironment } = require('../../scripts/e2e/safety.cjs');
const { seedFixtures, clearFixtures, findExpenseByTitle, readAttachment, revokeTestUser } = require('../../scripts/e2e/fixtures.cjs');

assertE2EEnvironment();

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
  const actor = { context, page: await context.newPage(), violations: [], pageErrors: 0, dialogs: 0, token: '' };
  actors.push(actor);
  actor.page.on('pageerror', () => { actor.pageErrors += 1; });
  actor.page.on('dialog', async dialog => { actor.dialogs += 1; await dialog.dismiss(); });
  actor.page.on('request', async request => {
    const url = new URL(request.url());
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

async function login(actor, account, { denied = false } = {}) {
  await actor.page.goto('/#/login');
  await actor.page.getByPlaceholder('admin@yourcompany.com').fill(account.email);
  try {
    await actor.page.getByPlaceholder('비밀번호 입력', { exact: true }).fill(account.password);
  } catch {
    throw new Error('Could not enter the generated test-account password.');
  }
  await actor.page.locator('form').getByRole('button', { name: '로그인', exact: true }).click();
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
