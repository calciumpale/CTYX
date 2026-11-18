'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpen, Check, CircleAlert, Database, GitBranch, Loader2, Pencil, RefreshCw, Save, Search, Settings, ShieldCheck, Users, X } from 'lucide-react';
import type { MemberSession, WorkspaceMember } from '../lib/member-types';
import type { View, ViewProps } from '../lib/types';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import { useBusinessSettings } from './BusinessSettingsContext';
import { KnowledgeLibraries } from './KnowledgeLibraries';
import { KnowledgeView } from './StudioViews';
import { TalkLibraryView } from './TalkLibraryView';
import { DiscardChangesDialog } from './CoreViews';
import { LiveSignalPill, MiniRingGauge } from './TelemetryWidgets';
import './admin-workspace.css';

export const MEMBER_LABELS = {sales:'一线销售',manager:'销售管理者',admin:'管理员'};
const MEMBER_SCOPES = {
  sales: '负责归属科室企业跟进、获客接待与本部门知识检索',
  manager: '统筹团队商机风险、跨账号审批及候选 Skill 审核发布',
  admin: '维护账号、业务规则、服务连接与 AI 工作流搭建中心',
} as const;
const avatarTone = (text: string) => {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % 6;
};
type GuardProps = {onBusyChange?:(busy:boolean)=>void;onDirtyChange?:(dirty:boolean)=>void};
function ErrorNote({error,retry}:{error:string;retry?:()=>void}) {return <div className="admin-feedback" role="alert"><CircleAlert size={17}/><p>{error}</p>{retry&&<button className="button secondary" onClick={retry}>重新加载</button>}</div>;}
async function result<T>(response:Response):Promise<T>{const body=await response.json() as T&{error?:string};if(!response.ok)throw new Error(body.error||'操作没有完成，请重试');return body;}

export function AdminHome({state,onNavigate}:{state:ViewProps['state'];onNavigate:(view:View)=>void}) {
  const knowledgeCount=state.knowledge.filter(item=>item.status==='published').length;
  const trackCount=(state.talkTracks??[]).filter(item=>item.status==='published').length;
  const publishedAssets=knowledgeCount+trackCount;
  const allAssets=state.knowledge.length+(state.talkTracks?.length??0);
  const workflowCount=state.workflows.length;
  const publishedWorkflows=state.workflows.filter(item=>item.status==='published'||Boolean(item.published)).length;
  const publishPct=workflowCount>0?Math.round((publishedWorkflows/workflowCount)*100):0;
  return <div className="admin-home">
    <header className="admin-page-heading">
      <div>
        <div className="admin-title-row"><h1>系统管理</h1><LiveSignalPill tone={state.model.connected ? 'success' : 'accent'} shimmer>{state.model.connected ? '模型已配置' : '模型配置待检查'}</LiveSignalPill></div>
        <p>统一管理工作空间岗位账号、业务预警规则、模型服务连接与 AI 应用编排。</p>
      </div>
    </header>
    <div className="admin-kpi-grid" aria-label="系统概览">
      <div>
        <div className="admin-kpi-top"><span>已生效知识与话术</span>{allAssets > 0 && <MiniRingGauge size={34} value={publishedAssets / allAssets * 100} />}</div>
        <strong>{publishedAssets}</strong><small>{knowledgeCount} 条知识 · {trackCount} 条成单话术</small>
      </div>
      <div>
        <div className="admin-kpi-top"><span>大模型配置</span><Settings size={18} aria-hidden="true" /></div>
        <strong>{state.model.connected ? '已配置' : '待检查'}</strong><small>{state.model.name}</small>
      </div>
      <div>
        <div className="admin-kpi-top"><span>AI 应用与工作流</span>{workflowCount > 0 && <MiniRingGauge size={34} value={publishPct} tone="accent" centerLabel={`${publishPct}%`} />}</div>
        <strong>{publishedWorkflows} / {workflowCount}</strong><small>线上已发布 / 全部编排应用</small>
      </div>
    </div>
    <section className="admin-quick-list" aria-label="管理入口">
      <button onClick={()=>onNavigate('knowledge')}><span className="admin-quick-icon"><BookOpen size={18}/></span><span><strong>知识库</strong><em>维护部门专属资料库、业务方法沉淀与话术治理策略</em></span><small>{knowledgeCount} 条知识 · {trackCount} 条话术</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('members')}><span className="admin-quick-icon"><Users size={18}/></span><span><strong>人员权限</strong><em>配置一线销售、管理者与管理员账号状态及会话边界</em></span><small>岗位隔离</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('rules')}><span className="admin-quick-icon"><ShieldCheck size={18}/></span><span><strong>业务规则</strong><em>设定项目截止预警天数阈值与多级审批流程模板</em></span><small>风控与审批</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('settings')}><span className="admin-quick-icon"><Settings size={18}/></span><span><strong>服务连接</strong><em>接入大模型、营销素材、数字人、语音识别与向量检索</em></span><small>{state.model.connected?'模型已配置':'模型未配置'}</small><ArrowRight size={16}/></button>
      <button onClick={()=>onNavigate('studio')}><span className="admin-quick-icon"><GitBranch size={18}/></span><span><strong>AI 搭建中心</strong><em>可视化编排领域专家 Agent 与多节点业务工作流</em></span><small>{workflowCount} 个应用</small><ArrowRight size={16}/></button>
    </section>
  </div>;
}

export function MembersView({member,notify,onBusyChange,onDirtyChange}:{member:MemberSession;notify:(value:string)=>void}&GuardProps) {
  const [members,setMembers]=useState<WorkspaceMember[]>([]);const [loaded,setLoaded]=useState(-1);const [error,setError]=useState('');
  const [editing,setEditing]=useState('');const [name,setName]=useState('');const [enabled,setEnabled]=useState(true);const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);const loading=loaded!==reload;
  const [roleFilter,setRoleFilter]=useState<'all'|'sales'|'manager'|'admin'>('all');
  const [memberSearch,setMemberSearch]=useState('');
  const pending=useRef(false);const active=useRef(true);const abort=useRef<AbortController|null>(null);
  const original=members.find(item=>item.accountId===editing);const dirty=!!original&&(name!==original.displayName||enabled!==original.enabled);
  useEffect(()=>{active.current=true;return()=>{active.current=false;abort.current?.abort();};},[]);
  useEffect(()=>{const controller=new AbortController();void fetch('/api/workspace-members',{credentials:'same-origin',cache:'no-store',signal:controller.signal}).then(response=>result<{members:WorkspaceMember[]}>(response)).then(body=>{if(!controller.signal.aborted){setMembers(body.members);setError('');}}).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'账号读取失败');}).finally(()=>{if(!controller.signal.aborted)setLoaded(reload);});return()=>controller.abort();},[reload]);
  useEffect(()=>{onBusyChange?.(busy);return()=>onBusyChange?.(false);},[busy,onBusyChange]);
  useEffect(()=>{onDirtyChange?.(dirty);return()=>onDirtyChange?.(false);},[dirty,onDirtyChange]);
  useEffect(()=>{const protect=(event:BeforeUnloadEvent)=>{if(dirty||pending.current)event.preventDefault();};window.addEventListener('beforeunload',protect);return()=>window.removeEventListener('beforeunload',protect);},[dirty]);
  const save=async(event:FormEvent)=>{event.preventDefault();if(pending.current||!original)return;pending.current=true;setBusy(true);setError('');abort.current=new AbortController();try{const body=await result<{members:WorkspaceMember[]}>(await fetch('/api/workspace-members',{method:'PATCH',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:abort.current.signal,body:JSON.stringify({accountId:editing,displayName:name.trim(),enabled})}));if(active.current){setMembers(body.members);setEditing('');notify('账号已更新');}}catch(cause){if(active.current)setError(cause instanceof Error?cause.message:'账号未能保存，请重试');}finally{pending.current=false;if(active.current)setBusy(false);}};
  const enabledCount = members.filter(item => item.enabled).length;
  const salesCount = members.filter(item => item.role === 'sales').length;
  const filteredMembers = members.filter(item => (roleFilter === 'all' || item.role === roleFilter) && (!memberSearch.trim() || item.displayName.toLowerCase().includes(memberSearch.trim().toLowerCase()) || item.username.toLowerCase().includes(memberSearch.trim().toLowerCase())));
  return <div className="admin-page"><header className="admin-page-heading"><div><h1>人员权限</h1><p>管理工作空间岗位账号、会话状态与角色隔离边界。</p></div><button className="button secondary" disabled={busy||dirty||loading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={15}/>刷新</button></header>{!loading&&members.length>0&&<div className="admin-kpi-grid" aria-label="成员统计"><div><span>全部成员</span><strong>{members.length}</strong><small>独立工作台身份</small></div><div><span>业务团队</span><strong>{salesCount}</strong><small>一线销售科室账号</small></div><div><span>活跃启用</span><strong>{enabledCount} / {members.length}</strong><small>{enabledCount === members.length ? '全部账号已启用' : `已停用 ${members.length - enabledCount} 个账号`}</small></div></div>}{error&&<ErrorNote error={error} retry={!busy&&!dirty?()=>setReload(value=>value+1):undefined}/>}<section className="admin-members" aria-label="工作台账号">{!loading&&members.length>0&&<div className="admin-members-toolbar"><div className="admin-role-filters" role="group" aria-label="按岗位角色筛选">{([['all',`全部 ${members.length}`],['sales',`一线销售 ${salesCount}`],['manager','销售管理者'],['admin','管理员']] as const).map(([key,label])=><button key={key} type="button" disabled={Boolean(editing)} aria-pressed={roleFilter===key} className={roleFilter===key?'is-active':''} onClick={()=>setRoleFilter(key)}>{label}</button>)}</div><label className="admin-member-search"><Search size={14} aria-hidden="true"/><input type="search" disabled={Boolean(editing)} aria-label="搜索成员账号" placeholder="搜索姓名或 @账号" value={memberSearch} onChange={event=>setMemberSearch(event.target.value)}/></label></div>}{!loading&&filteredMembers.length>0&&<div className="admin-members-head" aria-hidden="true"><span>成员与登录账号</span><span>岗位角色</span><span>权限与数据范围</span><span>状态与操作</span></div>}{loading?<p className="admin-loading" role="status"><Loader2 size={19} className="spin"/>正在读取账号…</p>:filteredMembers.length===0?<p className="admin-loading">没有符合筛选条件的成员账号。</p>:filteredMembers.map(item=><div className="admin-member" key={item.accountId}><div className="admin-member-identity"><span className="admin-member-avatar" data-avatar-tone={avatarTone(item.username)}>{item.displayName.slice(0,1)}</span><div><h2>{item.displayName}{item.accountId===member.accountId&&<span className="admin-current">当前账号</span>}</h2><p>@{item.username}</p></div></div>{editing===item.accountId?<form className="admin-member-form" onSubmit={event=>void save(event)}><label>显示名称<input value={name} maxLength={80} autoFocus required disabled={busy} onChange={event=>setName(event.target.value)}/></label><label className="admin-check"><input type="checkbox" checked={enabled} disabled={busy||item.accountId===member.accountId} onChange={event=>setEnabled(event.target.checked)}/>允许登录</label><div><button type="button" className="button secondary" disabled={busy} onClick={()=>setEditing('')}><X size={15}/>取消</button><button className="button primary" disabled={busy||!name.trim()||!dirty}>{busy?<Loader2 size={15} className="spin"/>:<Save size={15}/>}保存</button></div></form>:<>
    <div className="admin-member-role"><span className={`admin-role-pill role-${item.role}`}>{MEMBER_LABELS[item.role]}</span></div>
    <div className="admin-member-scope">{MEMBER_SCOPES[item.role]}</div>
    <div className="admin-member-actions"><span className={`admin-account-status ${item.enabled?'enabled':''}`}><i aria-hidden="true" />{item.enabled?'已启用':'已停用'}</span><button className="button secondary" disabled={!!editing||busy} onClick={()=>{setEditing(item.accountId);setName(item.displayName);setEnabled(item.enabled);setError('');}}><Pencil size={14}/>编辑</button></div>
  </> }</div>)}</section><p className="admin-footnote">停用账号会立即撤销其当前登录会话；管理员默认不获取客户项目与业务审批权限。</p></div>;
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
  return <div className="admin-page admin-rules"><header className="admin-page-heading"><div><h1>业务规则</h1><p>配置项目截止预警天数阈值与多级业务、合同审批流程模板。</p></div></header><section className="admin-rule-section"><div><h2>项目截止提醒</h2><p>当在跟项目距离截止时间不足设定天数时，自动在「提醒」与项目卡片高亮预警。</p></div>{error&&<ErrorNote error={error} retry={!busy&&!dirty?()=>setReload(value=>value+1):undefined}/>}<form onSubmit={event=>void save(event)}><div className="admin-thresholds"><label>紧急提醒<span>剩余不足</span><div className="admin-number"><input type="number" min="1" max="29" required value={urgent} disabled={loading||busy} onChange={event=>setUrgent(event.target.value)}/><span>天</span></div></label><label>常规提醒<span>剩余不足</span><div className="admin-number"><input type="number" min="2" max="30" required value={warning} disabled={loading||busy} onChange={event=>setWarning(event.target.value)}/><span>天</span></div></label></div><footer><p>{loading?'正在读取已保存规则…':dirty?'有尚未保存的修改':'当前规则已保存'}</p><button className="button primary" disabled={!saved||!dirty||busy||loading}>{busy?<Loader2 size={15} className="spin"/>:<Check size={15}/>}保存规则</button></footer></form></section><ApprovalWorkspace templatesOnly state={state} notify={notify} onBusyChange={templateBusyChanged} onDirtyChange={templateDirtyChanged}/></div>;
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
    <header className="knowledge-workspace-header">
      <div>
        <div className="knowledge-workspace-title-row">
          <h1>知识库</h1>
          {member.role === 'sales' && <span className="knowledge-readonly-pill">只读 · 管理员和销售管理者可维护</span>}
        </div>
        <p>管理部门专属资料库、业务方法沉淀与实战成单话术。</p>
      </div>
    </header>
    <nav className="knowledge-workspace-switch" aria-label="知识库内容">
      <button className={tab==='libraries'?'selected':''} aria-pressed={tab==='libraries'} onClick={()=>switchTab('libraries')}><Database size={16}/>资料库</button>
      <button className={tab==='documents'?'selected':''} aria-pressed={tab==='documents'} onClick={()=>switchTab('documents')}><BookOpen size={16}/>知识与方法</button>
      <button className={tab==='talktracks'?'selected':''} aria-pressed={tab==='talktracks'} onClick={()=>switchTab('talktracks')}><GitBranch size={16}/>成单话术</button>
    </nav>
    {tab==='libraries' ? <KnowledgeLibraries embedded notify={props.notify} onBusyChange={busyChanged} onDirtyChange={dirtyChanged}/> : tab==='documents' ?
      <KnowledgeView {...props} initialTab={member.role==='manager'&&focus==='skill-review'?'review':'knowledge'} canReviewSkills={member.role==='manager'} canSubmitExperience={member.role!=='admin'}/> :
      <TalkLibraryView {...props} initialTab={member.role==='manager'&&focus==='talk-review'?'review':'published'} canReview={member.role==='manager'} operational={member.role==='admin'} onUsePlaybook={onUsePlaybook}/>}
    {pendingTab&&<DiscardChangesDialog title="资料修改尚未保存" onCancel={()=>setPendingTab(null)} onDiscard={()=>{dirtyChanged(false);setTab(pendingTab);setPendingTab(null);}}/>}
  </div>;
}
