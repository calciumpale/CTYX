import type {ProspectChatMemory, ProspectChatPolicy} from './prospecting-chat-types.ts';

function record(value:unknown):Record<string,unknown> {
  if(typeof value==='string'){
    try{return record(JSON.parse(value));}catch{return {};}
  }
  return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}

function integer(value:unknown,fallback:number,min:number,max:number):number {
  return typeof value==='number'&&Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
}

export function defaultChatPolicy():ProspectChatPolicy {
  return {libraryIds:[],replyDailyLimit:30,conversationReplyLimit:12,workStart:'08:30',workEnd:'21:30'};
}

/** Defensive DB normalization; settings mutations separately reject invalid explicit inputs. */
export function normalizeChatPolicy(value:unknown):ProspectChatPolicy {
  const input=record(value);
  const defaults=defaultChatPolicy();
  const validTime=(value:unknown):value is string=>typeof value==='string'&&/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  const validHours=validTime(input.workStart)&&validTime(input.workEnd)&&input.workStart<input.workEnd;
  return {
    libraryIds:Array.isArray(input.libraryIds)?[...new Set(input.libraryIds.filter((id):id is string=>typeof id==='string').map(id=>id.trim()).filter(Boolean))].slice(0,20):[],
    replyDailyLimit:integer(input.replyDailyLimit,defaults.replyDailyLimit,1,80),
    conversationReplyLimit:integer(input.conversationReplyLimit,defaults.conversationReplyLimit,1,30),
    workStart:validHours?input.workStart as string:defaults.workStart,
    workEnd:validHours?input.workEnd as string:defaults.workEnd,
  };
}

const shanghaiTime=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

/** Only same-day schedules are supported. Closing time is exclusive. */
export function withinChatHours(nowMs:number,policy:ProspectChatPolicy):boolean {
  if(!Number.isFinite(nowMs)||Number.isNaN(new Date(nowMs).getTime()))return false;
  const normalized=normalizeChatPolicy(policy);
  const time=shanghaiTime.format(nowMs);
  return time>=normalized.workStart&&time<normalized.workEnd;
}

/** Refusing to share contact details is distinct from asking us to stop messaging. */
export function isChatOptOut(value:string,previousOutbound?:string):boolean {
  const normalized=value.normalize('NFKC');
  if(/(?:别|不要|不想|不用|请勿|停止|无需|不必)(?:再)?(?:给我|跟我|对我)?(?:联系|私信|打扰|发(?:送)?(?:消息|信息|广告|私信)|发了|聊了)|(?:取消|停止)(?:接收|推送)|不感兴趣|没兴趣|拉黑|退订|不考虑了/.test(normalized))return true;
  const needQuestion=/主要打算经营什么业态|大概需要多大面积|希望在哪个城市或区域|租金预算大概是多少|计划什么时候开业或入驻|预算.{0,12}(?:单位|周期)|(?:是否|需要|要不要|方便).{0,12}(?:看场|看铺|看房|看店|到访|看现场)|(?:留|提供).{0,12}(?:联系方式|电话|手机|微信|邮箱)/.test(previousOutbound??'');
  if(needQuestion&&/^(?:不需要(?:了)?|不用(?:了)?|没需要)[。!！,，\s]*(?:谢谢)?[。!！,，\s]*$/.test(normalized.trim()))return false;
  return /(?:^|[。！？！，、\s])(?:不用了|没需要|不需要(?:了)?)(?:[。！？！，、\s]|$)/.test(normalized);
}

/** Redaction is shared by persisted summaries and every retrieval/model boundary. */
export function redactChatText(value:string):string {
  const normalized=value.normalize('NFKC');
  const redacted=normalized
    .replace(/(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}(?![A-Za-z0-9._%+-])/g,'[邮箱]')
    .replace(/(?<![0-9A-Za-z])(?:\+?86[ -]?)?1[3-9]\d[ -]?\d{4}[ -]?\d{4}(?![0-9A-Za-z])/g,'[手机号]')
    .replace(/(?<!\d)0\d{2,3}[ -]?\d{7,8}(?!\d)/g,'[电话]')
    .replace(/(?:微\s*信号?|威信|v\s*[-_]?\s*x|wx|wechat)[：:\s]*(?:是[：:\s]*)?([A-Za-z][A-Za-z0-9_-]{5,19})(?![A-Za-z0-9_-])/gi,'微信[账号]')
    .replace(/(?<!\d)\d{6,}(?!\d)/g,'[编号]');
  return redacted===normalized?value:redacted;
}

export function initialChatMemory():ProspectChatMemory {
  return {needs:{},stage:'understanding',contactCaptured:false,contactDeclines:0,contactAsks:0,summary:''};
}

export function normalizeChatMemory(value:unknown):ProspectChatMemory {
  const input=record(value);
  const needs=record(input.needs);
  const memory=initialChatMemory();
  for(const key of ['area','category','budget','location','timing','visit'] as const){
    if(typeof needs[key]==='string'&&needs[key].trim())memory.needs[key]=redactChatText(needs[key].trim()).slice(0,100);
  }
  if(['understanding','qualifying','contact','visit','handoff','closed'].includes(String(input.stage)))memory.stage=input.stage as ProspectChatMemory['stage'];
  memory.contactCaptured=input.contactCaptured===true;
  memory.contactDeclines=integer(input.contactDeclines,0,0,Number.MAX_SAFE_INTEGER);
  memory.contactAsks=integer(input.contactAsks,0,0,Number.MAX_SAFE_INTEGER);
  memory.summary=typeof input.summary==='string'?redactChatText(input.summary).trim().slice(0,300):'';
  return memory;
}
