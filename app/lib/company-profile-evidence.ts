import type {CompanyProfile,CompanyProfileSource} from './types.ts';

type Fact=CompanyProfile['facts'][number];
const plainObject=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const clean=(value:unknown,max=1200):string=>typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):'';

export const searchText=(value:string)=>value.normalize('NFKC').replace(/\s+/g,' ').toLowerCase();
const escapePattern=(text:string)=>text.replace(/[.*+?^$${}()|[\]\\]/g,'\\$&');
export function companyMention(companyName:string):RegExp {
  const escaped=escapePattern(searchText(companyName));
  // Full names embedded inside a longer company name are not identity matches.
  return new RegExp(`(?:^|[^\\p{L}\\p{N}]|近日|日前|据悉|有关|关于|来自|消息称|公告称|根据|由|据)${escaped}(?![a-z0-9]|(?:控股|集团|旗下|所属)|[^。！？；，、\\s]{0,8}(?:分公司|分部|子公司))`,'u');
}

export function webSourceMentionsCompany(source:Pick<CompanyProfileSource,'title'|'snippet'>,companyName:string):boolean {
  if(!companyName.trim())return false;
  const identity=companyMention(companyName);
  return identity.test(searchText(source.title))||identity.test(searchText(source.snippet??''));
}

const numericProfileFields=[
  [/注册资本|注册资金/,/注册资本|注册资金/],
  [/实缴资本|实缴资金/,/实缴资本|实缴资金/],
  [/营收|营业额|营业收入/,/营收|营业额|营业收入/],
  [/净利润|利润/,/净利润|利润/],
  [/员工|人员规模|参保/,/员工|人员规模|参保/],
  [/成立|注册日期|设立日期/,/成立|注册|设立/],
  [/门店(?:数|规模)|网点(?:数|规模)/,/门店|店铺|分店|网点/],
] as const;

/** Web profile facts must remain extractive even when read from older saved profiles. */
export function groundedWebProfileFacts(value:unknown,sources:CompanyProfile['sources'],companyName:string):Fact[] {
  if(!Array.isArray(value)||!companyName.trim())return [];
  const identity=companyMention(companyName);
  const sourceById=new Map(sources.filter(source=>source.provider==='web').map(source=>[source.id,source]));
  const facts:Fact[]=[];
  for(const entry of value.slice(0,20)){
    const fact=plainObject(entry);const label=clean(fact?.label,80);const text=clean(fact?.value,1200);
    if(!label||!text||!Array.isArray(fact?.sourceIds)||!fact.sourceIds.length)continue;
    if(!fact.sourceIds.every(id=>typeof id==='string'&&sourceById.has(id)))continue;
    const raw=searchText(text);
    const field=numericProfileFields.find(([labels])=>labels.test(label))?.[1];
    if(/\d/.test(raw)&&!field&&/\d\s*(?:亿|万|元|人民币|美元|%|人|家)/.test(raw))continue;
    // Avoid treating a substring of another number, date or identifier as a source value.
    const before=/^[a-z\d]/.test(raw)?'(?<![a-z0-9.,])':'';
    const after=/[a-z\d]$/.test(raw)?'(?![a-z0-9]|[.,][0-9])':'';
    const valueMatch=new RegExp(before+escapePattern(raw)+after,'u');
    const sourceIds=[...new Set(fact.sourceIds as string[])].filter(id=>{
      const source=sourceById.get(id)!;
      const title=searchText(source.title);
      const passages=searchText(source.snippet??'').split(/[。！？；!?;]|\.\s/).map(part=>part.trim()).filter(Boolean);
      return passages.some((passage,index)=>{
        // For snippets lacking a full name, allow a title-bound opening fragment only.
        if(!identity.test(passage)&&(index!==0||!identity.test(title)||/有限公司|集团|企业名称[:：]/.test(passage)))return false;
        return passage.split(/[，、]|,(?!\d{3}(?:\D|$))/).some(clause=>valueMatch.test(clause)&&(!field||!(/\d/.test(raw))||field.test(clause)));
      });
    });
    if(sourceIds.length)facts.push({label,value:text,sourceIds});
  }
  return facts;
}
