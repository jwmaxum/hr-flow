import { buildErpWorkbook } from './erpWorkbook';
import type { Cell } from './erpWorkbook';
import type { PayrollResult } from './payroll';
import type { UserData } from '../store/authStore';

export interface PreviewPayrollExcelRow {
  employee: UserData;
  divisionName: string;
  teamName: string;
  result: PayrollResult | null;
  employmentInsuranceIncluded: boolean;
}

function payrollTypeLabel(result: PayrollResult | null, employmentInsuranceIncluded: boolean): string {
  if (result?.isIrregular) {
    return result.withholdingTaxRate === '8.8' ? '비정규 (기타소득 8.8%)' : '비정규 (사업소득 3.3%)';
  }
  return employmentInsuranceIncluded ? '정규직 (근로소득)' : '정규직 (고용보험 제외)';
}

/** Generates a full-company estimated payroll ledger .xlsx workbook prior to approval. */
export async function buildEstimatedPayrollWorkbook(params: {
  companyName: string;
  year: number;
  month: number;
  rows: PreviewPayrollExcelRow[];
}): Promise<Blob> {
  const { companyName, year, month, rows } = params;
  const header: Cell[] = [
    '성명', '본부', '팀', '입사일', '급여구분',
    '기본급·과세수당', '상여금', '비과세액', '지급합계',
    '국민연금', '건강보험', '고용보험', '장기요양', '소득세', '지방소득세',
    '공제합계', '예상 차인지급액',
  ];
  const sums = {
    basePay: 0, bonus: 0, nonTaxable: 0, monthlyGross: 0,
    pension: 0, health: 0, employment: 0, longTerm: 0,
    incomeTax: 0, localTax: 0, totalDeductions: 0, netPay: 0,
  };
  const bodyRows: Cell[][] = rows.map(({ employee, divisionName, teamName, result, employmentInsuranceIncluded }) => {
    const basePay = result ? result.monthlyGross - result.nonTaxable : 0;
    const bonus = result?.bonus ?? 0;
    const nonTaxable = result?.nonTaxable ?? 0;
    const monthlyGross = result?.monthlyGross ?? 0;
    const pension = result?.pension ?? 0;
    const health = result?.health ?? 0;
    const employment = result?.employment ?? 0;
    const longTerm = result?.longTerm ?? 0;
    const incomeTax = result?.incomeTax ?? 0;
    const localTax = result?.localTax ?? 0;
    const totalDeductions = result?.totalDeductions ?? 0;
    const netPay = result?.netPay ?? 0;

    sums.basePay += basePay;
    sums.bonus += bonus;
    sums.nonTaxable += nonTaxable;
    sums.monthlyGross += monthlyGross;
    sums.pension += pension;
    sums.health += health;
    sums.employment += employment;
    sums.longTerm += longTerm;
    sums.incomeTax += incomeTax;
    sums.localTax += localTax;
    sums.totalDeductions += totalDeductions;
    sums.netPay += netPay;

    return [
      employee.name || '',
      divisionName,
      teamName,
      employee.joinDate ? employee.joinDate.slice(0, 10) : '',
      payrollTypeLabel(result, employmentInsuranceIncluded),
      basePay, bonus, nonTaxable, monthlyGross,
      pension, health, employment, longTerm, incomeTax, localTax,
      totalDeductions, netPay,
    ];
  });

  const totalRow: Cell[] = [
    `합계 (${rows.length}명)`, '', '', '', '',
    sums.basePay, sums.bonus, sums.nonTaxable, sums.monthlyGross,
    sums.pension, sums.health, sums.employment, sums.longTerm, sums.incomeTax, sums.localTax,
    sums.totalDeductions, sums.netPay,
  ];

  const infoRows: Cell[][] = [
    ['항목', '내용'],
    ['회사명', companyName || '회사'],
    ['귀속연월', `${year}년 ${month}월`],
    ['상태', '확정 전 예상 급여대장 (현재 입력·저장 설정 기준)'],
    ['대상 인원', rows.length],
    ['총 지급액(원)', sums.monthlyGross],
    ['총 공제액(원)', sums.totalDeductions],
    ['예상 실지급액 합계(원)', sums.netPay],
  ];

  return buildErpWorkbook([
    {
      name: `${year}년_${String(month).padStart(2, '0')}월_예상급여대장`,
      rows: [header, ...bodyRows, totalRow],
      widths: [14, 14, 14, 12, 22, 16, 14, 14, 16, 14, 14, 14, 14, 14, 14, 16, 16],
    },
    {
      name: '급여대장 정보',
      rows: infoRows,
      widths: [20, 44],
    },
  ]);
}
