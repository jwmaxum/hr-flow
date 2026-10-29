const path = require('node:path');
const PDFDocument = require('pdfkit');
const { PAYROLL_MONEY_FIELDS, normalizePayrollIdentity, normalizePayrollRow, sumPayrollRows, validatePayrollRecord } = require('./payroll-report-model');

const COLUMNS = Object.freeze([
  { key: 'identity', label: '성명 / 사번', width: 112 },
  { key: 'basePay', label: '기본급', width: 62 },
  { key: 'nonTaxable', label: '비과세액', width: 56 },
  { key: 'monthlyGross', label: '지급합계', width: 64 },
  { key: 'pension', label: '국민연금', width: 50 },
  { key: 'health', label: '건강보험', width: 50 },
  { key: 'employment', label: '고용보험', width: 48 },
  { key: 'longTerm', label: '장기요양', width: 48 },
  { key: 'incomeTax', label: '소득세', width: 50 },
  { key: 'localTax', label: '지방소득세', width: 45 },
  { key: 'totalDeductions', label: '공제합계', width: 60 },
  { key: 'netPay', label: '차인지급액', width: 66 },
  { key: 'signature', label: '영수인', width: 36 },
]);
const formatMoney = value => Number.isSafeInteger(value) ? value.toLocaleString('en-US') : '-';
const safeText = (value, maximum = 500) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid payroll PDF text.');
  return value.replaceAll('\t', ' ');
};
const shortDate = value => value ? value.slice(0, 10).replaceAll('-', '.') : '-';
function koreanDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replaceAll('-', '.');
}

function normalizeBranding(value) {
  const companyName = safeText(value?.companyName, 240);
  if (!companyName.trim()) throw new Error('Payroll company name is required.');
  return { companyName, address: safeText(value?.address), representative: safeText(value?.representative, 100) };
}

function createDocument(title, branding, draw) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', layout: 'landscape', pdfVersion: '1.7', bufferPages: true,
      margins: { top: 24, bottom: 24, left: 26, right: 26 },
      info: { Title: title, Author: branding.companyName, Subject: '승인 저장된 급여 상세자료', Creator: 'HR Flow' } });
    const chunks = [];
    pdf.on('data', chunk => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    try {
      pdf.registerFont('Korean', path.join(__dirname, 'fonts/NotoSansKR-Regular.otf'));
      pdf.registerFont('KoreanBold', path.join(__dirname, 'fonts/NotoSansKR-Bold.otf'));
      pdf._root.data.ViewerPreferences = pdf.ref({ PrintScaling: 'None' });
      draw(pdf);
      const range = pdf.bufferedPageRange();
      for (let page = range.start; page < range.start + range.count; page++) {
        pdf.switchToPage(page);
        pdf.page.margins.bottom = 0;
        pdf.font('Korean').fontSize(7.2).fillColor('#555555').text(
          `${branding.companyName}  |  ${title}`, 26, pdf.page.height - 22,
          { width: pdf.page.width - 140, height: 12, lineBreak: false, ellipsis: true });
        pdf.text(`${page - range.start + 1} / ${range.count}`, pdf.page.width - 100, pdf.page.height - 22,
          { width: 74, align: 'right', height: 12, lineBreak: false });
      }
      pdf.end();
    } catch (error) { pdf.destroy(); reject(error); }
  });
}

function helpers(pdf) {
  const left = 26;
  const width = pdf.page.width - left * 2;
  const bottom = pdf.page.height - 40;
  const scale = width / COLUMNS.reduce((sum, column) => sum + column.width, 0);
  const columns = COLUMNS.map(column => ({ ...column, width: column.width * scale }));
  const measure = (value, availableWidth, size = 8, bold = false) =>
    pdf.font(bold ? 'KoreanBold' : 'Korean').fontSize(size).heightOfString(value || '-', { width: availableWidth, lineGap: 1 });
  const write = (value, x, y, availableWidth, size = 8, bold = false, options = {}) => {
    pdf.font(bold ? 'KoreanBold' : 'Korean').fontSize(size).fillColor('#111111')
      .text(value || '-', x, y, { width: availableWidth, lineGap: 1, ...options });
  };
  const cell = (value, x, y, cellWidth, height, options = {}) => {
    pdf.lineWidth(.45).strokeColor('#333333');
    if (options.fill) pdf.rect(x, y, cellWidth, height).fillAndStroke(options.fill, '#333333');
    else pdf.rect(x, y, cellWidth, height).stroke();
    if (value === '') return;
    const size = options.size || 8;
    const contentHeight = Math.min(height - 8, measure(value || '-', cellWidth - 8, size, options.bold));
    write(value, x + 4, y + Math.max(4, (height - contentHeight) / 2), cellWidth - 8, size, options.bold,
      { align: options.align || 'right', height: height - 8, ellipsis: true });
  };
  const header = (title, branding, rightLines, employeeLines = '') => {
    const titleHeight = measure(title, width, 17, true);
    write(title, left, 23, width, 17, true, { align: 'center' });
    const titleWidth = Math.min(width, pdf.widthOfString(title));
    const ruleY = 23 + titleHeight + 3;
    pdf.lineWidth(1).strokeColor('#222222').moveTo((pdf.page.width - titleWidth) / 2, ruleY).lineTo((pdf.page.width + titleWidth) / 2, ruleY).stroke();
    const companyLines = [branding.companyName, branding.address, branding.representative ? `대표자: ${branding.representative}` : ''].filter(Boolean).join('\n');
    const top = ruleY + 10;
    const companyHeight = measure(companyLines, width - 250, 8.5);
    const rightHeight = measure(rightLines, 235, 8);
    write(companyLines, left, top, width - 250, 8.5, false);
    write(rightLines, left + width - 235, top, 235, 8, false, { align: 'right' });
    let y = top + Math.max(companyHeight, rightHeight) + 12;
    if (employeeLines) {
      write(employeeLines, left, y, width, 8.5);
      y += measure(employeeLines, width, 8.5) + 10;
    }
    return y;
  };
  const tableHeader = (y, annual = false) => {
    const groups = annual ? [
      ['월 / 자료 상태', [0]], ['기본급 및 지급액', [1, 2, 3]], ['공제 및 차인지급액', [4, 5, 6, 7, 8, 9, 10, 11]], ['비고', [12]],
    ] : [
      ['인적 사항', [0]], ['기본급 및 지급액', [1, 2, 3]], ['공제 및 차인지급액', [4, 5, 6, 7, 8, 9, 10, 11]], ['영수인', [12]],
    ];
    let x = left;
    for (const [label, indices] of groups) {
      const groupWidth = indices.reduce((sum, index) => sum + columns[index].width, 0);
      cell(label, x, y, groupWidth, 18, { align: 'center', fill: '#EEEEF2', bold: true, size: 8 }); x += groupWidth;
    }
    x = left;
    columns.forEach((column, index) => {
      const label = annual && index === 0 ? '귀속 월' : annual && index === 12 ? '상태' : column.label;
      cell(label, x, y + 18, column.width, 28, { align: 'center', fill: '#F5F5F7', bold: true, size: 7.7 }); x += column.width;
    });
    return y + 46;
  };
  const moneyRow = (amounts, identity, y, height, note = '', bold = false, fill) => {
    let x = left;
    columns.forEach((column, index) => {
      const value = index === 0 ? identity : index === 12 ? note : amounts ? formatMoney(amounts[column.key]) : '-';
      cell(value, x, y, column.width, height, { align: index === 0 ? 'left' : index === 12 ? 'center' : 'right', size: index === 0 ? 7.7 : 7.9, bold, fill }); x += column.width;
    });
    return y + height;
  };
  const rowHeight = (amounts, identity, minimum, bold = false) => Math.max(minimum, ...columns.map((column, index) => {
    if (index === 0) return measure(identity, column.width - 8, 7.7, bold) + 10;
    if (index === 12) return 0;
    return measure(amounts ? formatMoney(amounts[column.key]) : '-', column.width - 8, 7.9, bold) + 10;
  }));
  return { left, width, bottom, columns, measure, write, header, tableHeader, moneyRow, rowHeight };
}

/** Paginated A4 landscape ledger from a single approved company-wide snapshot. */
async function renderMonthlyPayrollPdf(value, brandingValue) {
  const record = validatePayrollRecord(value, value?.companyId);
  const branding = normalizeBranding(brandingValue);
  const title = `${record.year}년 ${record.month}월분 급여대장`;
  return createDocument(title, branding, pdf => {
    const h = helpers(pdf);
    const nextPage = () => {
      pdf.addPage();
      return h.tableHeader(h.header(title, branding, `귀속: ${record.year}년 ${record.month}월\n승인일: ${koreanDate(record.approvedAtIso)}  |  개정 ${record.revision}\n승인자: ${record.approvedByName || '-'}`));
    };
    let y = h.tableHeader(h.header(title, branding, `귀속: ${record.year}년 ${record.month}월\n승인일: ${koreanDate(record.approvedAtIso)}  |  개정 ${record.revision}\n승인자: ${record.approvedByName || '-'}`));
    const totalHeight = h.rowHeight(record.sums, `합계 (${record.rows.length}명)`, 34, true);
    for (const [index, row] of record.rows.entries()) {
      const identity = [row.name, `사번/직급: ${row.employeeNumber || '-'} / ${row.position || '-'}`,
        [row.divisionName, row.teamName].filter(Boolean).join(' / '),
        `입사: ${shortDate(row.joinDate)}`, row.resignDate ? `퇴사: ${shortDate(row.resignDate)}` : '',
      ].filter(Boolean).join('\n');
      const height = h.rowHeight(row.amounts, identity, 55);
      const reserve = index === record.rows.length - 1 ? totalHeight + 36 : 0;
      if (height > h.bottom - y || (index > 0 && height + reserve > h.bottom - y)) y = nextPage();
      if (height > h.bottom - y) throw new Error('Payroll employee identity is too long for one printable row.');
      y = h.moneyRow(row.amounts, identity, y, height);
    }
    if (y + totalHeight + 36 > h.bottom) y = nextPage();
    y = h.moneyRow(record.sums, `합계 (${record.rows.length}명)`, y, totalHeight, '', true, '#EEEEF2');
    h.write('승인 저장된 상세자료 기준 · 기본급은 지급합계에서 비과세액을 뺀 금액입니다. 단위: 원', h.left, y + 10, h.width, 7.7);
    const sourceLabel = record.taxTable.source === 'uploaded' ? '관리자 등록 세액표'
      : record.taxTable.source.startsWith('official') ? '공식 기본 세액표' : record.taxTable.source;
    const taxLabel = [sourceLabel, record.taxTable.version, record.taxTable.fileName].filter(Boolean).join(' / ');
    if (taxLabel) h.write(`적용 세액표: ${taxLabel}`, h.left, y + 23, h.width, 7.2, false, { height: 12, ellipsis: true });
  });
}

function validatedAnnualReport(report) {
  if (!report || !Number.isInteger(report.year) || report.year < 2000 || report.year > 2200 || !Array.isArray(report.months) || report.months.length !== 12) throw new Error('Invalid annual payroll report.');
  const employee = normalizePayrollIdentity(report.employee, report.companyId);
  if (employee.userId !== report.employeeId) throw new Error('Annual payroll employee does not match.');
  const months = report.months.map((item, index) => {
    if (item.month !== index + 1 || !['APPROVED', 'MISSING', 'LEGACY'].includes(item.status)) throw new Error('Invalid annual payroll month.');
    if (item.status !== 'APPROVED') {
      if (item.row !== null) throw new Error('Unapproved annual payroll values must not be supplied.');
      return item;
    }
    const row = normalizePayrollRow(item.row, report.companyId);
    if (row.userId !== report.employeeId) throw new Error('Annual payroll row does not match employee.');
    return { ...item, row };
  });
  const approved = months.filter(item => item.status === 'APPROVED');
  const sums = sumPayrollRows(approved.map(item => item.row));
  if (report.availableMonths !== approved.length || PAYROLL_MONEY_FIELDS.some(field => sums[field] !== report.sums?.[field])) throw new Error('Annual payroll totals do not reconcile.');
  return { ...report, employee, months, sums };
}

/** Twelve saved-month lines. Missing and legacy aggregate-only data use '-' cells. */
async function renderAnnualPayrollPdf(value, brandingValue) {
  const report = validatedAnnualReport(value);
  const branding = normalizeBranding(brandingValue);
  const title = `${report.year}년 ${report.employee.name} 급여명세서`;
  return createDocument(title, branding, pdf => {
    const h = helpers(pdf);
    const identity = [
      `성명: ${report.employee.name}  |  사번: ${report.employee.employeeNumber || '미등록'}  |  직급: ${report.employee.position || '-'}`,
      `부서: ${[report.employee.divisionName, report.employee.teamName].filter(Boolean).join(' / ') || '-'}  |  입사일: ${shortDate(report.employee.joinDate)}`,
    ].join('\n');
    const right = `귀속: ${report.year}년 1월 - 12월\n상세 승인자료: ${report.availableMonths}개월`;
    const nextPage = () => { pdf.addPage(); return h.tableHeader(h.header(title, branding, right, identity), true); };
    let y = h.tableHeader(h.header(title, branding, right, identity), true);
    for (const item of report.months) {
      const label = item.status === 'APPROVED' ? `${item.month}월` : `${item.month}월 · ${item.status === 'LEGACY' ? '상세자료 없음' : '미등록'}`;
      const height = h.rowHeight(item.row?.amounts || null, label, 23);
      if (y + height > h.bottom) y = nextPage();
      y = h.moneyRow(item.row?.amounts || null, label, y, height, item.status === 'APPROVED' ? '승인' : '-');
    }
    const notes = [
      report.availableMonths ? `합계는 승인 상세자료가 저장된 ${report.availableMonths}개월만 집계했습니다.` : '집계할 승인 상세자료가 없습니다. 현재 급여 설정으로 과거 금액을 계산하지 않습니다.',
      '미등록 월과 구방식 승인(합계만 저장된 월)은 지급액·공제액을 알 수 없어 - 로 표시합니다.',
      report.legacyAfterSnapshotMonths?.length ? `${report.legacyAfterSnapshotMonths.join(', ')}월은 이후 구방식 합계 승인 이력이 있어, 마지막 상세 승인본을 기준으로 표시했습니다.` : '',
    ].filter(Boolean).join('\n');
    const noteHeight = h.measure(notes, h.width, 7.5);
    const totalHeight = h.rowHeight(report.availableMonths ? report.sums : null, `합계 (${report.availableMonths}개월)`, 32, true);
    if (y + totalHeight + noteHeight + 14 > h.bottom) y = nextPage();
    y = h.moneyRow(report.availableMonths ? report.sums : null, `합계 (${report.availableMonths}개월)`, y, totalHeight, '', true, '#EEEEF2');
    h.write(notes, h.left, y + 10, h.width, 7.5);
  });
}

module.exports = { renderMonthlyPayrollPdf, renderAnnualPayrollPdf };
