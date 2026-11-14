// Match the authoritative decimal grammar in functions/erp-import-schema.js.
// This validates draft assistance only; the server always rechecks at commit.
export function collectionMinor(value:string,currency:string):number{
  if(!['KRW','JPY','USD','EUR','CNY'].includes(currency))throw new Error('수금 통화를 확인해 주세요.');
  const scale=['KRW','JPY'].includes(currency)?0:2,input=value.trim();
  if(input.length>40||!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(input))throw new Error('금액은 0보다 큰 숫자로 입력해 주세요. 쉼표는 세 자리 단위로 사용할 수 있습니다.');
  const [whole,fraction='']=input.replaceAll(',','').split('.');
  if(fraction.replace(/0+$/,'').length>scale)throw new Error(`${currency} 금액은 소수점 ${scale}자리 이하로 입력해 주세요. 반올림하지 않습니다.`);
  const amount=BigInt(whole)*10n**BigInt(scale)+BigInt((fraction.slice(0,scale)+'0'.repeat(scale)).slice(0,scale)||'0');
  if(amount<=0n||amount>9000000000000n)throw new Error('금액은 0보다 크고 허용 범위 이내여야 합니다.');
  return Number(amount);
}
export function collectionDraft(input:{mode:'NEW'|'EXISTING';amount?:string;currency:string;lines:{amount:string}[]},available:number){
  try{
    const lines=input.lines.filter(l=>l.amount.trim());
    if(lines.length>50)throw new Error('한 번에 배분할 수 있는 출고 문서는 최대 50건입니다.');
    const total=lines.reduce((sum,l)=>sum+collectionMinor(l.amount,input.currency),0);
    const source=input.mode==='NEW'?collectionMinor(input.amount||'',input.currency):available;
    if(!Number.isSafeInteger(source)||source<=0)throw new Error('배분할 입금액 또는 재사용할 수금을 선택해 주세요.');
    return {source,total,remaining:source-total,error:''};
  }catch(e){return {source:null,total:null,remaining:null,error:e instanceof Error?e.message:'배분액을 확인해 주세요.'};}
}
