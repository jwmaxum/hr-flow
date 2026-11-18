import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import readXlsx from 'read-excel-file/node';
import {
  erpWorkbook,
  createSimpleOpeningTemplate,
  convertToStandardOpeningWorkbook,
  createStockSnapshotWorkbook
} from '../src/utils/erpWorkbook.ts';
const report={companyId:'test-company',canManage:true,basisDate:'2026-11-01',revision:3,view:'summary',filters:{from:'2026-11-02',to:'2026-11-30',search:'',itemId:'',warehouseId:''},totalRows:1,totals:{closingValue:2250,salesKRW:1500,marginKRW:750},unitTotals:[{unit:'EA',openingQuantity:10,inQuantity:10,outQuantity:5,adjustQuantity:0,closingQuantity:15}],rows:[{itemId:'i',warehouseId:'w',code:'00001',name:'=HYPERLINK("https://example.invalid")',specification:'A&B <규격>',unit:'EA',warehouseCode:'01',warehouseName:'창고',openingQuantity:10,inQuantity:10,outQuantity:5,adjustQuantity:0,closingQuantity:15,openingValue:1000,inValue:2000,averageInPrice:200,outValue:750,adjustValue:0,closingValue:2250,salesKRW:1500,cogsKRW:750,marginKRW:750}]};
test('ERP XLSX is a real workbook with exact values, leading-zero strings, escaped XML and inert formula-like text',async()=>{
 const blob=await erpWorkbook(report),buffer=Buffer.from(await blob.arrayBuffer()),workbook=await readXlsx(buffer);
 assert.equal(workbook.length,3);assert.equal(workbook[0].data[1][0],'00001');assert.equal(workbook[0].data[1][1],report.rows[0].name);assert.equal(workbook[0].data[1][2],'A&B <규격>');
 assert.equal(workbook[0].data[1][12],15);assert.equal(workbook[0].data[1][20],2250);assert.equal(workbook[2].data[1][7],15);
 const zip=await JSZip.loadAsync(buffer);assert.equal((await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<f>'),false);
});
test('quantity-only exports omit monetary columns even if handed a stale object with monetary properties',async()=>{
 const workbook=await readXlsx(Buffer.from(await (await erpWorkbook({...report,canManage:false})).arrayBuffer()));
 const serialized=JSON.stringify(workbook);for(const needle of ['2250','1500','매출마진(KRW)','원거래단가','순매출(KRW)'])assert.equal(serialized.includes(needle),false);
 assert.equal(workbook[0].data[0].length,13);
});
test('detail XLSX preserves original links, signed movements, refund data and empty monetary cells',async()=>{
 const data={...report,view:'detail',rows:[{...report.rows[0],id:'m-2',date:'2026-11-03',order:1,rowNo:1,direction:'판매반품',documentNo:'COR-1',sourceDocumentNo:'OUT-1',sourceId:'m-1',quantityDelta:2,balanceQuantity:17,valueDelta:300,balanceValue:2550,refundKRW:600,reason:'부분반품',price:300,currency:'KRW'}]};
 const workbook=await readXlsx(Buffer.from(await (await erpWorkbook(data)).arrayBuffer()));const row=workbook[0].data[1];
 assert.equal(row[3],'판매반품');assert.equal(row[14],'m-1');assert.equal(row[11],2);assert.ok(row.includes(2550));assert.ok(row.includes(600));
});
test('transfer quantities and values are separate export columns and quantity readers cannot export transfer costs',async()=>{
 const data={...report,rows:[{...report.rows[0],transferInQuantity:4,transferOutQuantity:2,transferInValue:701,transferOutValue:351,closingQuantity:17}],unitTotals:[{...report.unitTotals[0],transferInQuantity:4,transferOutQuantity:2,closingQuantity:17}]};
 const workbook=await readXlsx(Buffer.from(await (await erpWorkbook(data)).arrayBuffer()));
 const [headers,row]=workbook[0].data;
 for(const [label,value] of [['이동입고수량',4],['이동출고수량',2],['이동입고금액(KRW)',701],['이동출고금액(KRW)',351]])assert.equal(row[headers.indexOf(label)],value);
 assert.deepEqual(workbook[2].data[1].slice(4,6),[4,2]);
 const restricted=await readXlsx(Buffer.from(await (await erpWorkbook({...data,canManage:false})).arrayBuffer()));
 assert.equal(JSON.stringify(restricted).includes('701'),false);assert.equal(JSON.stringify(restricted).includes('351'),false);
});


test('simple opening template generates valid single-sheet workbook', async () => {
  const blob = await createSimpleOpeningTemplate();
  const buffer = Buffer.from(await blob.arrayBuffer());
  const sheets = await readXlsx(buffer);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].sheet, '기초재고');
  assert.equal(sheets[0].data[0][0], '품목코드');
  assert.equal(sheets[0].data[0][1], '품목명');
  assert.equal(sheets[0].data[1][0], 'ITEM-001');
});

test('simple opening rows convert into standard two-sheet workbook compatible with server parser', async () => {
  const rows = [
    { code: 'A001', name: '상품A', specification: '규격1', unit: 'EA', quantity: 20, price: 5000, warehouseCode: 'WH01' }
  ];
  const blob = await convertToStandardOpeningWorkbook('테스트회사', '2026-11-01', rows, 'WH01');
  const buffer = Buffer.from(await blob.arrayBuffer());
  const sheets = await readXlsx(buffer);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].sheet, '작성안내');
  assert.equal(sheets[1].sheet, '이관입력');
  assert.equal(sheets[0].data[4][1], '테스트회사'); // B5
  assert.equal(sheets[0].data[5][1], '2026-11-01'); // B6
  assert.equal(sheets[1].data[8][1], '품목코드');   // 9행 헤더
  assert.equal(sheets[1].data[9][1], 'A001');       // 10행 데이터
  assert.equal(sheets[1].data[9][10], 20);          // 기초수량
  assert.equal(sheets[1].data[9][12], 5000);        // 기초단가
});

test('stock snapshot workbook generates complete all-in-one current stock sheet', async () => {
  const snapshotItems = [
    { code: 'P01', name: '마우스', unit: 'EA', quantity: 15, warehouses: { '본사': 10, '물류': 5 }, active: true, purchasePrice: 1000, salePrice: 2000 }
  ];
  const blob = await createStockSnapshotWorkbook(snapshotItems, ['본사', '물류'], true);
  const buffer = Buffer.from(await blob.arrayBuffer());
  const sheets = await readXlsx(buffer);
  assert.equal(sheets.length, 1);
  assert.equal(sheets[0].sheet, '현재고현황');
  assert.equal(sheets[0].data[0][0], '품목코드');
  assert.equal(sheets[0].data[0][5], '전체현재고');
  assert.equal(sheets[0].data[1][0], 'P01');
  assert.equal(sheets[0].data[1][5], 15);
  assert.equal(sheets[0].data[1][6], 10);
  assert.equal(sheets[0].data[1][7], 5);
});
