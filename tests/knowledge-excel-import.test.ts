import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { importKnowledgeFile } from '../app/lib/knowledge-library-import.ts';
import { splitKnowledgeText } from '../app/lib/knowledge-library-chunks.ts';
import { KNOWLEDGE_UPLOAD_ACCEPT } from '../app/lib/knowledge-library-types.ts';

function file(sheets: Array<[string,XLSX.WorkSheet]>, extension: 'xlsx'|'xls'='xlsx', hidden=false) {
  const book=XLSX.utils.book_new();
  for(const [name,sheet] of sheets)XLSX.utils.book_append_sheet(book,sheet,name);
  if(hidden)book.Workbook={Sheets:sheets.map(([name],i)=>({name,Hidden:i?1:0}))};
  return new File([XLSX.write(book,{bookType:extension==='xls'?'biff8':'xlsx',type:'array'})],`产品资料.${extension}`);
}

test('Excel files preserve sheet names, source row addresses, formatted values and Unicode in both formats',async()=>{
  for(const extension of ['xlsx','xls'] as const){
    const sheet=XLSX.utils.aoa_to_sheet([['型号','价格','启用'],['AB-12',0,false],[],['中文产品',1250,true]]);
    sheet.B4.z='#,##0.00';
    const input=file([['产品清单',sheet],['使用说明',XLSX.utils.aoa_to_sheet([['保修期','一年']])]],extension);
    const result=await importKnowledgeFile(input);
    assert.equal(result.fileName,input.name);
    for(const value of ['工作表：产品清单','A1=型号','A2=AB-12','B2=0','C2=FALSE','第4行','1,250.00','中文产品','工作表：使用说明','保修期','一年'])assert.ok(result.text.includes(value),value);
    assert.ok(!result.text.includes('第3行'));
  }
  assert.match(KNOWLEDGE_UPLOAD_ACCEPT,/\.xlsx/);assert.match(KNOWLEDGE_UPLOAD_ACCEPT,/\.xls(?:,|$)/);
});

test('dates, leading zeros and literal cell text remain readable without HTML or formula execution',async()=>{
  const sheet=XLSX.utils.aoa_to_sheet([['日期','编号','正文'],[new Date(Date.UTC(2026,10,7)),123,'<script>alert(1)</script>\n说明']]);
  sheet.A2.z='yyyy-mm-dd';sheet.B2.z='000000';
  const result=await importKnowledgeFile(file([['日期与编码',sheet]]));
  assert.match(result.text,/2026-11-07/);assert.match(result.text,/000123/);assert.match(result.text,/<script>alert\(1\)<\/script>/);assert.match(result.text,/说明/);
});

test('formula cached values are marked and a formula without a cached result is never replaced by zero',async()=>{
  const sheet=XLSX.utils.aoa_to_sheet([['原值','缓存结果','无缓存公式'],[2,4]]);
  sheet.B2={t:'n',v:4,f:'A2*2'};sheet.C2={t:'n',f:'A2*3'};sheet['!ref']='A1:C2';
  const result=await importKnowledgeFile(file([['公式',sheet]]));
  assert.match(result.text,/B2=4/);assert.match(result.text,/C2=.*A2\*3/);assert.match(result.text,/无缓存|无保存结果/);
  assert.ok(result.warnings.some(w=>/公式/.test(w)&&/未.*计算|不.*计算/.test(w)));
});

test('hidden sheets and merged cells stay explicit instead of silently losing source content',async()=>{
  const sheet=XLSX.utils.aoa_to_sheet([['合并标题',null],['产品','甲']]);sheet['!merges']=[XLSX.utils.decode_range('A1:B1')];
  const result=await importKnowledgeFile(file([['可见',sheet],['内部表',XLSX.utils.aoa_to_sheet([['内部说明','需审批']])]],'xlsx',true));
  assert.match(result.text,/内部表.*隐藏/);assert.match(result.text,/需审批/);assert.match(result.text,/A1=合并标题/);
  assert.ok(result.warnings.some(w=>/合并/.test(w)));
});

test('empty, malformed, disguised, oversize and overlong workbooks fail without partial text',async()=>{
  await assert.rejects(importKnowledgeFile(file([['空表',{}]])),/没有.*(?:文字|内容)|空/);
  await assert.rejects(importKnowledgeFile(new File(['A,B\n1,2'],'伪装.xlsx')),/Excel|XLSX|格式/);
  await assert.rejects(importKnowledgeFile(new File(['not an XLS'],'伪装.xls')),/Excel|XLS|格式/);
  await assert.rejects(importKnowledgeFile(new File([new Uint8Array(10*1024*1024+1)],'过大.xlsx')),/10\s?MB/);
  await assert.rejects(importKnowledgeFile(file([['很长',XLSX.utils.aoa_to_sheet(Array.from({length:51},()=>['字'.repeat(20000)]))]])),/1,000,000|1000000/);
});

test('large sparse dimensions fail promptly without trusting workbook ranges or importing a prefix',async()=>{
  const sheet=XLSX.utils.aoa_to_sheet([['第一行']]);sheet.A20001={t:'s',v:'末行不应丢弃'};sheet['!ref']='A1:A20001';
  await assert.rejects(importKnowledgeFile(file([['大表',sheet]])),/行数|20,000|20000|拆分/);
});

test('both chunk strategies keep each worksheet as a separate retrievable source section',async()=>{
  const imported=await importKnowledgeFile(file([['产品',XLSX.utils.aoa_to_sheet([['型号','说明'],['AB-12','适用于室内']])],['制度',XLSX.utils.aoa_to_sheet([['条款','限制'],['第一条','不得室外使用']])]]));
  for(const strategy of ['flat','parent-child'] as const){
    const chunks=splitKnowledgeText(imported.text,strategy);
    assert.ok(chunks.some(c=>c.heading==='工作表：产品'&&c.text.includes('AB-12')));
    assert.ok(chunks.some(c=>c.heading==='工作表：制度'&&c.text.includes('不得室外使用')));
    assert.ok(chunks.every(c=>!(c.text.includes('AB-12')&&c.text.includes('不得室外使用'))));
  }
});

test('the cumulative million-character boundary includes sheet, row and cell location metadata',async()=>{
  const empty=Array.from({length:34},()=>['a']);
  const baseline=await importKnowledgeFile(file([['边界',XLSX.utils.aoa_to_sheet(empty)]]));
  const overhead=baseline.text.length-34;
  const rows=Array.from({length:33},()=>['界'.repeat(30000)]);rows.push(['末'.repeat(1_000_000-overhead-990_000)]);
  const exact=await importKnowledgeFile(file([['边界',XLSX.utils.aoa_to_sheet(rows)]]));
  assert.equal(exact.text.length,1_000_000);assert.ok(exact.text.endsWith(rows[33][0]));
  rows[33][0]+='超';
  await assert.rejects(importKnowledgeFile(file([['边界',XLSX.utils.aoa_to_sheet(rows)]])),/1,000,000|1000000/);
});

test('values hidden by an Excel number format are retained with a notice',async()=>{
 const sheet=XLSX.utils.aoa_to_sheet([['真实值'],[42],[0]]);sheet.A2.z=';;;';sheet.A3.z=';;;';
 const result=await importKnowledgeFile(file([['隐藏显示',sheet]]));
 assert.match(result.text,/A2=42/);assert.match(result.text,/A3=0/);assert.ok(result.warnings.some(w=>/显示格式/.test(w)&&/原始值/.test(w)));
});

test('worksheet lookup uses its original name while line breaks are normalized only for display',async()=>{
 const result=await importKnowledgeFile(file([['表\r\n一',XLSX.utils.aoa_to_sheet([['有效内容']])]]));
 assert.match(result.text,/有效内容/);assert.match(result.text,/## 工作表：表.*一/);
});

test('JSON-v1 serialization escapes cell delimiters, quotes and backslashes in every worksheet',async()=>{
 const literal='东街；B2=120；含"引号"、\\路径、字面\\uFF1B及\t制表符';
 for(const extension of ['xlsx','xls'] as const){
  const result=await importKnowledgeFile(file([['空置房源',XLSX.utils.aoa_to_sheet([['地址','面积','业态'],[literal,null,'餐饮']])],['在租房源',XLSX.utils.aoa_to_sheet([['地址','面积'],['西街',80]])]],extension));
  assert.equal(result.text.match(/^单元格转义：JSON-v1$/gm)?.length,2);
  const line=result.text.split('\n').find(value=>value.startsWith('第2行：A2=东街'))!;
  assert.ok(line.includes('\\uFF1BB2=120'));
  assert.ok(!line.includes('；B2=120'));
  const encoded=line.match(/^第2行：A2=(.*)；C2=餐饮$/)![1];
  assert.equal(JSON.parse('"'+encoded+'"'),literal);
 }
});
