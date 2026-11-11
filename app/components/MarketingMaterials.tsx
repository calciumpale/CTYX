'use client';
/* Authenticated result streams must bypass the public image optimizer. */
/* eslint-disable @next/next/no-img-element */
import {useState,useEffect,useRef,useCallback,useId,type KeyboardEvent} from 'react';
import type {MaterialKind,MaterialInput,PublicMaterialTask} from '../lib/marketing-material-types';
import DigitalHumanWorkspace from './DigitalHumanWorkspace';
import MomentsMaterials from './MomentsMaterials';
import CreativeStudio from './CreativeStudio';
import './marketing-materials.css';

type GenerationKind='image'|'video';
type MaterialSection='generate'|'moments'|'digitalhuman'|'creative';
type AttemptIdentity={id:string;hash:string};
type MaterialProps={notify:(message:string)=>void;onBusyChange?:(busy:boolean)=>void;onDirtyChange?:(dirty:boolean)=>void};
const kinds:Record<GenerationKind,string>={image:'营销图片',video:'营销视频'};
const sections:Record<MaterialSection,string>={generate:'图文生成',moments:'AI 朋友圈',digitalhuman:'数字人',creative:'创作与设计'};
const sectionOrder=Object.keys(sections) as MaterialSection[];
const statuses={submitting:'正在提交',submission_unknown:'提交结果未知',queued:'排队中',processing:'生成中',saving:'保存中',completed:'已完成',failed:'生成失败',expired:'结果链接已过期'};

async function api(body?:unknown){
 const response=await fetch('/api/marketing-materials',body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
 const data=await response.json() as {message?:string;tasks:PublicMaterialTask[];task:PublicMaterialTask;availability:Record<MaterialKind,boolean>};
 if(!response.ok)throw new Error(data.message||'素材服务暂时不可用');
 return data;
}

export default function MarketingMaterials({notify,onBusyChange,onDirtyChange}:MaterialProps){
 const id=useId();
 const [section,setSection]=useState<MaterialSection>('generate');
 const [humanVisited,setHumanVisited]=useState(false);
 const [momentsVisited,setMomentsVisited]=useState(false);
 const [creativeVisited,setCreativeVisited]=useState(false);
 const [generationBusy,setGenerationBusy]=useState(false),[humanBusy,setHumanBusy]=useState(false),[momentsBusy,setMomentsBusy]=useState(false);
 const [generationDirty,setGenerationDirty]=useState(false),[humanDirty,setHumanDirty]=useState(false),[momentsDirty,setMomentsDirty]=useState(false);
 const [creativeBusy,setCreativeBusy]=useState(false),[creativeDirty,setCreativeDirty]=useState(false);
 const busy=generationBusy||humanBusy||momentsBusy||creativeBusy,dirty=generationDirty||humanDirty||momentsDirty||creativeDirty;
 useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
 useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
 function selectSection(next:MaterialSection){if(busy)return;if(next==='digitalhuman')setHumanVisited(true);if(next==='moments')setMomentsVisited(true);if(next==='creative')setCreativeVisited(true);setSection(next);}
 function handleTabKey(event:KeyboardEvent<HTMLButtonElement>){
  if(busy||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const current=sectionOrder.indexOf(section);
  const index=event.key==='Home'?0:event.key==='End'?sectionOrder.length-1:(current+(event.key==='ArrowRight'?1:-1)+sectionOrder.length)%sectionOrder.length;
  const next=sectionOrder[index];
  selectSection(next);
  const tabs=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]');
  tabs?.[index]?.focus();
 }
 return <section className="material-workspace" aria-label="AI营销素材">
  <header className="material-heading"><h2>AI营销素材</h2></header>
  <div className="material-tabs" role="tablist" aria-label="素材功能">
   {(Object.entries(sections) as [MaterialSection,string][]).map(([value,label])=><button key={value} id={`${id}-${value}-tab`} type="button" role="tab" aria-selected={section===value} aria-controls={`${id}-${value}-panel`} tabIndex={section===value?0:-1} disabled={busy} onClick={()=>selectSection(value)} onKeyDown={handleTabKey}>{label}</button>)}
  </div>
  <div className="material-panel" role="tabpanel" id={`${id}-generate-panel`} aria-labelledby={`${id}-generate-tab`} hidden={section!=='generate'}>
   <GeneratedMaterials notify={notify} active={section==='generate'} onBusyChange={setGenerationBusy} onDirtyChange={setGenerationDirty}/>
  </div>
  <div className="material-panel" role="tabpanel" id={`${id}-moments-panel`} aria-labelledby={`${id}-moments-tab`} hidden={section!=='moments'}>
   {momentsVisited&&<MomentsMaterials notify={notify} active={section==='moments'} onBusyChange={setMomentsBusy} onDirtyChange={setMomentsDirty}/>}
  </div>
  <div className="material-panel" role="tabpanel" id={`${id}-digitalhuman-panel`} aria-labelledby={`${id}-digitalhuman-tab`} hidden={section!=='digitalhuman'}>
   {humanVisited&&<DigitalHumanWorkspace notify={notify} active={section==='digitalhuman'} onBusyChange={setHumanBusy} onDirtyChange={setHumanDirty}/>}
  </div>
  <div className="material-panel" role="tabpanel" id={`${id}-creative-panel`} aria-labelledby={`${id}-creative-tab`} hidden={section!=='creative'}>
   {creativeVisited&&<CreativeStudio notify={notify} onBusyChange={setCreativeBusy} onDirtyChange={setCreativeDirty}/>}
  </div>
 </section>;
}

function GeneratedMaterials({notify,onBusyChange,onDirtyChange,active}:MaterialProps&{active:boolean}){
 const [kind,setKind]=useState<GenerationKind>('image');
 const [drafts,setDrafts]=useState<Record<GenerationKind,MaterialInput>>(()=>Object.fromEntries(Object.keys(kinds).map(value=>[value,{kind:value,prompt:'',target:'',sellingPoints:'',reference:'',size:'1:1',n:1,duration:5,aspectRatio:'16:9'}])) as Record<GenerationKind,MaterialInput>);
 const [tasks,setTasks]=useState<PublicMaterialTask[]>([]),[availability,setAvailability]=useState<Record<MaterialKind,boolean>>({presentation:false,image:false,video:false});
 const [pending,setPending]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState<string>();
 const [attemptIdentity,setAttemptIdentity]=useState<Record<GenerationKind,AttemptIdentity>>({image:{id:'',hash:''},video:{id:'',hash:''}});
 const requestIds=useRef<Record<GenerationKind,AttemptIdentity>>({image:{hash:'',id:''},video:{hash:'',id:''}}),mounted=useRef(true),inFlight=useRef(false),pollBudget=useRef(new Map<string,number>());
 const input=drafts[kind],task=tasks.find(item=>item.id===selected),attempt=tasks.find(item=>item.requestId===attemptIdentity[kind].id);
 const canNewAttempt=attemptIdentity[kind].hash===JSON.stringify(input)&&!!attempt&&['completed','failed','expired'].includes(attempt.status);
 const load=useCallback(async()=>{
  try{const data=await api();if(mounted.current){setTasks(data.tasks);setAvailability(data.availability);setError('');}}
  catch(cause){if(mounted.current)setError((cause as Error).message);}
  finally{if(mounted.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;const timer=setTimeout(()=>void load(),0);return()=>{mounted.current=false;clearTimeout(timer);};},[load]);
 useEffect(()=>()=>onBusyChange?.(false),[onBusyChange]);
 useEffect(()=>{
  onDirtyChange?.(Object.values(drafts).some(draft=>[draft.prompt,draft.target,draft.sellingPoints,draft.reference].some(value=>!!value.trim())||draft.kind==='image'&&(draft.size!=='1:1'||draft.n!==1)||draft.kind==='video'&&(draft.duration!==5||draft.aspectRatio!=='16:9')));
  return()=>onDirtyChange?.(false);
 },[drafts,onDirtyChange]);
 const update=(patch:Partial<MaterialInput>)=>{if(!inFlight.current)setDrafts(old=>({...old,[kind]:{...old[kind],...patch}}));};
 const perform=useCallback(async(body:unknown)=>{
  if(inFlight.current)return;
  inFlight.current=true;setPending(true);onBusyChange?.(true);setError('');
  try{
   const {task:next}=await api(body);if(!mounted.current)return;
   setTasks(old=>[next,...old.filter(item=>item.id!==next.id)]);setSelected(next.id);return next;
  }catch(cause){if(mounted.current)setError((cause as Error).message);}
  finally{inFlight.current=false;if(mounted.current){setPending(false);onBusyChange?.(false);}}
 },[onBusyChange]);
 useEffect(()=>{
  const candidate=task?.input.kind===kind?task:tasks.find(item=>item.input.kind===kind&&['queued','processing'].includes(item.status)&&!item.error);
  if(!active||!candidate||pending||error||!['queued','processing','saving'].includes(candidate.status)||candidate.error)return;
  if((pollBudget.current.get(candidate.id)??0)>=120)return;
  const timer=setTimeout(()=>{pollBudget.current.set(candidate.id,(pollBudget.current.get(candidate.id)??0)+1);void perform({action:'refresh',taskId:candidate.id,version:candidate.version});},6000);
  return()=>clearTimeout(timer);
 },[active,kind,task,tasks,pending,error,perform]);
 async function generate(newAttempt=false){
  if(inFlight.current||newAttempt&&!canNewAttempt)return;
  const hash=JSON.stringify(input);
  if(newAttempt||requestIds.current[kind].hash!==hash)requestIds.current[kind]={hash,id:crypto.randomUUID()};
  const identity=requestIds.current[kind];
  setAttemptIdentity(old=>({...old,[kind]:identity}));
  const next=await perform({action:'generate',requestId:identity.id,input});
  if(next&&mounted.current)notify('素材任务已创建');
 }
 const visibleTasks=tasks.filter(item=>item.input.kind===kind);
 return <div className="material-generation">
  <div className="material-generation-heading">
   <label>输出类型<select aria-label="输出类型" value={kind} disabled={pending} onChange={event=>{if(!inFlight.current)setKind(event.target.value as GenerationKind);}}><option value="image">图片</option><option value="video">视频</option></select></label>
   <button type="button" disabled={pending||loading} onClick={()=>void load()}>刷新已保存列表</button>
  </div>
  {error&&<p role="alert" className="material-error">{error}</p>}
  <div className="material-columns">
   <form className="material-form" onSubmit={event=>{event.preventDefault();void generate();}}>
    <h3>准备{kinds[kind]}</h3><p>填写产品与生成要求，完成后预览或下载素材。</p>
    <label>产品与生成要求<textarea value={input.prompt} disabled={pending} maxLength={2000} required onChange={event=>update({prompt:event.target.value})} placeholder="介绍产品，并说明用途、风格和重点"/></label>
    <label>目标受众<input value={input.target} disabled={pending} maxLength={800} onChange={event=>update({target:event.target.value})}/></label>
    <label>产品卖点<textarea value={input.sellingPoints} disabled={pending} maxLength={2000} onChange={event=>update({sellingPoints:event.target.value})}/></label>
    <label>参考资料<textarea value={input.reference} disabled={pending} maxLength={3000} onChange={event=>update({reference:event.target.value})}/></label>
    {kind==='image'?<div className="material-options"><label>尺寸<select value={input.size} disabled={pending} onChange={event=>update({size:event.target.value as MaterialInput['size']})}>{['1:1','2:3','3:2'].map(size=><option key={size}>{size}</option>)}</select></label><label>数量<select value={input.n} disabled={pending} onChange={event=>update({n:Number(event.target.value)})}>{[1,2,3,4].map(count=><option key={count}>{count}</option>)}</select></label></div>:<div className="material-options"><label>画幅<select value={input.aspectRatio} disabled={pending} onChange={event=>update({aspectRatio:event.target.value as MaterialInput['aspectRatio']})}>{['16:9','9:16','1:1'].map(ratio=><option key={ratio}>{ratio}</option>)}</select></label><label>时长（秒）<input type="number" min={3} max={15} value={input.duration} disabled={pending} onChange={event=>update({duration:Number(event.target.value)})}/></label></div>}
    {!loading&&!availability[kind]&&<p role="status">请管理员配置 APIMart 密钥并启用素材服务。</p>}
    <button className="material-primary" disabled={pending||loading||!availability[kind]||!input.prompt.trim()} type="submit">{pending?'处理中…':`生成${kinds[kind]}`}</button>
    {canNewAttempt&&<button type="button" disabled={pending||!availability[kind]} onClick={()=>void generate(true)}>新建同内容任务</button>}
    <p>每次生成会调用付费服务。提交结果未知时，请先核对服务商记录。</p>
   </form>
   <div className="material-results">
    <h3>我的素材</h3>
    {loading?<p role="status">正在读取任务…</p>:visibleTasks.length===0?<p>尚无{kinds[kind]}。填写资料后创建第一个任务。</p>:<ul className="material-history">{visibleTasks.map(item=><li key={item.id}><button type="button" disabled={pending} aria-pressed={selected===item.id} onClick={()=>setSelected(item.id)}><span>{item.input.prompt.slice(0,36)}</span><small>{statuses[item.status]} · {new Date(item.createdAt).toLocaleString('zh-CN')}</small></button></li>)}</ul>}
    {task&&task.input.kind===kind&&<article className="material-detail">
     <h3>{statuses[task.status]}</h3>{task.error&&<p role="status">{task.error}</p>}
     {!['completed','failed','expired','submission_unknown'].includes(task.status)&&<><progress max={100} value={task.progress} aria-label="生成进度"/><button type="button" disabled={pending} onClick={()=>void perform({action:'refresh',taskId:task.id,version:task.version})}>{task.status==='saving'?'重试保存':'查询生成状态'}</button><p>自动查询最多120次；保存失败后请重试保存。列表刷新只读取记录，查询不会重新生成。</p></>}
     {task.files.map((file,index)=><div key={file.url}>{file.type.startsWith('image/')?<img className="material-image" src={file.url} alt={`生成的营销图片${index+1}`}/>:<video className="material-image" src={file.url} controls preload="metadata"/>}<a href={file.url} download>下载{file.name}</a></div>)}
    </article>}
   </div>
  </div>
 </div>;
}
