const JSZip = require('jszip');
const { validatePayrollRecord } = require('./payroll-report-model');

const xml = value => [...String(value ?? '')].filter(char => {
  const point = char.codePointAt(0);
  return [9, 10, 13].includes(point) || point >= 32 && (point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000);
}).join('').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);

function columnName(index) {
  let output = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    output = String.fromCharCode(65 + (n - 1) % 26) + output;
  }
  return output;
}

const shortDate = value => value ? String(value).slice(0, 10) : '';

function koreanDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '-';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function payrollTypeLabel(calculation) {
  const source = calculation?.tableSource;
  if (source === 'freelancer-business-3.3%') return '비정규 (사업소득 3.3%)';
  if (source === 'other-income-8.8%') return '비정규 (기타소득 8.8%)';
  if (calculation?.mode === 'IMPORTED') return '과거 원본 등록';
  if (calculation?.mode === 'ADJUSTED') return '정정 승인';
  return '정규직 (근로소득)';
}

function buildWorksheetXml(rows, widths, summaryRowIndex = -1) {
  const colDefs = rows[0].map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths?.[i] || 16}" customWidth="1"/>`).join('');
  const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
    const ref = `${columnName(c)}${r + 1}`;
    const isHeader = r === 0;
    const isTotal = r === summaryRowIndex;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const style = isHeader ? 1 : isTotal ? 4 : 2;
      return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
    }
    const style = isHeader ? 1 : isTotal ? 3 : 0;
    // Explicit inlineStr prevents Excel formula injection (=, +, -, @) and preserves leading zeros.
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${colDefs}</cols><sheetData>${body}</sheetData><autoFilter ref="A1:${columnName(rows[0].length - 1)}${Math.max(1, summaryRowIndex > 0 ? summaryRowIndex : rows.length)}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}

async function buildWorkbookBuffer(sheets) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">&apos;${xml(s.name)}&apos;!$1:$1</definedName>`).join('')}</definedNames></workbook>`);
  zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0;[Red]-#,##0"/></numFmts><fonts count="3"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/><color rgb="FFFFFFFF"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7E3279"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEEEF2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="center" horizontal="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf><xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyFill="1" applyFont="1" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" horizontal="right"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, buildWorksheetXml(s.rows, s.widths, s.summaryRowIndex)));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Generates a standard .xlsx workbook for an approved company-wide monthly payroll snapshot. */
async function renderMonthlyPayrollExcel(value, brandingValue) {
  const record = validatePayrollRecord(value, value?.companyId);
  const companyName = String(brandingValue?.companyName || '회사').trim() || '회사';
  const header = [
    '성명', '사번', '직급', '본부', '팀', '입사일', '퇴사일', '급여구분',
    '기본급·과세수당', '비과세액', '지급합계',
    '국민연금', '건강보험', '고용보험', '장기요양', '소득세', '지방소득세', '기타공제',
    '공제합계', '차인지급액',
  ];
  const rows = [
    header,
    ...record.rows.map(row => [
      row.name,
      row.employeeNumber || '',
      row.position || '',
      row.divisionName || '',
      row.teamName || '',
      shortDate(row.joinDate),
      shortDate(row.resignDate),
      payrollTypeLabel(row.calculation),
      row.amounts.basePay,
      row.amounts.nonTaxable,
      row.amounts.monthlyGross,
      row.amounts.pension,
      row.amounts.health,
      row.amounts.employment,
      row.amounts.longTerm,
      row.amounts.incomeTax,
      row.amounts.localTax,
      row.amounts.otherDeductions ?? 0,
      row.amounts.totalDeductions,
      row.amounts.netPay,
    ]),
    [
      `합계 (${record.rows.length}명)`, '', '', '', '', '', '', '',
      record.sums.basePay,
      record.sums.nonTaxable,
      record.sums.monthlyGross,
      record.sums.pension,
      record.sums.health,
      record.sums.employment,
      record.sums.longTerm,
      record.sums.incomeTax,
      record.sums.localTax,
      record.sums.otherDeductions ?? 0,
      record.sums.totalDeductions,
      record.sums.netPay,
    ],
  ];
  const sourceLabel = record.taxTable.source === 'uploaded' ? '관리자 등록 세액표'
    : record.taxTable.source.startsWith('official') ? '공식 기본 세액표' : record.taxTable.source;
  const infoRows = [
    ['항목', '내용'],
    ['회사명', companyName],
    ['대표자', String(brandingValue?.representative || '')],
    ['귀속연월', `${record.year}년 ${record.month}월`],
    ['상태', `확정 완료 (개정 ${record.revision})`],
    ['승인일', koreanDate(record.approvedAtIso)],
    ['승인자', record.approvedByName || ''],
    ['적용 세액표', [sourceLabel, record.taxTable.version, record.taxTable.fileName].filter(Boolean).join(' / ')],
    ['대상 인원', record.rows.length],
    ['총 지급액(원)', record.sums.monthlyGross],
    ['총 공제액(원)', record.sums.totalDeductions],
    ['차인지급액 합계(원)', record.sums.netPay],
  ];
  return buildWorkbookBuffer([
    {
      name: `${record.year}년_${String(record.month).padStart(2, '0')}월_급여대장`,
      rows,
      widths: [14, 14, 12, 14, 14, 12, 12, 22, 16, 14, 16, 14, 14, 14, 14, 14, 14, 14, 16, 16],
      summaryRowIndex: rows.length - 1,
    },
    {
      name: '급여대장 정보',
      rows: infoRows,
      widths: [20, 44],
      summaryRowIndex: -1,
    },
  ]);
}

module.exports = { renderMonthlyPayrollExcel };
