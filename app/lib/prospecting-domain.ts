import {DomainError} from './domain.ts';
import type {ProspectCampaign,ProspectCandidate,ProspectComment,ProspectLead,ProspectVideo} from './prospecting-types.ts';

export const MAX_PROSPECT_COMMENTS=300;
export const PROSPECT_LEASE_MS=180000;
export const PROSPECT_SEND_INTERVAL_MS=60000;
export type CampaignInput=Pick<ProspectCampaign,'name'|'requirements'|'keywords'|'reviewMode'|'greetingTemplate'|'minIntentScore'|'maxCommentsPerVideo'|'dailyLimit'>;
export type AnalyzedComment=ProspectComment&Pick<ProspectLead,'intentScore'|'reason'|'greeting'|'analysisSource'>;
export const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function text(value:unknown,max=2000):string{return typeof value==='string'?value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,max):'';}
export function prospectId(value:unknown):string{const id=text(value,150);if(!/^[a-zA-Z0-9_.:-]{1,140}$/.test(id))throw new DomainError('记录标识不正确');return id;}
export function greetingText(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>300)throw new DomainError('打招呼文案需为1至300个字符');return text(value,300);}
function bounded(value:unknown,fallback:number,min:number,max:number,label:string):number{if(value===undefined)return fallback;if(!Number.isInteger(value)||Number(value)<min||Number(value)>max)throw new DomainError(`${label}需为${min}至${max}的整数`);return Number(value);}
export function normalizeCampaignInput(value:unknown):CampaignInput{
  const v=object(value);if(typeof v.requirements!=='string'||v.requirements.trim().length<5||v.requirements.length>2000)throw new DomainError('请用5至2000个字符描述产品、目标客户和竞品要求');
  const requirements=text(v.requirements);
  const keywords=v.keywords===undefined?requirements.split(/[，,；;。\n]/).map(x=>x.trim().slice(0,40)).filter(Boolean).slice(0,3):v.keywords;
  if(!Array.isArray(keywords)||!keywords.length||keywords.length>5||keywords.some(x=>typeof x!=='string'||!x.trim()||x.length>40))throw new DomainError('请填写1至5个搜索词，每个最多40个字符');
  if(v.reviewMode!==undefined&&!['manual','automatic'].includes(String(v.reviewMode)))throw new DomainError('审核模式不正确');
  return {name:text(v.name,40)||requirements.slice(0,30),requirements,keywords:[...new Set(keywords.map(x=>text(x,40)))],reviewMode:v.reviewMode==='automatic'?'automatic':'manual',greetingTemplate:greetingText(v.greetingTemplate??'你好，看到你在评论区提到的需求，方便进一步了解一下吗？'),minIntentScore:bounded(v.minIntentScore,70,0,100,'意向分数'),maxCommentsPerVideo:bounded(v.maxCommentsPerVideo,30,1,50,'每条视频评论数'),dailyLimit:bounded(v.dailyLimit,10,1,30,'每日触达上限')};
}
export function profile(value:unknown):{id:string;url:string}|null{
  if(typeof value!=='string')return null;
  try{const url=new URL(value);if(url.protocol!=='https:'||!['www.douyin.com','douyin.com'].includes(url.hostname)||url.port||url.username||url.password)return null;
    const match=url.pathname.match(/^\/user\/([a-zA-Z0-9_.-]{5,140})\/?$/);return match?{id:match[1],url:`https://www.douyin.com/user/${match[1]}`}:null;
  }catch{return null;}
}
export function video(value:unknown):ProspectVideo|null{
  const v=object(value);const id=String(v.id??v.videoId??v.aweme_id??'');if(!/^\d{5,30}$/.test(id))return null;
  return{id,title:text(v.title??v.desc,300),url:`https://www.douyin.com/video/${id}`};
}
export function normalizeCandidates(value:unknown):ProspectCandidate[]{
  if(!Array.isArray(value)||value.length>30)throw new DomainError('账号结果格式不正确或超过30个');
  const found=new Map<string,ProspectCandidate>();
  for(const raw of value){const v=object(raw),p=profile(v.profileUrl);if(!p)throw new DomainError('账号结果缺少有效的抖音主页');const videos=Array.isArray(v.videos)?v.videos.map(video).filter((x):x is ProspectVideo=>!!x).slice(0,10):[];
    const previous=found.get(p.id);found.set(p.id,{id:p.id,nickname:text(v.nickname,100)||'抖音账号',profileUrl:p.url,description:text(v.description,500),reason:text(v.reason,500)||'搜索结果中出现相关作品，请核对账号内容',videos:[...new Map([...(previous?.videos??[]),...videos].map(x=>[x.id,x])).values()].slice(0,10)});
  }return [...found.values()];
}
export function normalizeComments(value:unknown,source:'browser'|'mediacrawler'):ProspectComment[]{
  if(!Array.isArray(value)||value.length>MAX_PROSPECT_COMMENTS)throw new DomainError(`每次最多接收${MAX_PROSPECT_COMMENTS}条评论`);
  const unique=new Map<string,ProspectComment>();
  for(const raw of value){const v=object(raw),id=prospectId(String(v.id??v.comment_id??'')),item=video({id:v.videoId??v.aweme_id});const content=text(v.text??v.content,2000);if(!item||!content)throw new DomainError('评论缺少视频ID或正文');
    // Imported anonymous hashes and old dump IDs are never contact identities.
    const p=source==='browser'?profile(v.profileUrl):null;
    if(p&&v.recipientId!==undefined&&v.recipientId!==p.id)throw new DomainError('评论作者标识与主页不一致');
    const row:ProspectComment={id,videoId:item.id,videoUrl:item.url,text:content,nickname:text(v.nickname,100)||'抖音用户',source,...(p?{recipientId:p.id,profileUrl:p.url}:{}),...(typeof v.postedAt==='string'?{postedAt:text(v.postedAt,60)}:{})};
    unique.set(`${item.id}:${id}`,row);
  }return [...unique.values()];
}
export function parseMediaCrawlerExport(content:unknown):ProspectComment[]{
  if(typeof content!=='string'||new TextEncoder().encode(content).length>1500000)throw new DomainError('导入文件需小于1.5MB');
  let rows:unknown;try{rows=content.trim().startsWith('[')?JSON.parse(content):content.trim().split('\n').filter(x=>x.trim()).map(x=>JSON.parse(x));}catch{throw new DomainError('无法解析评论文件，请使用MediaCrawler评论JSON或JSONL导出');}
  const normalized=normalizeComments(rows,'mediacrawler');if(!normalized.length)throw new DomainError('文件中没有评论');return normalized;
}
export function scoreComment(comment:ProspectComment,campaign:Pick<CampaignInput,'greetingTemplate'>):AnalyzedComment{
  const purchase=/(多少钱|价格|报价|购买|怎么买|试用|怎么用|怎么联系|求推荐|求方案|有没有|需要|想要)/.test(comment.text);
  const negative=/(不用|不要|广告|骗子|别联系|不需要|没兴趣)/.test(comment.text);
  return {...comment,intentScore:negative?5:purchase?65:20,reason:negative?'含拒绝或负面表达，建议不触达':purchase?'规则识别到需求或询问信号，需人工确认':'未识别到明确需求，需结合上下文判断',greeting:campaign.greetingTemplate.replaceAll('{nickname}',comment.nickname).replaceAll('{comment}',comment.text.slice(0,80)).slice(0,300),analysisSource:'rules'};
}
export function applyModelAnalysis(comments:ProspectComment[],value:unknown,campaign:Pick<CampaignInput,'greetingTemplate'>):AnalyzedComment[]{
  const rows=Array.isArray(value)?value:[];
  return comments.map(comment=>{const fallback=scoreComment(comment,campaign);const matches=rows.map(object).filter(row=>row.id===comment.id);if(matches.length!==1)return fallback;
    const r=matches[0];if(!Number.isInteger(r.intentScore)||Number(r.intentScore)<0||Number(r.intentScore)>100||!text(r.reason,500)||typeof r.greeting!=='string'||!r.greeting.trim()||r.greeting.length>300)return fallback;
    return {...comment,intentScore:Number(r.intentScore),reason:text(r.reason,500),greeting:text(r.greeting,300),analysisSource:'model' as const};
  });
}
export function canAutoApprove(lead:AnalyzedComment&{autoSuppressed?:number|boolean},campaign:Pick<CampaignInput,'reviewMode'|'minIntentScore'>):boolean{return !lead.autoSuppressed&&campaign.reviewMode==='automatic'&&lead.analysisSource==='model'&&lead.intentScore>=campaign.minIntentScore&&!!lead.recipientId&&!!profile(lead.profileUrl)&&lead.source==='browser';}
export async function prospectHash(value:string):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');}
export const prospectToken=()=>crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','');
export function safeProspectError(value:unknown):string{return text(value,500).replace(/https?:\/\/\S+/g,'[链接]').replace(/(?:Bearer\s+|(?:token|cookie|sessionid|secret)[=:]\s*)[^\s,;]+/gi,'[凭证已隐藏]');}
