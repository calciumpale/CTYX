'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, CircleAlert, Database, GitBranch, Loader2, Pencil, RefreshCw, Save, Settings, ShieldCheck, Users, X } from 'lucide-react';
import type { MemberSession, WorkspaceMember } from '../lib/member-types';
import type { View, ViewProps } from '../lib/types';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import { useBusinessSettings } from './BusinessSettingsContext';
import { KnowledgeLibraries } from './KnowledgeLibraries';
import { KnowledgeView } from './StudioViews';
import { TalkLibraryView } from './TalkLibraryView';
import { DiscardChangesDialog } from './CoreViews';
import './admin-workspace.css';

export const MEMBER_LABELS = {sales:'一线销售',manager:'销售管理者',admin:'管理员'};
type GuardProps = {onBusyChange?:(busy:boolean)=>void;onDirtyChange?:(dirty:boolean)=>void};
function ErrorNote({error,retry}:{error:string;retry?:()=>void}) {return <div className="admin-feedback" role="alert"><CircleAlert size={17}/><p>{error}</p>{retry&&<button className="button secondary" onClick={retry}>重新加载</button>}</div>;}
async function result<T>(response:Response):Promise<T>{const body=await response.json() as T&{error?:string};if(!response.ok)throw new Error(body.error||'操作没有完成，请重试');return body;}

export function AdminHome({state,onNavigate}:{state:ViewProps['state'];onNavigate:(view:View)=>void}) {
  const knowledgeCount=state.knowledge.filter(item=>item.status==='published').length;
  const trackCount=(state.talkTracks??[]).filter(item=>item.status==='published').length;
  return <div className="admin-home">
    <header className="admin-page-heading"><h1>系统管理</h1></header>
    <section className="admin-quick-list" aria-label="管理入口">
      <button onClick={()=>onNavigate('knowledge')}><BookOpen size={18}/><span><strong>知识库</strong></span><small>{knowledgeCount} 条知识 · {trackCount} 条话术</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('members')}><Users size={18}/><span><strong>人员权限</strong></span><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('rules')}><ShieldCheck size={18}/><span><strong>业务规则</strong></span><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('settings')}><Settings size={18}/><span><strong>服务连接</strong></span><small>{state.model.connected?'模型已配置':'模型未配置'}</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('studio')}><GitBranch size={18}/><span><strong>AI 搭建中心</strong></span><ArrowRight size={16}/></button>
    </section>
  </div>;
}

export function MembersView({member,notify,onBusyChange,onDirtyChange}:{member:MemberSession;notify:(value:string)=>void}&GuardProps) {
  const [members,setMembers]=useState<WorkspaceMember[]>([]);const [loaded,setLoaded]=useState(-1);const [error,setError]=useState('');
  const [editing,setEditing]=useState('');const [name,setName]=useState('');const [enabled,setEnabled]=useState(true);const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);const loading=loaded!==reload;
  const pending=useRef(false);const active=useRef(true);const abort=useRef<AbortController|null>(null);
  const original=members.find(item=>item.accountId===editing);const dirty=!!original&&(name!==original.displayName||enabled!==original.enabled);
  useEffect(()=>{active.current=true;return()=>{active.current=false;abort.current?.abort();};},[]);
  useEffect(()=>{const controller=new AbortController();void fetch('/api/workspace-members',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(response=>result<{members:WorkspaceMember[]}>(response)).then(body=>{if(!controller.signal.aborted){setMembers(body.members);setError('');}}).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'账号读取失败');}).finally(()=>{if(!controller.signal.aborted)setLoaded(reload);});return()=>controller.abort();},[reload]);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(dirty||pending.current)event.preventDefault();};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[dirty]);
  const save=async(event:FormEvent)=>{event.preventDefault();if(pending.current||!original)return;pending.current=true;setBusy(true);setError('');abort.current=new AbortController();try{const body=await result<{members:WorkspaceMember[]}>(await fetch('/api/workspace-members',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:abort.current.signal,body:JSON.stringify({accountId:editing,displayName:name.trim(),enabled})}));if(active.current){setMembers(body.members);setEditing('');notify('账号已更新');}}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'账号未能保存，请重试');}finally{pending.current=false;if(active.current)setBusy(false);}};
  return <div className="admin-page"><header className="admin-page-heading"><div><h1>人员权限</h1></div><button className="button secondary" disabled={busy||dirty||loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={15}/>刷新</button></header>{error&&<ErrorNote error={error} retry={!busy&&!dirty?()=>setReload(value=>value+1):undefined}/>}<section className="admin-members" aria-label="工作台账号">{loading?<p className="admin-loading" role="status"><Loader2 size={19} className="spin"/>正在读取账号…</p>:members.map(item=><div className="admin-member" key={item.accountId}><div className="admin-member-identity"><span className="admin-member-avatar">{item.displayName.slice(0,1)}</span><div><h2>{item.displayName}{item.accountId===member.accountId&&<span className="admin-current">当前账号</span>}</h2><p>{item.username} · {MEMBER_LABELS[item.role]}</p></div></div>{editing===item.accountId?<form className="admin-member-form" onSubmit={event=>void save(event)}><label>显示名称<input value={name} maxLength={80} autoFocus required disabled={busy} onChange={event=>setName(event.target.value)}/></label><label className="admin-check"><input type="checkbox" checked={enabled} disabled={busy||item.accountId===member.accountId} onChange={event=>setEnabled(event.target.checked)}/>允许登录</label><div><button type="button" className="button secondary" disabled={busy} onClick={()=>setEditing('')}><X size={15}/>取消</button><button className="button primary" disabled={busy||!name.trim()||!dirty}>{busy?<Loader2 size={15} className="spin"/>:<Save size={15}/>}保存</button></div></form>:<div className="admin-member-actions"><span className={`admin-account-status ${item.enabled?'enabled':''}`}>{item.enabled?'已启用':'已停用'}</span><button className="button secondary" disabled={!!editing||busy} onClick={()=>{setEditing(item.accountId);setName(item.displayName);setEnabled(item.enabled);setError('');}}><Pencil size={14}/>编辑</button></div>}</div>)}</section><p className="admin-footnote">停用账号会撤销其登录会话。</p></div>;
}

export function BusinessRulesView({state,notify,onBusyChange,onDirtyChange}:{state:ViewProps['state'];notify:ViewProps['notify']}&GuardProps) {
  const [saved,setSaved]=useState<{version:number;urgentDays:number;warningDays:number}|null>(null);const [urgent,setUrgent]=useState('2');const [warning,setWarning]=useState('5');const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(-1);const [reload,setReload]=useState(0);const loading=loaded!==reload;
  const [templateBusy,setTemplateBusy]=useState(false);const [templateDirty,setTemplateDirty]=useState(false);const pending=useRef(false);const mounted=useRef(true);const request=useRef<AbortController|null>(null);const {refreshRules}=useBusinessSettings();
  const dirty=!!saved&&(urgent!==String(saved.urgentDays)||warning!==String(saved.warningDays));
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;request.current?.abort();};},[]);
  useEffect(()=>{const abort=new AbortController();void fetch('/api/business-settings',{cache:'no-store',credentials:'same-origin',signal:abort.signal}).then(response=>result<NonNullable<typeof saved>>(response)).then(value=>{if(!abort.signal.aborted){setError('');setSaved(value);setUrgent(String(value.urgentDays));setWarning(String(value.warningDays));}}).catch(cause=>{if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'规则读取失败，请重试');}).finally(()=>{if(!abort.signal.aborted)setLoaded(reload);});return()=>abort.abort();},[reload]);
  useEffect(()=>{onBusyChange?.(busy||templateBusy);return()=>onBusyChange?.(false);},[busy,templateBusy,onBusyChange]);
  useEffect(()=>{onDirtyChange?.(dirty||templateDirty);return()=>onDirtyChange?.(false);},[dirty,templateDirty,onDirtyChange]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(dirty||pending.current)event.preventDefault();};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[dirty]);
  const templateBusyChanged=useCallback((value:boolean)=>setTemplateBusy(value),[]);const templateDirtyChanged=useCallback((value:boolean)=>setTemplateDirty(value),[]);
  const save=async(event:FormEvent)=>{event.preventDefault();if(pending.current||!saved)return;const urgentDays=Number(urgent),warningDays=Number(warning);if(!Number.isInteger(urgentDays)||!Number.isInteger(warningDays)||urgentDays<1||urgentDays>=warningDays||warningDays>30){setError('紧急提醒须至少1天，常规提醒大于紧急提醒，且不超过30天');return;}pending.current=true;setBusy(true);setError('');request.current=new AbortController();try{const value=await result<NonNullable<typeof saved>>(await fetch('/api/business-settings',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:request.current.signal,body:JSON.stringify({version:saved.version,urgentDays,warningDays})}));if(mounted.current){setSaved(value);setUrgent(String(value.urgentDays));setWarning(String(value.warningDays));await refreshRules();notify('项目提醒规则已生效');}}catch(cause){if(mounted.current)setError(cause instanceof Error?cause.message:'规则未能保存，请重试');}finally{pending.current=false;if(mounted.current)setBusy(false);}};
  return <div className="admin-page admin-rules"><header className="admin-page-heading"><div><h1>业务规则</h1></div></header><section className="admin-rule-section"><div><h2>项目截止提醒</h2></div>{error&&<ErrorNote error={error} retry={!busy&&!dirty?()=>setReload(value=>value+1):undefined}/>}<form onSubmit={event=>void save(event)}><div className="admin-thresholds"><label>紧急提醒<span>剩余不足</span><div className="admin-number"><input type="number" min="1" max="29" required value={urgent} disabled={loading||busy} onChange={event=>setUrgent(event.target.value)}/><span>天</span></div></label><label>常规提醒<span>剩余不足</span><div className="admin-number"><input type="number" min="2" max="30" required value={warning} disabled={loading||busy} onChange={event=>setWarning(event.target.value)}/><span>天</span></div></label></div><footer><p>{loading?'正在读取已保存规则…':dirty?'有尚未保存的修改':'当前规则已保存'}</p><button className="button primary" disabled={!saved||!dirty||busy||loading}>{busy?<Loader2 size={15} className="spin"/>:<Check size={15}/>}保存规则</button></footer></form></section><ApprovalWorkspace templatesOnly state={state} notify={notify} onBusyChange={templateBusyChanged} onDirtyChange={templateDirtyChanged}/></div>;
}

export function KnowledgeWorkspace({member,onUsePlaybook,initialTab='documents',focus,onBusyChange,onDirtyChange,...props}:ViewProps&{member:MemberSession;onUsePlaybook:(id:string)=>void;initialTab?:'documents'|'talktracks';focus?:string|null}&GuardProps) {
  const [tab,setTab]=useState<'libraries'|'documents'|'talktracks'>(initialTab==='talktracks'||focus==='talk-review'?'talktracks':focus?'documents':'libraries');
  const busy=useRef(false),dirty=useRef(false);
  const [pendingTab,setPendingTab]=useState<typeof tab|null>(null);
  const busyChanged=useCallback((value:boolean)=>{busy.current=value;onBusyChange?.(value);},[onBusyChange]);
  const dirtyChanged=useCallback((value:boolean)=>{dirty.current=value;onDirtyChange?.(value);},[onDirtyChange]);
  const switchTab=(next:typeof tab)=>{
    if(next===tab)return;
    if(busy.current){props.notify('资料正在处理，请等待当前操作结束后切换。');return;}
    if(dirty.current){setPendingTab(next);return;}
    setTab(next);
  };
  return <div className="knowledge-workspace">
    <nav className="knowledge-workspace-switch" aria-label="知识库内容">
      <button className={tab==='libraries'?'selected':''} aria-pressed={tab==='libraries'} onClick={()=>switchTab('libraries')}><Database size={16}/>资料库</button>
      <button className={tab==='documents'?'selected':''} aria-pressed={tab==='documents'} onClick={()=>switchTab('documents')}><BookOpen size={16}/>知识与方法</button>
      <button className={tab==='talktracks'?'selected':''} aria-pressed={tab==='talktracks'} onClick={()=>switchTab('talktracks')}><GitBranch size={16}/>成单话术</button>
    </nav>
    {tab==='libraries' ? <KnowledgeLibraries notify={props.notify} onBusyChange={busyChanged} onDirtyChange={dirtyChanged}/> : tab==='documents' ?
      <KnowledgeView {...props} initialTab={member.role==='manager'&&focus==='skill-review'?'review':'knowledge'} canReviewSkills={member.role==='manager'} canSubmitExperience={member.role!=='admin'}/> :
      <TalkLibraryView {...props} initialTab={member.role==='manager'&&focus==='talk-review'?'review':'published'} canReview={member.role==='manager'} operational={member.role==='admin'} onUsePlaybook={onUsePlaybook}/>}
    {pendingTab&&<DiscardChangesDialog title="资料修改尚未保存" onCancel={()=>setPendingTab(null)} onDiscard={()=>{dirtyChanged(false);setTab(pendingTab);setPendingTab(null);}}/>}
  </div>;
}
