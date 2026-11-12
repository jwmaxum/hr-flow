const path = require('node:path');
const PDFDocument = require('pdfkit');
const { digits, koreanAmount } = require('./erp-document-model');

/** Render only a server-validated document snapshot; no network or database reads. */
async function renderErpDocumentPdf(document, images) {
  return new Promise((resolve, reject) => {
    const statement = document.kind === 'STATEMENT', english = document.kind === 'PROFORMA';
    const title = english ? 'PROFORMA INVOICE' : statement ? '거래명세표' : '청구서 (Invoice)';
    const pdf = new PDFDocument({ size: 'A4', layout: statement ? 'landscape' : 'portrait', pdfVersion: '1.7', autoFirstPage: false,
      bufferPages: true, margins: { top: 32, bottom: 35, left: 36, right: 36 }, info: { Title: title,
        Author: document.branding.companyName, Subject: document.number, Creator: 'HR Flow ERP', CreationDate: new Date(document.issuedAt) } });
    const chunks = [];
    pdf.on('data', bytes => chunks.push(bytes)); pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject);
    try {
      pdf.registerFont('Regular', path.join(__dirname, 'fonts/NotoSansKR-Regular.otf'));
      pdf.registerFont('Bold', path.join(__dirname, 'fonts/NotoSansKR-Bold.otf'));
      pdf._root.data.ViewerPreferences = pdf.ref({ PrintScaling: 'None' });
      const left = 36, pages = [], copyLabels = statement ? ['공급자 보관용', '공급받는자 보관용'] : [''];
      const amount = minor => (minor / 10 ** digits(document.currency)).toLocaleString('en-US', { minimumFractionDigits: digits(document.currency), maximumFractionDigits: digits(document.currency) });
      const quantity = scaled => (scaled / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 });
      const measure = (value, width, size = 9, bold = false) => pdf.font(bold ? 'Bold' : 'Regular').fontSize(size).heightOfString(String(value || '-'), { width, lineGap: 1.6 });
      const write = (value, x, y, width, size = 9, bold = false, options = {}) => pdf.font(bold ? 'Bold' : 'Regular').fontSize(size).fillColor('#202632').text(String(value || '-'), x, y, { width, lineGap: 1.6, ...options });
      let y, width, bottom, columns, currentCopy;
      const rule = at => pdf.lineWidth(.5).strokeColor('#B8C0CA').moveTo(left, at).lineTo(left + width, at).stroke();
      function header(continued = false) {
        width = pdf.page.width - left * 2; bottom = pdf.page.height - 42;
        const label = document.draft ? (english ? 'DRAFT - NOT VALID / NO SEAL' : '미리보기 초안 · 미발행 · 인감 미날인') : currentCopy;
        write(title, left, statement ? 22 : 30, width - 120, continued ? 15 : statement ? 18 : 21, true);
        if (label) write(label, left + width - 230, statement ? 25 : 33, 230, 8, true, { align: 'right' });
        const top = statement ? 51 : 66;
        const meta = `${english ? 'No.' : '문서번호'} ${document.number}    |    ${english ? 'Date' : '발행일'} ${document.issueDate}    |    ${document.currency}`;
        write(meta, left, top, width, 8.5); y = top + (statement ? 20 : 24);
        if (document.replacesNumber) { write(`${english ? 'Replaces cancelled document' : '취소 원본 정정'}: ${document.replacesNumber} (${document.edition})`, left, y, width, 8); y += 19; }
        if (continued) {
          const line = `${document.branding.companyName}  /  ${english ? 'Buyer' : '거래처'}: ${document.buyer.name}`;
          const h = measure(line, width, 8); write(line, left, y, width, 8); y += h + 12; return;
        }
        if (images.logo) pdf.image(images.logo, left + width - 110, statement ? 40 : 54, { fit: [110, statement ? 20 : 28], align: 'right', valign: 'center' });
        const gap = 16, blockWidth = (width - gap) / 2;
        const sellerLines = [document.branding.companyName,
          `${english ? 'Representative' : '대표자'}: ${document.branding.representative}`,
          document.branding.registrationNumber && `${english ? 'Registration' : '사업자등록번호'}: ${document.branding.registrationNumber}`,
          document.branding.address, document.branding.phone && `Tel: ${document.branding.phone}`, document.branding.email,
          !english && [document.branding.businessType && `업태 ${document.branding.businessType}`, document.branding.businessItem && `종목 ${document.branding.businessItem}`].filter(Boolean).join(' / ')].filter(Boolean);
        const buyer = [document.buyer.name, document.buyer.registrationNumber && `${english ? 'Registration' : '등록번호'}: ${document.buyer.registrationNumber}`,
          document.buyer.address, [document.buyer.contactName, document.buyer.phone].filter(Boolean).join(' / '), document.buyer.email].filter(Boolean).join('\n');
        const seller = (statement ? [document.branding.companyName,
          [`대표자 ${document.branding.representative}`, document.branding.registrationNumber && `등록 ${document.branding.registrationNumber}`].filter(Boolean).join(' / '),
          document.branding.address, [document.branding.phone, document.branding.email].filter(Boolean).join(' / '),
          [document.branding.businessType && `업태 ${document.branding.businessType}`, document.branding.businessItem && `종목 ${document.branding.businessItem}`].filter(Boolean).join(' / ')] : sellerLines).filter(Boolean).join('\n');
        const sealWidth = document.branding.sealWidthMm * 72 / 25.4, sealHeight = document.branding.sealHeightMm * 72 / 25.4;
        const sellerWidth = blockWidth - 20 - (statement ? sealWidth + 8 : 0);
        const height = Math.max(measure(seller, sellerWidth, statement ? 8 : 8.5), measure(buyer, blockWidth - 20, statement ? 8 : 8.5), statement ? sealHeight : 0) + (statement ? 32 : 37);
        for (const [index, heading, content] of [[0, english ? 'SELLER' : '공급자', seller], [1, english ? 'BUYER' : '공급받는자', buyer]]) {
          const x = left + index * (blockWidth + gap);
          pdf.roundedRect(x, y, blockWidth, height, 4).lineWidth(.5).strokeColor('#C7CCD3').stroke();
          write(heading, x + 10, y + 7, blockWidth - 20, 8.5, true); write(content, x + 10, y + 25, !index ? sellerWidth : blockWidth - 20, statement ? 8 : 8.5);
        }
        if (statement) {
          const x = left + blockWidth - 10 - sealWidth;
          if (document.draft) write('발행 시 등록 인감', x, y + 27, sealWidth, 7, false, { align: 'center' });
          else { if (!images.seal) throw new Error('An issued ERP PDF requires the frozen seal'); pdf.image(images.seal, x, y + 25, { width: sealWidth, height: sealHeight }); }
        }
        y += height + (statement ? 9 : 14);
        if (document.sourceDocumentNo) { write(`원출고 문서: ${document.sourceDocumentNo}`, left, y, width, 8.5); y += statement ? 18 : 23; }
        if (english) { write(`Valid until: ${document.validUntil}`, left, y, width, 8.5); y += 23; }
      }
      function startPage(continued, withTable = false) {
        pdf.addPage(); pages.push(currentCopy); header(continued); if (withTable) tableHeader();
      }
      function ensure(height, withTable = false) { if (y + height > bottom) startPage(true, withTable); }
      function tableHeader() {
        const labels = statement ? ['No.', '거래일', '품목·규격', '수량', '단위', '단가', '공급가액', '세액', '비고'] :
          english ? ['No.', 'Description', 'Qty', 'Unit', 'Unit price', 'Amount', 'Tax'] : ['No.', '품목·규격', '수량', '단위', '단가', '공급가액', '세액'];
        const weights = statement ? [26, 48, 218, 56, 32, 82, 104, 92, 115] : [24, 171, 43, 33, 75, 91, 86];
        const sum = weights.reduce((a, b) => a + b, 0); columns = weights.map(weight => width * weight / sum);
        pdf.rect(left, y, width, 28).fill('#EFF1F5'); let x = left;
        labels.forEach((label, index) => { write(label, x + 5, y + 7, columns[index] - 10, 7.7, true, { align: index >= 2 && label !== '품목·규격' ? 'right' : 'left' }); x += columns[index]; });
        y += 28; rule(y);
      }
      function row(line) {
        const description = [line.description, `${line.code}${line.specification ? ` / ${line.specification}` : ''}`, !statement && line.notes].filter(Boolean).join('\n');
        const unitPrice = `${quantity(line.priceScaled)}${line.priceBasis === '세금포함' ? english ? '\nIncl. tax' : '\n세금 포함' : ''}`;
        const cells = statement ? [String(line.rowNo), line.sourceDate.slice(5).replace('-', '/'), description, quantity(line.quantityScaled), line.unit,
          unitPrice, amount(line.supplyMinor), amount(line.taxMinor), line.notes || '-'] :
          [String(line.rowNo), description, quantity(line.quantityScaled), line.unit, unitPrice, amount(line.supplyMinor), amount(line.taxMinor)];
        // Measure every cell, including large money values and long units.
        const height = Math.max(30, ...cells.map((value, index) => measure(value, columns[index] - 10, 8) + 10));
        ensure(height, true);
        if (y + height > bottom) throw new Error('ERP PDF row exceeds printable page');
        let x = left;
        cells.forEach((value, index) => { write(value, x + 5, y + 5, columns[index] - 10, 8, false,
          { align: statement ? [3, 5, 6, 7].includes(index) ? 'right' : 'left' : index >= 2 ? 'right' : 'left' }); x += columns[index]; });
        y += height; rule(y);
      }
      function paragraph(label, value) {
        if (!value) return;
        // Split only at lines/words when needed, so long terms remain complete.
        const full = `${label}: ${value}`, tokens = full.split(/(\s+)/u); let line = '';
        for (const token of tokens) {
          const candidate = line + token;
          if (measure(candidate, width, 8.5) > 50 && line) { const h = measure(line, width, 8.5); ensure(h + 8); write(line, left, y, width, 8.5); y += h + 8; line = token.trimStart(); }
          else line = candidate;
        }
        if (line) { const h = measure(line, width, 8.5); ensure(h + 8); if (y + h > bottom) throw new Error('ERP PDF terms exceed printable page'); write(line, left, y, width, 8.5); y += h + 8; }
      }
      for (const copy of copyLabels) {
        currentCopy = copy; startPage(false); ensure(68); tableHeader();
        for (const line of document.rows) row(line);
        const detailLines = [[statement && document.currency === 'KRW' ? '합계금액' : '', statement && document.currency === 'KRW' ? `금 ${koreanAmount(document.totals.totalMinor)} 원정` : ''],
          [english ? 'Payment' : '결제 조건', document.paymentTerms], [english ? 'Delivery' : '납기·배송', document.deliveryTerms],
          [english ? 'Trade terms' : '무역 조건', document.tradeTerms], [english ? 'Bank details' : '은행 정보', document.branding.bankDetails], [english ? 'Notes' : '비고', document.notes]];
        const detailText = detailLines.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`).join('\n');
        const detailWidth = width - 270, detailHeight = measure(detailText, detailWidth, 8), compact = detailHeight <= 200;
        const finalHeight = compact ? Math.max(74, detailHeight) : 74;
        ensure(finalHeight + 18); y += 12;
        const summaryStart = y;
        const totals = [[english ? 'Subtotal' : '공급가액 합계', document.totals.supplyMinor], [english ? 'Tax' : '세액 합계', document.totals.taxMinor], [english ? 'TOTAL' : '합계금액', document.totals.totalMinor]];
        for (const [label, value] of totals) { write(label, left + width - 250, y, 110, 9, label === totals[2][0]); write(`${document.currency} ${amount(value)}`, left + width - 140, y, 140, 10, true, { align: 'right' }); y += 23; }
        if (compact) { write(detailText, left, summaryStart, detailWidth, 8); y = summaryStart + finalHeight + 8; }
        else for (const [label, value] of detailLines) paragraph(label, value);
        const sealWidth = document.branding.sealWidthMm * 72 / 25.4, sealHeight = document.branding.sealHeightMm * 72 / 25.4;
        const signText = `${document.branding.companyName}\n${english ? 'Authorized representative' : '대표자'}: ${document.branding.representative}`;
        const signWidth = width - sealWidth - 24, signHeight = Math.max(measure(signText, signWidth, 10, true), sealHeight) + 16;
        if (!statement) {
          ensure(signHeight + 20); y += 10; write(signText, left, y + 7, signWidth, 10, true);
          if (!document.draft) {
            if (!images.seal) throw new Error('An issued ERP PDF requires the frozen seal');
            pdf.image(images.seal, left + width - sealWidth, y, { width: sealWidth, height: sealHeight });
          } else write(english ? 'Seal on issue' : '발행 시 등록 인감 표시', left + width - sealWidth, y, sealWidth, 8, false, { align: 'center' });
          y += signHeight;
        }
        if (statement) {
          ensure(52);
          const labels = ['작성', '검토', '승인', '인수자'], cellWidth = width / 4;
          labels.forEach((label, index) => { const x = left + index * cellWidth; pdf.rect(x, y, cellWidth, 48).lineWidth(.5).strokeColor('#B8C0CA').stroke(); write(label, x + 8, y + 7, cellWidth - 16, 8); if (!index) write(document.issuedByName, x + 8, y + 25, cellWidth - 16, 8); });
        }
      }
      const range = pdf.bufferedPageRange();
      if (range.count > 60) throw new Error('ERP PDF page limit exceeded');
      for (let index = 0; index < range.count; index++) {
        pdf.switchToPage(index); pdf.page.margins.bottom = 0;
        const label = [document.number, pages[index], document.draft ? 'DRAFT' : 'HR Flow ERP'].filter(Boolean).join(' | ');
        write(label, left, pdf.page.height - 26, pdf.page.width - left * 2 - 70, 7);
        write(`${index + 1} / ${range.count}`, pdf.page.width - left - 65, pdf.page.height - 26, 65, 7, false, { align: 'right' });
      }
      pdf.end();
    } catch (error) { pdf.destroy(); reject(error); }
  });
}
module.exports = { renderErpDocumentPdf };
