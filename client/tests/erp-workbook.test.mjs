import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import readXlsx from 'read-excel-file/node';
import { erpWorkbook } from '../src/utils/erpWorkbook.ts';
const report={companyId:'test-company',canManage:true,basisDate:'2026-11-01',revision:3,view:'summary',filters:{from:'2026-11-02',to:'2026-11-30',search:'',itemId:'',warehouseId:''},totalRows:1,totals:{closingValue:2250,salesKRW:1500,marginKRW:750},unitTotals:[{unit:'EA',openingQuantity:10,inQuantity:10,outQuantity:5,adjustQuantity:0,closingQuantity:15}],rows:[{itemId:'i',warehouseId:'w',code:'00001',name:'=HYPERLINK("https://example.invalid")',specification:'A&B <규격>',unit:'EA',warehouseCode:'01',warehouseName:'창고',openingQuantity:10,inQuantity:10,outQuantity:5,adjustQuantity:0,closingQuantity:15,openingValue:1000,inValue:2000,averageInPrice:200,outValue:750,adjustValue:0,closingValue:2250,salesKRW:1500,cogsKRW:750,marginKRW:750}]};
test('ERP XLSX is a real workbook with exact values, leading-zero strings, escaped XML and inert formula-like text',async()=>{
 const blob=await erpWorkbook(report),buffer=Buffer.from(await blob.arrayBuffer()),workbook=await readXlsx(buffer);
 assert.equal(workbook.length,3);assert.equal(workbook[0].data[1][0],'00001');assert.equal(workbook[0].data[1][1],report.rows[0].name);assert.equal(workbook[0].data[1][2],'A&B <규격>');
 assert.equal(workbook[0].data[1][10],15);assert.equal(workbook[0].data[1][16],2250);assert.equal(workbook[2].data[1][5],15);
 const zip=await JSZip.loadAsync(buffer);assert.equal((await zip.file('xl/worksheets/sheet1.xml').async('string')).includes('<f>'),false);
});
test('quantity-only exports omit monetary columns even if handed a stale object with monetary properties',async()=>{
 const workbook=await readXlsx(Buffer.from(await (await erpWorkbook({...report,canManage:false})).arrayBuffer()));
 const serialized=JSON.stringify(workbook);for(const needle of ['2250','1500','매출마진(KRW)','원거래단가','순매출(KRW)'])assert.equal(serialized.includes(needle),false);
 assert.equal(workbook[0].data[0].length,11);
});
test('detail XLSX preserves original links, signed movements, refund data and empty monetary cells',async()=>{
 const data={...report,view:'detail',rows:[{...report.rows[0],id:'m-2',date:'2026-11-03',order:1,rowNo:1,direction:'판매반품',documentNo:'COR-1',sourceDocumentNo:'OUT-1',sourceId:'m-1',quantityDelta:2,balanceQuantity:17,valueDelta:300,balanceValue:2550,refundKRW:600,reason:'부분반품',price:300,currency:'KRW'}]};
 const workbook=await readXlsx(Buffer.from(await (await erpWorkbook(data)).arrayBuffer()));const row=workbook[0].data[1];
 assert.equal(row[3],'판매반품');assert.equal(row[13],'m-1');assert.equal(row[10],2);assert.ok(row.includes(2550));assert.ok(row.includes(600));
});
