import type {FinanceExportReport} from '../services/erpFinanceExportService';
import {buildErpWorkbook} from './erpWorkbook.ts';
export function financeWorkbook(report:FinanceExportReport):Promise<Blob>{
  return buildErpWorkbook([
    {name:'보고서 기준',widths:[26,72],rows:[['항목','내용'],['보고서',report.title],['회사',report.companyName],['거래처',report.partnerName||'전체'],['조회 시작일',report.from||'누적'],['조회 기준일',report.asOf],['생성시각 (UTC)',report.generatedAt],['자료번호',report.snapshot],...report.notes.map((n,i)=>[`기준 ${i+1}`,n]),...report.sections.map(s=>[`${s.name} 전체 행`,s.rows.length]),...report.sections.filter(s=>s.note).map(s=>[`${s.name} 안내`,s.note])]},
    ...report.sections.map(s=>({name:s.name,widths:s.columns.map(c=>Math.min(48,Math.max(14,c.width*16))),rows:[s.columns.map(c=>c.label),...s.rows]})),
  ]);
}
