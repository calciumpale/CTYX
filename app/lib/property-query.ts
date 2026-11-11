import type {PropertyRow} from './property-records.ts';

export interface PropertyFilterGroup {field:'location'|'usage'|'keyword';values:string[];exclude?:boolean;}
export interface PropertyQuery {status:'vacant'|'rented'|'any';minArea?:number;maxArea?:number;minExclusive?:boolean;maxExclusive?:boolean;groups:PropertyFilterGroup[];page:number;pageSize:number;clarification?:string;}
const propertySubjects='(?:商铺|房源|铺位|门面|店面|店铺)';
const propertySubjectOnly=new RegExp(`^${propertySubjects}$`);
const propertyClauses=/[\n，。！？；,!?;]/;
const propertySearch=new RegExp(`(?:查找|查询|筛选|推荐|找).{0,24}${propertySubjects}(?=$|\\s|出租|可租|招租|还有|有吗|有没有)`);
const propertyAvailability=new RegExp(`(?:有没有|是否有|有无|还有)(?:合适的?|可租的?|空置的?)?${propertySubjects}(?=$|\\s|出租|可租|招租|[吗么])|有(?:合适的?|可租的?|空置的?)?${propertySubjects}(?:出租|可租|招租)?[吗么]|${propertySubjects}(?:还有吗|有没有|能租吗|可租吗|出租吗)`);
const declinedPropertySearch=/(?:不(?:再|用|想|打算|准备|需要|要)?|没(?:想|打算)?|别|停止)(?:再|继续|帮我|去)*(?:在.{2,16})?\s*(?:查找|查询|筛选|推荐|找)/;
const locationBeforeSearch=new RegExp(`^\\s*(?:我们?\\s*)?(?:(?:想要|想|要|打算|希望|计划)\\s*)?在\\s*([\\p{Script=Han}A-Za-z\\d·-]{2,24}?)\\s*(?:查找|查询|筛选|找)\\s*(?:一个|一间|个)?\\s*${propertySubjects}(?=$|\\s|出租|可租|招租)`,'u');
const locationBeforeAvailability=/^(?:请问\s*)?(?:在\s*)?([\p{Script=Han}A-Za-z\d·-]{2,24}?)\s*(?:还有|有没有|是否有|有无|有)\s*(?:合适的?|可租的?|空置的?)?店铺(?:出租|可租|招租)?[吗么]?$/u;
const nonLocationSubject=/^(?:你们?|您|我们?|咱们?|这边|那边|这里|那里|附近|周边|目前|现在)$/;

export function isPropertyInventoryInquiry(text:string):boolean {
 return text.split(propertyClauses).some(part=>{
  const clause=part.trim();
  return !declinedPropertySearch.test(clause)&&(propertySearch.test(clause)||propertyAvailability.test(clause));
 });
}
export const isPropertyQuestion=(text:string)=>{
 if(/合同|违约|税费|税率|政策|制度|纠纷|风险/.test(text)&&!/筛选|推荐|找.{0,30}(?:空置|在租|房源|铺位)/.test(text))return false;
 return /空置(?:房源|商铺|铺位)?|空铺|在租房源|履约商铺/.test(text)||/(?:商铺|房源|铺位|门面|店面)/.test(text)||isPropertyInventoryInquiry(text);
};
const normalize=(s:string)=>s.normalize('NFKC').toLowerCase().replace(/\s/g,'');
const unit='(?:平方米|平米|㎡|m²|m2|平)';
const number='(\\d+(?:,\\d{3})*(?:\\.\\d+)?)';
const usageWords=['重餐饮','轻餐饮','茶饮咖啡','茶饮','咖啡','奶茶','餐饮','运动健身','健身','文化休闲','生活服务','生鲜零售','社区便利店','便利店','超市','零售','服装','美容','美发','医疗健康','医美','药店','教育培训','培训','教育','办公服务','办公','数码通讯','汽修','宠物','火锅','烧烤','花店'];
const locationFields=/区块|区域|位置|地址|坐落|地段|项目|楼层|楼栋|商圈|园区|街区/;
const emptyValue=/^(?:未知|待定|待确认|待补充|暂无|无|[-—/]+)$/;
const positive=(text:string,term:string)=>{
 const t=normalize(text),v=normalize(term).replace(/(?:店|馆)$/,'');let from=0;
 while(from<t.length){const index=t.indexOf(v,from);if(index<0)return false;
  const before=t.slice(Math.max(0,index-12),index).replace(/[：:，,、;；·\s]/g,'');const after=t.slice(index+v.length,index+v.length+8).replace(/^[：:\s]+/,'');
  const numericBoundary=/^[\da-z]/.test(v)&&/[\da-z]$/.test(t.slice(0,index))||/[\da-z]$/.test(v)&&/^[\da-z]/.test(t.slice(index+v.length));
  if(!numericBoundary&&!/(?:不可|不允许|不接受|不能|禁止|不得|不做|不适合|不支持|不含|不提供|非|无|否|不)(?:做|经营|用于|开展|支持|含|有)*(?:轻|重)?$/.test(before)&&! /^(?:不可|不允许|禁止|不适合|不能|否)/.test(after))return true;
  from=index+Math.max(v.length,1);
 }return false;
};
const negated=(q:string,index:number)=>/(?:不要|不是|不想要|不需要|不选|不接受|不做|不考虑|排除|不含|非)(?:做|经营|的)?(?:[^，。；;]{0,18}[、和或])?$/.test(q.slice(Math.max(0,index-24),index).replace(/\s/g,''));
function addGroup(groups:PropertyFilterGroup[],field:PropertyFilterGroup['field'],value:string,exclude=false){
 value=value.trim();if(!value||value.length>80)return;
 if(!groups.some(g=>g.field===field&&!!g.exclude===exclude&&g.values.some(v=>normalize(v)===normalize(value))))groups.push({field,values:[value],...(exclude?{exclude:true}:{})});
}
function locationTerms(question:string,rows:PropertyRow[]):string[]{
 const q=normalize(question);const values=[...new Set(rows.flatMap(row=>row.fields.filter(f=>locationFields.test(f.label)).map(f=>normalize(f.value))))];
 // Index bounded user substrings once; scanning large source tables never nests over every query substring.
 type Node={children:Map<string,Node>};const root:Node={children:new Map()};
 for(let start=0;start<q.length;start++){let node=root;for(let end=start;end<Math.min(q.length,start+28);end++){const char=q[end];if(!/[\p{Script=Han}a-z0-9·-]/u.test(char))break;let child=node.children.get(char);if(!child){child={children:new Map()};node.children.set(char,child);}node=child;}}
 const found=new Set<string>();
 for(const value of values)for(let start=0;start<value.length;start++){let node=root,end=start;while(end<value.length&&end-start<28){const child=node.children.get(value[end]);if(!child)break;node=child;end++;}if(end-start>=2)found.add(value.slice(start,end));}
 const terms=[...found].filter(term=>/[\p{Script=Han}]/u.test(term)&&! /^(?:商铺|房源|空置|在租|面积|业态|位置|地址|以上|以下|左右|附近|可以|适合|需要|租金|建议|帮我|有哪些|有没有|所有)$/.test(term)&&!usageWords.some(u=>normalize(u).includes(term)));
 return terms.filter(term=>!terms.some(other=>other!==term&&other.includes(term)));
}
/** Model filters must quote the user exactly; unresolved constraints remain conservative keyword filters. */
export async function parsePropertyQuery(question:string,rows:PropertyRow[],extract?: (question:string)=>Promise<string>):Promise<PropertyQuery>{
 const q=question.normalize('NFKC').slice(0,2000);let remainder=q;const consume=(s:string)=>{remainder=remainder.split(s).join(' ');};
 const result:PropertyQuery={status:'any',groups:[],page:1,pageSize:10};
 const statuses:{status:'vacant'|'rented';exclude:boolean}[]=[];
 for(const m of q.matchAll(/未出租|待出租|已出租|空置|空铺|待租|可租|招租|在租|已租|履约/g))statuses.push({status:/^(?:在租|已租|已出租|履约)$/.test(m[0])?'rented':'vacant',exclude:negated(q,m.index!)});
 const allowed=new Set<'vacant'|'rented'>(['vacant','rented']);const included=new Set(statuses.filter(s=>!s.exclude).map(s=>s.status));
 if(included.size===1)for(const status of allowed)if(!included.has(status))allowed.delete(status);
 for(const status of statuses.filter(s=>s.exclude))allowed.delete(status.status);
 result.status=allowed.size===1?[...allowed][0]:'any';if(!allowed.size)result.clarification='空置和在租都被排除了，请确认要查询哪类房源。';
 const lower=(n:number,exclusive=false)=>{if(result.minArea===undefined||n>result.minArea){result.minArea=n;result.minExclusive=exclusive;}else if(n===result.minArea)result.minExclusive=!!result.minExclusive||exclusive;};
 const upper=(n:number,exclusive=false)=>{if(result.maxArea===undefined||n<result.maxArea){result.maxArea=n;result.maxExclusive=exclusive;}else if(n===result.maxArea)result.maxExclusive=!!result.maxExclusive||exclusive;};
 const toNumber=(s:string)=>Number(s.replaceAll(',',''));
 if(/(?<![0-9])-\d+(?:\.\d+)?\s*(?:平|㎡)/.test(q))result.clarification='面积须为正数，请确认面积范围。';
 if(/亩|公顷|英尺|平方尺|平方公里|km2|ft2/i.test(q))result.clarification='请把面积换算并明确为平方米后查询，暂不混用不同面积单位。';
 if(/\d\s*(?:万|千|百)\s*(?:平|㎡)/.test(q))result.clarification='请用完整数字写明平方米数，例如 10000 平方米。';
 const ranges=[...q.matchAll(new RegExp('(?:面积\\s*[:：=为]?\\s*)?'+number+'\\s*('+unit+')?\\s*(?:到|至|[-~～—–])\\s*'+number+'\\s*('+unit+')?','gi'))];
 for(const m of ranges){if(!m[2]&&!m[4]&&!m[0].includes('面积')&&!/面积(?:在|为|是|[:：])?\s*$/.test(q.slice(Math.max(0,m.index!-12),m.index)))continue;lower(toNumber(m[1]));upper(toNumber(m[3]));consume(m[0]);}
 const bounds=new RegExp('(?:面积\\s*[:：=为]?\\s*)?(大于等于|小于等于|不少于|不低于|不小于|不超过|不大于|小于|大于|超过|低于|至少|最多|最大|最小|>=|<=|≥|≤|>|<)?\\s*'+number+'\\s*('+unit+')?\\s*(以上|以下|以内|以外|起|左右|上下|附近)?','gi');
 for(const m of [...remainder.matchAll(bounds)]){if(!m[1]&&!m[3]&&!m[0].includes('面积')&&!/面积(?:在|为|是|[:：])?\s*$/.test(remainder.slice(Math.max(0,m.index!-12),m.index)))continue;const n=toNumber(m[2]),prefix=m[1]??'',post=m[4]??'';
  if(/左右|上下|附近|以外/.test(post)){result.clarification='“'+m[0].trim()+'”的面积范围不明确，请给出可接受的最小和最大面积。';consume(m[0]);continue;}
  if(/不超过|不大于|小于等于|最多|最大|<=|≤/.test(prefix)||/以下|以内/.test(post))upper(n);
  else if(/不少于|不低于|不小于|大于等于|至少|最小|>=|≥/.test(prefix)||/以上|起/.test(post))lower(n);
  else if(/小于|低于|</.test(prefix))upper(n,true);
  else if(/大于|超过|>/.test(prefix))lower(n,true);
  else {lower(n);upper(n);}
  consume(m[0]);
 }
 if(result.minArea!==undefined&&result.maxArea!==undefined&&(result.minArea>result.maxArea||result.minArea===result.maxArea&&(result.minExclusive||result.maxExclusive)))result.clarification='面积条件没有共同范围，请确认最小和最大面积。';
 if(/(?:面积|平米|平方米).{0,5}[一二三四五六七八九十百千万两]|[一二三四五六七八九十百千万两]+(?:平|平方米|㎡)/.test(q)&&result.minArea===undefined&&result.maxArea===undefined)result.clarification='请用数字写明面积范围，例如 100–200 平方米。';
 if(/(?:不在|不要|排除).{0,8}\d.{0,10}(?:平|㎡)|\d.{0,10}(?:平|㎡).{0,3}或.{0,10}\d/.test(q))result.clarification='暂不自动放宽或排除多个面积区间，请明确一个可接受的面积范围。';
 if(/租金|月租|年租|单价|预算|租赁到期|到期时间|层高|开间|进深|地铁|步行|距离/.test(q))result.clarification='这次还包含租金、到期时间、尺寸或距离等条件，请先明确要按哪个字段和范围筛选。面积、业态与位置可以直接组合查询。';
 const usages:string[]=[];
 for(const word of usageWords)for(const m of q.matchAll(new RegExp(word,'g'))){if(usages.some(old=>old.includes(word)))continue;usages.push(word);addGroup(result.groups,'usage',word,negated(q,m.index!));}
 for(const m of q.matchAll(/(?:做|经营|业态(?:为|是|[:：])|开一家|开个)([\p{Script=Han}]{2,12})/gu)){const value=m[1].replace(/(?:的|空置|房源|商铺|铺位|可以|可做|能做).*$/,'');if(value&&!usages.some(u=>u.includes(value)||value.includes(u)))addGroup(result.groups,'usage',value,negated(q,m.index!));}
 for(const term of locationTerms(q,rows))addGroup(result.groups,'location',term,negated(q,q.indexOf(term)));
 for(const clause of q.split(propertyClauses)){
  const location=locationBeforeSearch.exec(clause)?.[1]??locationBeforeAvailability.exec(clause.trim())?.[1];
  if(location&&!nonLocationSubject.test(location))addGroup(result.groups,'location',location);
 }
 for(const m of q.matchAll(/\d+(?:楼|层)|\d+(?:-\d+)+号(?:商铺)?/g))if(!result.groups.some(g=>g.field==='location'&&g.values.some(v=>v.includes(m[0]))))addGroup(result.groups,'location',m[0],negated(q,m.index!));
 if(extract)try{
  const raw=JSON.parse((await extract(q)).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')) as {filters?:{field?:unknown;value?:unknown}[]};
  for(const f of (raw.filters??[]).slice(0,20)){if((f.field!=='location'&&f.field!=='usage'&&f.field!=='keyword')||typeof f.value!=='string'||!q.includes(f.value)||f.value.length<2)continue;
   const value=f.value;if(propertySubjectOnly.test(value)||result.groups.some(g=>g.values.some(v=>v.includes(value))))continue;addGroup(result.groups,f.field,value,negated(q,q.indexOf(value)));
  }
 }catch{/* Original user constraints below still remain filters if the model is unavailable. */}
 for(const group of result.groups)for(const value of group.values)consume(value);
 // A fresh query condition we cannot classify is still mandatory, rather than being ignored.
 remainder=remainder.replace(/店铺(?:(?:能租|出租)(?=[吗么]))?/g,' ');
 remainder=remainder.replace(/现在|目前|现有|有什么|什么|麻烦|请问|给我|给|我|您|你|一间|一套|一处|合适|适宜|符合|能不能|能否|可不可以|用来|用作|之间|大致/g,' ').replace(/第\s*\d+\s*页/g,'').replace(/未出租|待出租|已出租|空置|空铺|待租|可租|招租|在租|已租|履约|房源|商铺|铺位|门面|店面/g,'').replace(/请帮我|帮我|帮忙|我想要|我想找|我需要|我想|我要|需要|想要|一个|一些|几条|几家|一下|查找|查一下|查询|搜索|筛选|推荐|看看|看下|还有没有|有没有|哪些|哪里|还有哪些|还有|再加个条件|再加个|再加|加上|只看|再找|下一页|上一页|改成|换成|只要|至少|不少于|不低于|不超过|以内|以上|以下|最多|不要|不考虑|排除|不限|都要|都可以|可以|能够|适合|用于|经营|业态|位置|地址|区域|面积|全部|所有|同时|满足|条件|的|在|找|做|且|和|或|能|可|有|吗|呢|么|那|是|为/g,' ');
 if(/\d+\s*(?:-|到|至|~|～)\s*\d+/.test(remainder))result.clarification='请说明这组数字是面积范围还是商铺地址，并注明面积单位。';
 for(const term of remainder.split(/[\s，,。；;、？！?!:：]+/).filter(s=>s.length>=2))if(!/^[-—~\d.]+$/.test(term))addGroup(result.groups,'keyword',term);
 // OR only combines adjacent alternatives in the same field. It never changes other constraints.
 for(const field of ['location','usage'] as const){const ordered=result.groups.filter(g=>g.field===field&&!g.exclude).sort((a,b)=>q.indexOf(a.values[0])-q.indexOf(b.values[0]));
  for(let i=0;i<ordered.length-1;i++){const a=ordered[i],b=ordered[i+1];const between=q.slice(q.indexOf(a.values.at(-1)!)+a.values.at(-1)!.length,q.indexOf(b.values[0]));if(between.length<8&&/或/.test(between)&&!/[，。；且和]/.test(between)){a.values.push(...b.values);result.groups=result.groups.filter(g=>g!==b);ordered.splice(i+1,1);i--;}}
 }
 const page=q.match(/第\s*(\d+)\s*页/);if(page)result.page=Math.max(1,Math.min(10000,Number(page[1])));
 return result;
}
export function matchPropertyRows(rows:PropertyRow[],query:PropertyQuery):PropertyRow[]{
 if(query.clarification)return [];
 return rows.filter(row=>{
  if(row.statusConflict||query.status!=='any'&&row.status!==query.status)return false;
  if(query.minArea!==undefined||query.maxArea!==undefined){const area=row.area;if(!area||area.approximate)return false;
   if(query.minArea!==undefined&&(query.minExclusive?area.min<=query.minArea:area.min<query.minArea))return false;
   if(query.maxArea!==undefined&&(query.maxExclusive?area.max>=query.maxArea:area.max>query.maxArea))return false;
  }
  return query.groups.every(g=>{
   const value=g.field==='location'?row.location:g.field==='usage'?row.usage:row.fields.map(f=>f.value).join('；');
   if(!value||emptyValue.test(value))return false;const hits=g.values.some(v=>positive(value,v));return g.exclude?!hits:hits;
  });
 });
}
const safeText=(s:string)=>s.replace(/(?<![\w.+-])[\w.+-]+@[\w.-]+\.[a-z]{2,24}/gi,'[邮箱]').replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g,'[手机号]').replace(/(?:微信号?|wechat|vx)[：:\s]*[A-Za-z][A-Za-z0-9_-]{5,19}/gi,'微信[账号]').replace(/[\\`*_{}\[\]<>|]/g,'\\$&').replace(/\r?\n/g,' ↵ ');
export function formatPropertyAnswer(matches:PropertyRow[],query:PropertyQuery,coverage:{complete:boolean;issues:string[];sourceCount:number},maxChars=12000):{answer:string;rows:PropertyRow[]}{
 const limit=Math.max(0,Math.floor(Number.isFinite(maxChars)?maxChars:12000));
 const scope={vacant:'空置房源',rented:'在租房源',any:'空置及在租房源'}[query.status];
 const compact=limit<500;
 const notice=compact?'按上传记录，实际状态待核实。':'依据已上传房源表记录，实际可租状态需再次核实。';
 const choose=(options:string[])=>options.find(text=>text.length<=limit)??'';
 const insufficient=()=>({answer:choose(['回答长度不足以完整展示房源，请增加回答长度后重试。','回答长度不足。','长度不足。']),rows:[] as PropertyRow[]});
 if(query.clarification)return {answer:choose([query.clarification,'筛选条件尚不明确，请确认具体字段与范围。','请明确筛选条件。']),rows:[]};
 if(!coverage.sourceCount)return {answer:choose([`当前有权访问的知识库中没有可读取的${scope}表。请检查文件所属知识库与解析状态。`,`未能读取有权访问的${scope}表，请检查解析状态。`,'未能读取房源资料。']),rows:[]};
 let warning=coverage.complete?'':compact?'资料未读全，以下仅为已读取部分。\n\n':'本次未能完整核对所有房源资料，以下仅为已读取部分的结果；不能据此断言没有其他房源。';
 if(!coverage.complete&&!compact){
  // Include whole issue messages only; long diagnostics must not consume the row budget.
  const issueBudget=Math.min(400,Math.floor(limit/10));let details='';
  for(const issue of coverage.issues.slice(0,3)){const text=safeText(issue);if(details.length+text.length+1<=issueBudget)details+=(details?'；':'')+text;}
  warning+=(details?' '+details:'')+'\n\n';
 }
 if(!matches.length)return {answer:choose([
  warning+`在已读取的${scope}表中，未找到同时满足这些条件且字段明确的条目。未放宽面积、业态或位置条件。\n\n${notice}`,
  warning+`已读取的${scope}中未找到字段明确的匹配条目。${notice}`,
  coverage.complete?'未找到字段明确的匹配房源。':'房源资料未读全；已读取部分未找到明确匹配。',
 ]),rows:[]};
 const requestedPage=Math.max(1,Math.floor(Number.isFinite(query.page)?query.page:1));
 const pageSize=Math.max(1,Math.min(100,Math.floor(Number.isFinite(query.pageSize)?query.pageSize:10)));
 const unitsNotice=compact?'原表面积未标单位，请核对。\n':'原表“面积”未标单位，已按原始数值筛选，请核对单位。\n';
 const header=(page:number,pages:number,count:number)=>compact
  ?`${scope}：${matches.length}条；第${page}/${pages}页，本页${count}条。\n\n`
  :`${scope}筛选：${coverage.complete?'共找到':'已读取部分找到'} ${matches.length} 条符合条件的记录，第 ${page}/${pages} 页，本页列出 ${count} 条。\n\n`;
 const next=(page:number,remaining:number)=>compact
  ?`\n还有${remaining}条，可问“下一页”或“第${page+1}页”。`
  :`\n当前第 ${page} 页，还有 ${remaining} 条，可继续问“下一页”或“第 ${page+1} 页”。`;
 // Reserve the largest possible metadata before partitioning. Every later page is
 // computed from the same boundaries, rather than jumping by a fixed row offset.
 const maxIndex=matches.length;
 const metadataSize=warning.length+header(maxIndex,maxIndex,maxIndex).length+notice.length+next(maxIndex,maxIndex).length+
  (matches.some(row=>row.area?.unit==='unspecified')?unitsNotice.length:0);
 const bodyLimit=limit-metadataSize;
 if(bodyLimit<1)return insufficient();
 type Page={rows:PropertyRow[];entries:string[];length:number;end:number};
 const pages:Page[]=[];let current:Page={rows:[],entries:[],length:0,end:0};
 for(const [index,row] of matches.entries()){
  const number=index+1;
  let entry=`### ${number}. ${safeText(row.fields.find(f=>/区块|项目|名称|铺号|编号/.test(f.label))?.value??row.source.title)}\n\n`+
   row.fields.map(f=>`- ${safeText(f.label)}：${safeText(f.value||'未填写')}`).join('\n')+
   `\n- 表中分类：${{vacant:'空置',rented:'在租',unknown:'未明确'}[row.status]}\n- 来源：${safeText(row.source.fileName||row.source.title)} · ${safeText(row.section)} · ${safeText(row.rowLabel)}${row.source.updatedAt?'；文件更新时间：'+safeText(row.source.updatedAt):''}\n\n`;
  if(entry.length>bodyLimit){
   const origin=`${safeText(row.source.fileName||row.source.title)} · ${safeText(row.section)} · ${safeText(row.rowLabel)}`;
   entry=[
    `### ${number}. 原始条目过长\n\n本页无法完整展示，请在参考来源中查看原表记录。\n来源：${origin}\n\n`,
    `${number}. 原始条目过长，请查看对应参考来源中的原表记录。\n\n`,
    `${number}. 原文过长，请查看来源。\n\n`,
   ].find(text=>text.length<=bodyLimit)??'';
   if(!entry)return insufficient();
  }
  if(current.rows.length&&(current.rows.length>=pageSize||current.length+entry.length>bodyLimit)){
   pages.push(current);current={rows:[],entries:[],length:0,end:0};
  }
  current.rows.push(row);current.entries.push(entry);current.length+=entry.length;current.end=number;
 }
 if(current.rows.length)pages.push(current);
 const selected=pages[requestedPage-1];
 if(!selected)return {answer:choose([
  warning+`${scope}共 ${matches.length} 条匹配记录，只有 ${pages.length} 页。请查询第 1 至 ${pages.length} 页。\n${notice}`,
  `${scope}只有${pages.length}页，请查询有效页码。`,'页码超出范围。',
 ]),rows:[]};
 const answer=warning+header(requestedPage,pages.length,selected.rows.length)+selected.entries.join('')+
  (selected.rows.some(row=>row.area?.unit==='unspecified')?unitsNotice:'')+notice+
  (requestedPage<pages.length?next(requestedPage,matches.length-selected.end):'');
 return answer.length<=limit?{answer,rows:selected.rows}:insufficient();
}
