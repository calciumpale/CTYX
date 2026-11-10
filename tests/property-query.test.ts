import test from 'node:test';
import assert from 'node:assert/strict';
import {isPropertyQuestion,parsePropertyQuery,matchPropertyRows,formatPropertyAnswer} from '../app/lib/property-query.ts';
import {parsePropertySources} from '../app/lib/property-records.ts';
const source=(title:string,text:string)=>({documentId:title,title,fileName:title+'.xlsx',libraryId:'zs',libraryName:'招商',text,updatedAt:'2026-11-11'});
const rows=()=>parsePropertySources([
 source('空置房源','## 工作表：空置商铺表\n第1行：A1=区块；B1=地址；C1=面积；D1=建议业态\n第2行：A2=绮园商业街；B2=5-2号商铺；C2=128.00；D2=轻餐饮\n第3行：A3=绮园商业街；B3=5-5号商铺；C3=192.00；D3=轻餐饮\n第4行：A4=绮园商业街；B4=3-3-2号商铺；C4=86.00；D4=茶饮咖啡\n第5行：A5=东门好邻居168；B5=城东路490号；C5=128.00；D5=轻餐饮\n第6行：A6=绮园商业街；B6=禁止号；C6=150；D6=不可做餐饮\n第7行：A7=绮园商业街；B7=未知号；D7=轻餐饮'),
 source('在租房源','## 工作表：履约商铺表\n第1行：A1=区块；B1=地址；C1=面积；D1=建议业态\n第2行：A2=绮园商业街；B2=已租号；C2=120；D2=轻餐饮')]);
test('property routing recognizes lookup and leaves customer/company questions alone',()=>{
 assert.equal(isPropertyQuestion('帮我找空置房源'),true);assert.equal(isPropertyQuestion('找绮园100到200平轻餐饮商铺'),true);
 assert.equal(isPropertyQuestion('分析这家公司的扩张需求'),false);assert.equal(isPropertyQuestion('商铺合同的违约条款怎么改'),false);
});
test('filters full records by vacancy, area, usage and location together with original row provenance',async()=>{
 const data=rows();const query=await parsePropertyQuery('找绮园商业街100到200平可以做轻餐饮的空置房源',data);
 const matches=matchPropertyRows(data,query);assert.deepEqual(matches.map(x=>x.rowLabel),['第2行','第3行']);
 const answer=formatPropertyAnswer(matches,query,{complete:true,issues:[],sourceCount:2});
 assert.match(answer.answer,/5-2号商铺/);assert.match(answer.answer,/5-5号商铺/);assert.match(answer.answer,/空置房源.xlsx/);assert.match(answer.answer,/第2行/);assert.doesNotMatch(answer.answer,/已租号|禁止号|未知号|城东路/);
});
test('area boundaries, rented scope and unknown values never expand into vacancy matches',async()=>{
 const data=rows();const above=await parsePropertyQuery('绮园的空置商铺大于128平，轻餐饮',data);
 assert.deepEqual(matchPropertyRows(data,above).map(x=>x.rowLabel),['第3行']);
 const rented=await parsePropertyQuery('绮园在租房源100-150平方米',data);assert.deepEqual(matchPropertyRows(data,rented).map(x=>x.source.title),['在租房源']);
 const none=await parsePropertyQuery('绮园空置商铺1000平以上',data);assert.equal(matchPropertyRows(data,none).length,0);
});
test('negated usage, approximate areas and absent fields are not silently treated as exact matches',async()=>{
 const data=rows();const q=await parsePropertyQuery('绮园空置商铺，100平左右，做重餐饮',data);assert.ok(q.clarification);
 const q2=await parsePropertyQuery('绮园空置商铺，租金不超过5000元',data);assert.ok(q2.clarification);
 const no=await parsePropertyQuery('绮园空置商铺100-200平，餐饮',data);assert.equal(matchPropertyRows(data,no).some(x=>x.raw.includes('禁止号')),false);
});
test('model extraction cannot invent or drop deterministic constraints and unknown location gives no match',async()=>{
 const data=rows();const q=await parsePropertyQuery('找西湖区100到200平轻餐饮空置商铺',data,async()=>JSON.stringify({filters:[{field:'location',value:'西湖区'},{field:'usage',value:'火锅'}]}));
 assert.equal(matchPropertyRows(data,q).length,0);assert.equal(q.groups.some(x=>x.values.includes('轻餐饮')),true);assert.equal(q.groups.some(x=>x.values.includes('火锅')),false);
});
test('paging preserves multiple matches and reports incomplete coverage truthfully',async()=>{
 const data=rows();const q=await parsePropertyQuery('所有空置房源',data);q.pageSize=2;
 const all=matchPropertyRows(data,q);const first=formatPropertyAnswer(all,q,{complete:false,issues:['部分文件读取失败'],sourceCount:2});
 assert.equal(first.rows.length,2);assert.match(first.answer,/未完成|未能完整/);assert.match(first.answer,/下一页/);
 const second=formatPropertyAnswer(all,{...q,page:2},{complete:true,issues:[],sourceCount:2});assert.equal(second.rows[0].id,all[2].id);
});

test('never drops negated status, unitless labeled area, intersected bounds or unknown requirements',async()=>{
 const data=rows();
 for(const text of ['不要空置房源，只看商铺','只要未出租房源','空置房源，面积100-120','至少150平且不少于100平的空置房源','空置房源，做花店','找紫竹里100到200平空置房源','不低于100且小于200平空置房源','2亩以上空置房源','小于100平方英尺的空置房源']){
  const q=await parsePropertyQuery(text,data);const m=matchPropertyRows(data,q);
  if(text==='不要空置房源，只看商铺')assert.ok(m.every(r=>r.status!=='vacant'),text);
  if(text==='只要未出租房源')assert.ok(m.every(r=>r.status==='vacant'),text);
  if(text==='空置房源，面积100-120')assert.equal(m.length,0,text);
  if(text==='至少150平且不少于100平的空置房源')assert.ok(m.every(r=>r.area!.min>=150),text);
  if(/花店|紫竹里/.test(text))assert.equal(m.length,0,text);
  if(text==='不低于100且小于200平空置房源')assert.ok(m.every(r=>r.area!.min>=100&&r.area!.max<200),text);
  if(/亩|英尺/.test(text))assert.ok(q.clarification,text);
 }
});
test('OR stays in its own field and numeric addresses never match a longer identifier',async()=>{
 const data=parsePropertySources([source('空置房源','区块,楼层,地址,面积,建议业态\n甲园,1楼,5-2号商铺,100,轻餐饮\n乙园,1楼,15-2号商铺,100,咖啡\n甲园,2楼,6-2号商铺,100,咖啡\n甲园,11楼,15-2号商铺,100,餐饮：禁止')]);
 const q=await parsePropertyQuery('空置房源，甲园、1楼都要，轻餐饮或咖啡',data);assert.deepEqual(matchPropertyRows(data,q).map(r=>r.fields.find(f=>f.label==='地址')!.value),['5-2号商铺']);
 const q2=await parsePropertyQuery('找1楼空置商铺',data);assert.equal(matchPropertyRows(data,q2).some(r=>r.location!.includes('11楼')),false);
 const q3=await parsePropertyQuery('找5-2号商铺的空置房源',data);assert.equal(matchPropertyRows(data,q3).some(r=>r.location!.includes('15-2号')),false);
 const q4=await parsePropertyQuery('餐饮空置房源',data);assert.equal(matchPropertyRows(data,q4).some(r=>r.usage==='餐饮：禁止'),false);
});

test('ordinary conversational wording and labeled unitless ranges retain the actual mandatory filters',async()=>{
 const data=rows();
 for(const text of ['给我找一下绮园商业街100到200平轻餐饮空置商铺','帮我看看现在有什么绮园商业街的空置商铺，面积在100到200之间，做轻餐饮']){
  const q=await parsePropertyQuery(text,data);assert.deepEqual(matchPropertyRows(data,q).map(r=>r.rowLabel),['第2行','第3行'],JSON.stringify(q));
 }
});
