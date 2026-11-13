// Uses the same OOXML layout and inline-string encoding as client erpWorkbook.ts.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildErpWorkbook = buildErpWorkbook;
const xml = (value) => [...String(value ?? '')].filter(char => {
    const point = char.codePointAt(0);
    return [9, 10, 13].includes(point) || point >= 32 && (point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000);
}).join('').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[value]);
function column(index) { let output = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    output = String.fromCharCode(65 + (n - 1) % 26) + output; return output; }
function sheet(rows, widths) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${rows[0].map((_, i) => `<col min="${i + 1}" max="${i + 1}" width="${widths?.[i] || 22}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
        const ref = `${column(c)}${r + 1}`;
        // Explicit inline strings preserve leading zeros and prevent formula injection.
        return typeof value === 'number' && Number.isFinite(value) ? `<c r="${ref}" s="${r ? 2 : 1}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr" s="${r ? 0 : 1}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
    }).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${column(rows[0].length - 1)}${rows.length}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
}
async function buildErpWorkbook(sheets) {
    const JSZip = require('jszip');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    zip.file('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><definedNames>${sheets.map((s, i) => `<definedName name="_xlnm.Print_Titles" localSheetId="${i}">&apos;${xml(s.name)}&apos;!$1:$1</definedName>`).join('')}</definedNames></workbook>`);
    zip.file('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file('xl/styles.xml', '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.####;[Red]-#,##0.####"/></numFmts><fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF7E3279"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFill="1" applyFont="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    sheets.forEach((s, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheet(s.rows, s.widths)));
    return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}

exports.renderFinanceWorkbook = report => buildErpWorkbook([
 {name:'보고서 기준',widths:[26,72],rows:[['항목','내용'],['보고서',report.title],['회사',report.companyName],['조회 기준일',report.asOf],['생성시각 (UTC)',report.generatedAt],['자료번호',report.snapshot],...report.notes.map((n,i)=>['기준 '+(i+1),n])]},
 ...report.sections.map(s=>({name:s.name,widths:s.columns.map(c=>Math.min(48,Math.max(14,c.width*16))),rows:[s.columns.map(c=>c.label),...s.rows]}))
]);
