const path=require('node:path');
const PDFDocument=require('pdfkit');
const {fail}=require('./security-context');

function renderFinanceReportPdf(report){
  return new Promise((resolve,reject)=>{
    const pdf=new PDFDocument({autoFirstPage:false,size:'A4',layout:'landscape',bufferPages:true,pdfVersion:'1.7',margins:{top:28,bottom:32,left:32,right:32},
      info:{Title:report.title,Author:report.companyName,Creator:'HR Flow ERP',Subject:`${report.asOf} / ${report.snapshot}`,CreationDate:new Date(report.generatedAt)}});
    const chunks=[];let size=0;
    pdf.on('data',chunk=>{size+=chunk.length;if(size>5*1024*1024)pdf.destroy(new Error('PDF 출력 한도를 초과했습니다. Excel 보고서를 이용해 주세요.'));else chunks.push(chunk);});
    pdf.on('error',reject);pdf.on('end',()=>resolve(Buffer.concat(chunks)));
    try{
      pdf.registerFont('Regular',path.join(__dirname,'fonts/NotoSansKR-Regular.otf'));
      pdf.registerFont('Bold',path.join(__dirname,'fonts/NotoSansKR-Bold.otf'));
      pdf._root.data.ViewerPreferences=pdf.ref({PrintScaling:'None'});
      const left=32,width=777.89,bottom=553;let y=0,pages=0;
      const value=v=>v===null||v===undefined||v===''?'—':typeof v==='number'?v.toLocaleString('ko-KR',{maximumFractionDigits:4}):String(v);
      const measure=(v,w,size=8.5,bold=false)=>pdf.font(bold?'Bold':'Regular').fontSize(size).heightOfString(value(v),{width:w,lineGap:2});
      const text=(v,x,at,w,size=8.5,bold=false,align='left')=>pdf.font(bold?'Bold':'Regular').fontSize(size).fillColor('#1F2937').text(value(v),x,at,{width:w,lineGap:2,align});
      function page(){
        if(++pages>150)fail('resource-exhausted','PDF가 150쪽을 초과했습니다. 전체 내역은 Excel로 내려받아 주세요.');
        pdf.addPage();text(report.title,left,27,width,20,true);
        const identity=report.companyName+(report.partnerName?`  →  ${report.partnerName}`:'');
        text(identity,left,59,width,10,true);y=59+measure(identity,width,10,true)+8;
        text(`조회 기준 ${report.from?report.from+' ~ ':''}${report.asOf}${report.month?'  |  조회 월 '+report.month:''}`,left,y,width,8.5);y+=24;
        pdf.moveTo(left,y-8).lineTo(left+width,y-8).lineWidth(.7).strokeColor('#8E3284').stroke();
      }
      function ensure(height){if(y+height>bottom)page();}
      page();
      for(const note of report.notes){const h=measure(note,width,8)+5;ensure(h);text(note,left,y,width,8);y+=h;}
      y+=12;
      for(const section of report.sections){
        const sum=section.columns.reduce((n,c)=>n+c.width,0),widths=section.columns.map(c=>width*c.width/sum);
        const headerHeight=Math.max(28,...section.columns.map((c,i)=>measure(c.label,widths[i]-12,8,true)+12));
        function heading(continued=false){
          const label=section.name+(continued?' (계속)':'');text(label,left,y,width,11,true);y+=22;
          pdf.rect(left,y,width,headerHeight).fill('#F2EAF2');let x=left;
          section.columns.forEach((c,i)=>{text(c.label,x+6,y+6,widths[i]-12,8,true,c.numeric?'right':'left');x+=widths[i];});y+=headerHeight;
        }
        ensure(headerHeight+74);heading();
        const rows=section.rows.length?section.rows:[section.columns.map((_,i)=>i?'':'해당 내역 없음')];
        rows.forEach((row,index)=>{
          if(row.length!==widths.length)throw Error('Report column count mismatch');
          const h=Math.max(26,...row.map((v,i)=>measure(v,widths[i]-12)+12));
          if(y+h>bottom){page();heading(true);}
          if(y+h>bottom)fail('resource-exhausted','한 행이 인쇄 영역보다 큽니다. Excel 보고서를 이용해 주세요.');
          if(index%2)pdf.rect(left,y,width,h).fill('#F8F9FB');
          let x=left;row.forEach((v,i)=>{text(v,x+6,y+6,widths[i]-12,8.5,false,section.columns[i].numeric?'right':'left');x+=widths[i];});y+=h;
          pdf.moveTo(left,y).lineTo(left+width,y).lineWidth(.3).strokeColor('#D9DCE3').stroke();
        });
        if(section.note){const h=measure(section.note,width,8)+10;ensure(h);text(section.note,left,y+6,width,8);y+=h;}
        y+=22;
      }
      const range=pdf.bufferedPageRange();
      const generated=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',dateStyle:'short',timeStyle:'medium'}).format(new Date(report.generatedAt));
      for(let i=range.start;i<range.start+range.count;i++){
        pdf.switchToPage(i);pdf.page.margins.bottom=0;
        text(`HR Flow ERP  |  생성 ${generated} (KST)  |  자료번호 ${report.snapshot.slice(0,16)}`,left,575,width-80,7);
        text(`${i+1} / ${range.count}`,left+width-65,575,65,7,false,'right');
      }
      pdf.end();
    }catch(error){pdf.destroy();reject(error);}
  });
}
module.exports={renderFinanceReportPdf};
