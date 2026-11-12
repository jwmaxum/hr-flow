const { deflateSync, crc32 } = require('node:zlib');
function sealPng() {
  const width = 240, height = 160, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ellipse = ((x - 120) / 108) ** 2 + ((y - 80) / 69) ** 2;
    const border = ellipse < 1 && ellipse > .85, mark = Math.abs(x - 120) < 5 && y > 38 && y < 121 || Math.abs(y - 80) < 5 && x > 65 && x < 176;
    const index = y * (width * 4 + 1) + 1 + x * 4;
    pixels[index] = 188; pixels[index + 1] = 32; pixels[index + 2] = 48; pixels[index + 3] = border || mark ? 255 : 0;
  }
  function chunk(type, data) { const name = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4); length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data]))); return Buffer.concat([length, name, data, crc]); }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function snapshot(kind = 'INVOICE', count = 5, long = false) {
  const english = kind === 'PROFORMA';
  const rows = Array.from({ length: count }, (_, index) => ({ rowNo: index + 1, sourceId: `source-${index}`, itemId: `item-${index}`, code: String(index + 1).padStart(4, '0'),
    description: `${english ? 'Professional monitor' : '업무용 모니터'} ${index + 1}${long ? ' / ' + (english ? 'Extended product specification and accessory package ' : '한글·영문 혼합 상세 품목 규격과 추가 구성품 안내 ').repeat(2) : ''}`,
    specification: long ? '24-inch / HDMI / USB-C / 1920×1080 / 장기 보관 시 취급 주의사항 포함' : '24-inch / HDMI', unit: 'EA', quantityScaled: 150000, priceScaled: 1325000000,
    taxType: '과세', taxRateScaled: 100000, priceBasis: '세금포함', supplyMinor: 1806818, taxMinor: 180682,
    notes: english ? 'Synthetic sample' : '검증용 합성 자료', sourceDate: '2026-11-12', warehouseName: '본사 창고' }));
  return { kind, schema: 1, number: `${{ PROFORMA: 'PI', INVOICE: 'INV', STATEMENT: 'TS' }[kind]}-2026-000001`, issueDate: '2026-11-12', validUntil: '2026-12-12', currency: 'KRW',
    branding: { companyName: english ? 'Sample Technology Co., Ltd.' : '검증 테크놀로지 주식회사', companyNameKo: '검증 테크놀로지 주식회사',
      address: english ? '10 Sample Road, Seoul, Republic of Korea' : '서울특별시 검증구 샘플로 10, 2층', representative: english ? 'Sample Kim' : '김검증', registrationNumber: '000-00-00000',
      phone: '02-000-0000', email: 'sample@example.invalid', businessType: '도소매', businessItem: '전자제품', bankDetails: 'Sample Bank / TEST-0000 / Sample Technology',
      sealWidthMm: long ? 50 : 28, sealHeightMm: long ? 50 : 18, settingsVersion: 1, profileVersion: 1 },
    buyer: { id: 'buyer', name: english ? 'Sample Buyer Corporation' : '샘플 구매회사', address: english ? '20 Buyer Avenue, London, United Kingdom' : '부산광역시 검증구 구매로 20', registrationNumber: '111-11-11111', country: 'KR', contactName: english ? 'Purchasing department' : '구매 담당자', phone: '051-000-0000', email: 'buyer@example.invalid' },
    rows, totals: { supplyMinor: 1806818 * count, taxMinor: 180682 * count, totalMinor: 1987500 * count },
    paymentTerms: english ? 'Payment within 30 days of invoice date.' : '발행일로부터 30일 이내 지급', deliveryTerms: english ? 'Delivery to the agreed address.' : '합의한 납품 장소에 배송',
    tradeTerms: english ? 'Terms to be agreed before shipment.' : '', notes: long ? (english ? 'Long notes for page-break verification. ' : '긴 비고와 페이지 나눔을 확인하는 합성 문서입니다. ').repeat(18) : english ? 'SYNTHETIC SAMPLE - NOT A REAL TRANSACTION' : '검증용 합성 문서 · 실제 거래 아님',
    sourceDocumentNo: english ? '' : 'OUT-SAMPLE-001', edition: 1, replacesNumber: '', issuedAt: '2026-11-12T03:00:00.000Z', issuedByName: '검증 작성자' };
}
module.exports = { sealPng, snapshot };
