'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bell, BookOpen, BriefcaseBusiness, Check, CheckCheck, ChevronDown, ChevronRight, CircleAlert, ClipboardCheck, Clock3, ExternalLink, GitBranch, Home, Loader2, LogOut, Menu, MessageSquare, Moon, PanelLeftClose, Search, Settings, ShieldCheck, Sun, Users, Video, Workflow, X } from 'lucide-react';
import { useWorkbench } from '../lib/api';
import { useChatScroll } from '../lib/use-chat-scroll';
import { AGENTS, type AgentId, type Run, type View } from '../lib/types';
import { BrandMark, Composer, Overlay, shortDate, modelDisplayName } from './CoreViews';
import { ContractReviewView } from './ContractReviewView';
import { ApprovalWorkspace } from './ApprovalWorkspace';
import { SalesDailyReport } from './SalesDailyReport';
import { ProjectsView } from './ProjectWorkspace';
import { RunsView, SettingsView, TrainingView } from './StudioViews';
import { BuilderStudio } from './BuilderStudio';
import { AnswerContent } from './AnswerContent';
import './answer-content.css';
import { RoleDashboard } from './RoleDashboard';
import { AdminHome, BusinessRulesView, KnowledgeWorkspace, MEMBER_LABELS, MembersView } from './AdminWorkspace';
import type { MemberRole, MemberSession } from '../lib/member-types';
import { MeetingImportWorkspace } from './MeetingImportWorkspace';

type NavigationItem={id:View;label:string;icon:typeof Home};
const roleNavigation:Record<MemberRole,NavigationItem[]>={
  sales:[{id:'home',label:'今日工作',icon:Home},{id:'deals',label:'我的项目',icon:BriefcaseBusiness},{id:'meetings',label:'会议导入',icon:Video},{id:'knowledge',label:'话术资料',icon:BookOpen},{id:'training',label:'培训带练',icon:MessageSquare}],
  manager:[{id:'home',label:'团队总览',icon:Home},{id:'deals',label:'团队项目',icon:BriefcaseBusiness},{id:'meetings',label:'会议导入',icon:Video},{id:'approvals',label:'待我处理',icon:ClipboardCheck},{id:'knowledge',label:'话术知识',icon:BookOpen},{id:'training',label:'团队训练',icon:MessageSquare}],
  admin:[{id:'members',label:'人员权限',icon:Users},{id:'rules',label:'业务规则',icon:ShieldCheck},{id:'knowledge',label:'知识库',icon:BookOpen},{id:'settings',label:'服务连接',icon:Settings},{id:'studio',label:'搭建中心',icon:Workflow},{id:'runs',label:'系统运行',icon:Clock3}],
};
const permitted:Record<MemberRole,View[]>={sales:['home','deals','meetings','knowledge','talktracks','contracts','approvals','training','runs','studio'],manager:['home','deals','meetings','knowledge','talktracks','contracts','approvals','training','runs','reports','studio'],admin:['home','knowledge','talktracks','members','rules','settings','studio','runs','meetings']};

export default function Workbench({member,onLogout}:{member:MemberSession;onLogout:()=>Promise<void>}) {
  const navigation=roleNavigation[member.role];
  const { state, loading, error, mutate, reload, uploadFollowup } = useWorkbench();
  useEffect(()=>{
    const refreshSpeech=()=>{void reload().catch(()=>{});};
    window.addEventListener('speech-transcription-completed',refreshSpeech);
    return()=>window.removeEventListener('speech-transcription-completed',refreshSpeech);
  },[reload]);
  const [view, setView] = useState<View>('home');
  const [meetingEmbed, setMeetingEmbed] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [noticeRead, setNoticeRead] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [pendingQuery, setPendingQuery] = useState('');
  const [conversation, setConversation] = useState<Run[]>([]);
  const [chatError, setChatError] = useState('');
  const [failedRequest, setFailedRequest] = useState<{query:string;agentId?:AgentId;dealId?:string;conversationRunIds:string[];talkTrackIds?:string[]}|null>(null);
  const [selectedTalkIds,setSelectedTalkIds]=useState<string[]>([]);
  const [toast, setToast] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [projectIntent,setProjectIntent]=useState<'create'|'followup'|null>(null);
  const [focusedDeal, setFocusedDeal] = useState<string | null>(null);
  const [focusedApprovalContract, setFocusedApprovalContract] = useState<string | null>(null);
  const [focusedApprovalId, setFocusedApprovalId] = useState<string | null>(null);
  const [approvalPendingCount,setApprovalPendingCount]=useState(0);
  useEffect(()=>{
    if(member.role==='admin')return;
    let active=true;
    const refresh=()=>{void fetch('/api/approvals?scope=inbox&limit=1',{credentials:'same-origin',cache:'no-store'}).then(async response=>{if(!response.ok)return;const body=await response.json() as {pendingCount?:number};if(active&&Number.isInteger(body.pendingCount))setApprovalPendingCount(Math.max(0,body.pendingCount!));}).catch(()=>{});};
    refresh();const timer=setInterval(refresh,60000);window.addEventListener('ctai-approvals-updated',refresh);
    return ()=>{active=false;clearInterval(timer);window.removeEventListener('ctai-approvals-updated',refresh);};
  },[member.role]);
  const approvalBusy=useRef(false); const approvalDirty=useRef(false);
  const pendingApprovalLeave=useRef<(()=>void)|null>(null);
  const [leaveApproval,setLeaveApproval]=useState(false);
  const onApprovalBusy=useCallback((value:boolean)=>{approvalBusy.current=value;},[]);
  const onApprovalDirty=useCallback((value:boolean)=>{approvalDirty.current=value;},[]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sending = useRef(false);
  const trainingPending=useRef(0);
  const studioGuard=useRef<((proceed:()=>void)=>boolean)|null>(null);
  const onStudioGuardReady=useCallback((guard:((proceed:()=>void)=>boolean)|null)=>{studioGuard.current=guard;},[]);
  const contractBusy=useRef(false);const contractDirty=useRef(false);const pendingContractLeave=useRef<(()=>void)|null>(null);const [leaveContract,setLeaveContract]=useState(false);
  const onContractBusy=useCallback((value:boolean)=>{contractBusy.current=value;},[]);
  const onContractDirty=useCallback((value:boolean)=>{contractDirty.current=value;},[]);
  const projectBusy=useRef(false);const projectDirty=useRef(false);const pendingProjectLeave=useRef<(()=>void)|null>(null);const [leaveProject,setLeaveProject]=useState(false);
  const onProjectBusy=useCallback((value:boolean)=>{projectBusy.current=value;},[]);
  const onProjectDirty=useCallback((value:boolean)=>{projectDirty.current=value;},[]);
  const followupPending=useRef(false);
  const saveRecordingFollowup=useCallback(async (dealId:string,text:string,audio:File)=>{
    if(followupPending.current)throw new Error('录音正在保存，请等待完成');
    followupPending.current=true;
    try{return await uploadFollowup(dealId,text,audio);}finally{followupPending.current=false;}
  },[uploadFollowup]);
  const stopTrainingMedia=useRef<(()=>void)|null>(null);
  const onTrainingPendingChange=useCallback((count:number)=>{trainingPending.current=count;},[]);
  const onTrainingMediaReady=useCallback((stop:(()=>void)|null)=>{stopTrainingMedia.current=stop;},[]);
  const { containerRef, markUserInput, onScroll, showJump, jumpToLatest } = useChatScroll(`${conversation.map(r => r.id).join(',')}:${pendingQuery}:${chatBusy}:${chatOpen}`);
  const notify = useCallback((message: string) => { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const saved = localStorage.getItem('ctai-theme');
      if (saved === 'dark' || saved === 'light') { setTheme(saved); document.documentElement.dataset.mode = saved; }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearchOpen(v => !v); } if (e.key === 'Escape') { setMobileMenu(false); setNoticesOpen(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    const params=new URLSearchParams(window.location.search);
    if(params.get('view')==='meetings'){const id=params.get('deal');requestAnimationFrame(()=>{setView('meetings');setMeetingEmbed(params.get('embed')==='tencent');setFocusedDeal(id&&/^[a-zA-Z0-9-]{1,100}$/.test(id)?id:null);});}
    if(member.role==='manager'&&params.get('view')==='reports')requestAnimationFrame(()=>setView('reports'));
    if(member.role!=='admin'&&params.get('view')==='approvals'){const id=params.get('approval');requestAnimationFrame(()=>{setView('approvals');setFocusedApprovalId(id&&/^[a-zA-Z0-9-]{1,100}$/.test(id)?id:null);});}
  }, [member.role]);
  const navigate = useCallback((next: View, id?: string, contractId?:string, approvalId?:string,intent?:'create'|'followup') => {
    if(!permitted[member.role].includes(next)){notify('当前账号没有这个功能的访问权限');return;}
    if(next===view&&!id&&!intent){setMobileMenu(false);setSearchOpen(false);return;}
    if(projectBusy.current){notify('项目正在录入或更新，请等待完成后离开。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成后离开。');return;}
    if(contractBusy.current){notify('合同正在导入、保存或初审，请等待完成后离开。');return;}
    if(followupPending.current){notify('跟进录音正在保存，请等待完成后离开。');return;}
    if(trainingPending.current){notify('语音回应正在保存，请等待完成；失败时可在带练页直接重试。');return;}
    const proceed=()=>{stopTrainingMedia.current?.();setView(next);setProjectIntent(intent||null);setFocusedDeal(id||null);setFocusedApprovalContract(contractId||null);setFocusedApprovalId(approvalId||null);if(next!=='approvals'){const url=new URL(window.location.href);url.searchParams.delete('view');url.searchParams.delete('approval');window.history.replaceState(null,'',url.href);}setMobileMenu(false);setSearchOpen(false);setNoticesOpen(false);window.scrollTo({top:0,left:0,behavior:'auto'});};
    const guardedProceed=()=>{if(studioGuard.current&&!studioGuard.current(proceed)){setMobileMenu(false);setSearchOpen(false);setNoticesOpen(false);return;}proceed();};
    if(projectDirty.current){pendingProjectLeave.current=guardedProceed;setLeaveProject(true);return;}
    if(approvalDirty.current){pendingApprovalLeave.current=guardedProceed;setLeaveApproval(true);return;}
    if(contractDirty.current){pendingContractLeave.current=guardedProceed;setLeaveContract(true);return;}
    guardedProceed();
  }, [notify, view, member.role]);
  const toggleTheme = () => { const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); document.documentElement.dataset.mode = next; localStorage.setItem('ctai-theme', next); };
  const onAsk = useCallback((query: string, agentId?: AgentId, dealId?: string, talkTrackIds?:string[], priorRunIds?:string[]) => {
    if(member.role==='admin'){notify('请在搭建中心调试 Agent，销售助手由业务账号使用');return;}
    if(projectBusy.current){notify('项目正在录入或更新，请等待完成。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成。');return;}
    if(contractBusy.current){notify('合同初审正在进行，请等待完成。');return;}
    if(followupPending.current){notify('跟进录音正在保存，请等待完成。');return;}
    if (sending.current) { notify('当前任务正在生成，请等待完成后继续。'); return; }
    const proceed=()=>{
    const conversationRunIds=priorRunIds??conversation.filter(run=>!run.workflowId).slice(-6).map(run=>run.id);
    setChatOpen(true); setChatError(''); setFailedRequest(null); setPendingQuery(query); setChatBusy(true); sending.current = true;
    void mutate('chat', { query, conversationRunIds,talkTrackIds:talkTrackIds??selectedTalkIds, ...(agentId ? { agentId } : {}), ...(dealId ? { dealId } : {}) }).then(result => {
      if (result.run) setConversation(old => [...old, result.run!]);
      else {setChatError('任务未返回结果，请重试。');setFailedRequest({query,agentId,dealId,conversationRunIds,talkTrackIds:talkTrackIds??selectedTalkIds});}
    }).catch(cause => {setChatError(cause instanceof Error ? cause.message : '任务暂时未完成，请重试。');setFailedRequest({query,agentId,dealId,conversationRunIds,talkTrackIds:talkTrackIds??selectedTalkIds});}).finally(() => { setChatBusy(false); sending.current = false; setPendingQuery(''); });
    };
    if(studioGuard.current&&!studioGuard.current(proceed)){setChatOpen(false);return;}
    proceed();
  }, [mutate, notify, conversation,selectedTalkIds,member.role]);
  const requestLogout = () => {
    if(accountBusy)return;
    if(projectBusy.current||approvalBusy.current||contractBusy.current||followupPending.current||trainingPending.current||sending.current){notify('当前操作正在保存，请完成后再退出登录');return;}
    const proceed=()=>{stopTrainingMedia.current?.();setAccountBusy(true);void onLogout().catch(cause=>notify(cause instanceof Error?cause.message:'退出未完成，请重试')).finally(()=>setAccountBusy(false));};
    const guarded=()=>{if(studioGuard.current&&!studioGuard.current(proceed))return;proceed();};
    if(projectDirty.current){pendingProjectLeave.current=guarded;setLeaveProject(true);return;}
    if(approvalDirty.current){pendingApprovalLeave.current=guarded;setLeaveApproval(true);return;}
    if(contractDirty.current){pendingContractLeave.current=guarded;setLeaveContract(true);return;}
    guarded();
  };
  const searchResults = useMemo(() => {
    if (!state || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    return [
      ...state.deals.filter(d => `${d.projectName || ''} ${d.name} ${d.contact} ${d.summary}`.toLowerCase().includes(q)).map(d => ({ id: d.id, type: '项目', title: d.projectName || d.name, subtitle: `${d.name} · ${d.stage} · ${d.nextAction}`, view: 'deals' as View })),
      ...state.knowledge.filter(k => `${k.title} ${k.content}`.toLowerCase().includes(q)).map(k => ({ id: k.id, type: '知识', title: k.title, subtitle: k.category, view: 'knowledge' as View })),
      ...state.skills.filter(s => `${s.title} ${s.description}`.toLowerCase().includes(q)).map(s => ({ id: s.id, type: s.status === 'candidate' ? '候选 Skill' : 'Skill', title: s.title, subtitle: s.description, view: 'knowledge' as View })),
      ...state.runs.filter(r => r.query.toLowerCase().includes(q)).map(r => ({ id: r.id, type: '运行记录', title: r.query, subtitle: `${shortDate(r.createdAt)} · ${r.mode === 'demo' ? '本地生成' : '模型生成'}`, view: 'runs' as View })),
    ].slice(0, 15);
  }, [state, search]);
  if (loading || !state) return <div className="loading-screen"><BrandMark /><h1>CTAI 营销工作台</h1>{error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => void reload().catch(() => {})}>重新加载</button></> : <p><Loader2 size={16} className="spin" />正在准备你的工作空间…</p>}</div>;
  const candidates = state.skills.filter(s => s.status === 'candidate');
  const noticeCount = (state.role === 'manager' ? candidates.length : 0) + Math.min(3, state.activities.length);
  const props = { state, mutate, notify, onAsk };
  const title = navigation.find(n => n.id === view)?.label || ({home:'管理工作空间',contracts:'合同初审',approvals:'审批记录',talktracks:'成单话术',reports:'销售日报',runs:'任务记录',studio:'团队应用'} as Partial<Record<View,string>>)[view] || '工作空间';
  if(meetingEmbed)return <div className="meeting-embed-shell"><header className="meeting-embed-header"><span className="meeting-embed-brand"><BrandMark small/>CTAI</span><a href="/?view=meetings" target="_blank" rel="noopener noreferrer">完整工作台 <ExternalLink size={13}/></a><button className="icon-button" disabled={accountBusy} onClick={requestLogout} aria-label={`退出${member.displayName}的账号`} title={`当前账号：${member.displayName}`}>{accountBusy?<Loader2 size={16} className="spin"/>:<LogOut size={16}/>}</button></header>{toast&&<p className="meeting-message" role="status">{toast}</p>}<MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} initialDealId={focusedDeal} admin={member.role==='admin'} compact/></div>;
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-backdrop" onClick={() => setMobileMenu(false)} aria-label="关闭导航" />}
    <aside className={'sidebar '+(mobileMenu?'mobile-open':'')} aria-label="主导航">
      <div className="sidebar-brand"><button onClick={()=>navigate('home')} className="brand-link" aria-label="CTAI 营销工作台首页"><BrandMark small/><span>CTAI<span className="brand-divider"/><small>营销工作台</small></span></button><button className="icon-button close-nav" onClick={()=>setMobileMenu(false)} aria-label="收起导航"><PanelLeftClose size={18}/></button></div>
      {member.role!=='admin'&&<button className="new-task-button" onClick={()=>{setConversation([]);setFailedRequest(null);setChatError('');setChatOpen(true);setMobileMenu(false);}} disabled={chatBusy}><MessageSquare size={17}/><span>问助手</span><span className="task-plus">＋</span></button>}
      <div className="nav-caption">{MEMBER_LABELS[member.role]}工作台</div>
      <nav>{navigation.map(item=>{const Icon=item.icon;const current=view===item.id||(item.id==='knowledge'&&view==='talktracks');return <button key={item.id} className={'nav-item '+(current?'active':'')} onClick={()=>navigate(item.id)} aria-current={current?'page':undefined}><Icon size={18} strokeWidth={1.7}/><span>{item.label}</span>{item.id==='approvals'&&approvalPendingCount>0&&<small>{approvalPendingCount>99?'99+':approvalPendingCount}</small>}{item.id==='knowledge'&&member.role==='manager'&&candidates.length>0&&<small>{candidates.length}</small>}</button>;})}</nav>
      <div className="sidebar-recent"><div className="nav-caption">{member.role==='admin'?'系统记录':'最近任务'}<button className="icon-button" onClick={()=>navigate('runs')} aria-label="全部任务记录"><ChevronRight size={13}/></button></div>{state.runs.slice(0,3).map(run=><button key={run.id} onClick={()=>{if(member.role==='admin'){navigate('runs');return;}setConversation([run]);setFailedRequest(null);setChatError('');setChatOpen(true);setMobileMenu(false);}} title={run.query}><span/>{run.query}</button>)}{!state.runs.length&&<p>完成任务后，记录会显示在这里。</p>}</div>
      <div className="sidebar-bottom"><div className="connection-status"><span className={'status-dot '+(state.model.connected?'connected':'')}/><span>{state.model.connected?modelDisplayName(state.model.name)+' · 已连接':'模型服务待配置'}</span></div><div className="account-footer-controls"><span>当前工作空间</span><button className="icon-button" onClick={toggleTheme} aria-label={theme==='light'?'切换深色主题':'切换浅色主题'}>{theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</button></div><div className="profile-row"><span className="profile-avatar">{member.displayName.slice(0,1)}</span><div><strong>{member.displayName}</strong><span>{MEMBER_LABELS[member.role]} · {member.username}</span></div><button className="account-logout" onClick={requestLogout} disabled={accountBusy} aria-label="退出登录" title="退出登录">{accountBusy?<Loader2 size={17} className="spin"/>:<LogOut size={17}/>}</button></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={()=>setMobileMenu(true)} aria-label="展开导航"><Menu size={21}/></button><span className="breadcrumb">{MEMBER_LABELS[member.role]} <ChevronRight size={13}/><strong>{title}</strong></span></div><div className="topbar-actions"><button className="global-search" aria-label="搜索工作空间" onClick={()=>{setSearch('');setSearchOpen(true);}}><Search size={16}/><span>搜索工作空间</span><kbd>⌘ K</kbd></button><div className="topbar-divider"/><button className="icon-button notification-button" onClick={()=>{setNoticesOpen(true);setNoticeRead(true);}} aria-label={'通知'+(noticeCount?'，'+noticeCount+'项动态':'')}><Bell size={18}/>{noticeCount>0&&!noticeRead&&<i/>}</button><span className="topbar-avatar" aria-label={member.displayName}>{member.displayName.slice(0,1)}</span></div></header>
      <main className="main-content" key={view}>
        {view==='home'&&(member.role==='admin'?<AdminHome state={state} onNavigate={navigate}/>:<RoleDashboard {...props} member={member} onNavigate={navigate} onRecordCustomer={()=>navigate('deals',undefined,undefined,undefined,'create')} onRecordFollowup={()=>navigate('deals',undefined,undefined,undefined,'followup')} pendingApprovals={approvalPendingCount}/>)}
        {view==='reports'&&member.role==='manager'&&<SalesDailyReport state={state} notify={notify} onNavigate={navigate}/>}
        {view==='meetings'&&<MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} initialDealId={focusedDeal} admin={member.role==='admin'} onOpenProjects={()=>navigate('deals')}/>}
        {view==='deals'&&member.role!=='admin'&&<ProjectsView member={member} key={(focusedDeal||'all')+':'+(projectIntent||'')} {...props} uploadFollowup={saveRecordingFollowup} onReload={reload} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty} onNavigate={navigate} onApproval={(projectId,requestId)=>navigate('approvals',projectId,undefined,requestId)} initialDealId={focusedDeal} initialIntent={projectIntent} onDealClosed={()=>{setFocusedDeal(null);setProjectIntent(null);}}/>}
        {view==='contracts'&&member.role!=='admin'&&<ContractReviewView key={focusedDeal||'all'} {...props} initialDealId={focusedDeal} onNavigate={navigate} onBusyChange={onContractBusy} onDirtyChange={onContractDirty} onApproval={(contractId,dealId)=>navigate('approvals',dealId,contractId)}/>}
        {view==='training'&&member.role!=='admin'&&<TrainingView {...props} onPendingChange={onTrainingPendingChange} onMediaStopReady={onTrainingMediaReady}/>}
        {view==='approvals'&&member.role!=='admin'&&<ApprovalWorkspace key={(focusedDeal||'all')+':'+(focusedApprovalContract||'')+':'+(focusedApprovalId||'')} state={state} notify={notify} onNavigate={navigate} onReloadWorkspace={reload} initialDealId={focusedDeal} initialContractId={focusedApprovalContract} initialApprovalId={focusedApprovalId} onBusyChange={onApprovalBusy} onDirtyChange={onApprovalDirty}/>}
        {(view==='knowledge'||view==='talktracks')&&<KnowledgeWorkspace key={view+':'+(focusedDeal||'')} focus={focusedDeal} {...props} member={member} initialTab={view==='talktracks'?'talktracks':'documents'} onUsePlaybook={id=>{if(member.role==='admin')return;setSelectedTalkIds([id]);setConversation([]);setFailedRequest(null);setChatError('');setChatOpen(true);}}/>}
        {view==='studio'&&<BuilderStudio {...props} readOnly={member.role!=='admin'} onGuardReady={onStudioGuardReady}/>}
        {view==='runs'&&<RunsView {...props} canExtract={member.role!=='admin'}/>}
        {view==='settings'&&member.role==='admin'&&<><SettingsView {...props} onConnectionChanged={reload}/><section className="meeting-settings-status"><MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} admin/></section></>}
        {view==='members'&&member.role==='admin'&&<MembersView member={member} notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='rules'&&member.role==='admin'&&<BusinessRulesView state={state} notify={notify} onBusyChange={onApprovalBusy} onDirtyChange={onApprovalDirty}/>}
      </main>
    </div>
    {member.role!=='admin'&&<nav className="mobile-role-navigation" aria-label="快捷导航">{navigation.filter(item=>item.id!=='meetings').map(item=>{const Icon=item.icon;return <button key={item.id} aria-current={view===item.id?'page':undefined} onClick={()=>navigate(item.id)}><Icon size={20}/><span>{item.label}</span></button>;})}</nav>}
    {leaveProject&&<Overlay className="confirmation-dialog" title="有尚未保存的内容" onClose={()=>{setLeaveProject(false);pendingProjectLeave.current=null;}}><p>离开会丢弃本次尚未保存的修改或录入。</p><div className="contract-leave-actions"><button data-dialog-initial-focus="true" className="button secondary" onClick={()=>{setLeaveProject(false);pendingProjectLeave.current=null;}}>继续编辑</button><button className="button primary" onClick={()=>{projectDirty.current=false;setLeaveProject(false);const proceed=pendingProjectLeave.current;pendingProjectLeave.current=null;proceed?.();}}>放弃并离开</button></div></Overlay>}
    {leaveApproval&&<Overlay className="confirmation-dialog" title="审批内容尚未提交" onClose={()=>{setLeaveApproval(false);pendingApprovalLeave.current=null;}}><p>离开会丢弃尚未提交的申请或流程修改。</p><div className="contract-leave-actions"><button data-dialog-initial-focus="true" className="button secondary" onClick={()=>{setLeaveApproval(false);pendingApprovalLeave.current=null;}}>继续编辑</button><button className="button primary" onClick={()=>{approvalDirty.current=false;setLeaveApproval(false);const proceed=pendingApprovalLeave.current;pendingApprovalLeave.current=null;proceed?.();}}>放弃更改并离开</button></div></Overlay>}
    {leaveContract&&<Overlay className="confirmation-dialog" title="合同草稿尚未保存" onClose={()=>{setLeaveContract(false);pendingContractLeave.current=null;}}><p>离开会丢弃尚未保存的合同更改。</p><div className="contract-leave-actions"><button data-dialog-initial-focus="true" className="button secondary" onClick={()=>{setLeaveContract(false);pendingContractLeave.current=null;}}>继续编辑</button><button className="button primary" onClick={()=>{contractDirty.current=false;setLeaveContract(false);const proceed=pendingContractLeave.current;pendingContractLeave.current=null;proceed?.();}}>放弃更改并离开</button></div></Overlay>}
    {searchOpen && <Overlay title="搜索工作空间" onClose={() => setSearchOpen(false)} className="search-dialog"><label className="modal-search"><Search size={19} /><input autoFocus placeholder="搜索项目、客户、知识或任务…" aria-label="搜索全部工作空间" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC</kbd></label><div className="search-results">{!search.trim() ? <><p className="search-hint">快速前往</p>{navigation.filter(item=>item.id!=='reports'||state.role==='manager').map(n => { const Icon = n.icon; return <button className="search-result" key={n.id} onClick={() => navigate(n.id)}><Icon size={19} /><span><strong>{n.label}</strong><small>工作空间</small></span><ArrowRight size={15} /></button>; })}</> : searchResults.length ? <><p className="search-hint">找到 {searchResults.length} 项结果</p>{searchResults.map((r, i) => <button key={`${r.type}-${r.id}-${i}`} className="search-result" onClick={() => { if (r.view === 'runs') { const run = state.runs.find(x => x.id === r.id); if (run) { setConversation([run]);setChatError('');setFailedRequest(null); setChatOpen(true); setSearchOpen(false); } } else { navigate(r.view, r.view === 'deals' ? r.id : undefined); } }}><span className="search-result-icon">{r.view === 'deals' ? <BriefcaseBusiness size={18} /> : r.view === 'runs' ? <Clock3 size={18} /> : <BookOpen size={18} />}</span><span><strong>{r.title}</strong><small>{r.type} · {r.subtitle}</small></span><ArrowRight size={15} /></button>)}</> : <div className="empty-state"><Search size={25} /><h3>没有找到“{search}”</h3><p>可以尝试客户名称、联系人或更短的关键词。</p></div>}</div></Overlay>}
    {noticesOpen && <Overlay title="工作动态" onClose={() => setNoticesOpen(false)} className="notifications-dialog"><div className="notice-intro"><CheckCheck size={15} />当前工作空间的业务动态</div>{state.role === 'manager' && candidates.length > 0 && <button className="notification-item" onClick={() => navigate('knowledge')}><span className="notification-symbol"><BookOpen size={18} /></span><span><strong>{candidates.length} 项候选 Skill 待你审核</strong><p>检查证据与适用边界后，由你决定发布。</p><small>需要人工确认</small></span><ChevronRight size={16} /></button>}{state.activities.slice(0, 8).map(a => <div className="notification-item" key={a.id}><span className="notification-symbol"><Clock3 size={17} /></span><span><strong>{a.title}</strong><p>{a.detail}</p><small>{new Date(a.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span></div>)}{noticeCount === 0 && <div className="empty-state"><Bell size={28} /><h3>现在没有新的动态</h3><p>完成任务后，相关记录会出现在这里。</p></div>}</Overlay>}
    {chatOpen && <Overlay title={state.role === 'sales' ? '销售 Agent' : '管理 Agent'} onClose={() => setChatOpen(false)} className="drawer chat-drawer" wide><div className="chat-status"><span>任务结果请核对后使用</span></div><div className="chat-stream" ref={containerRef} onScroll={onScroll} onWheel={markUserInput} onTouchStart={markUserInput} onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) markUserInput(); }} tabIndex={0}>{conversation.length === 0 && !pendingQuery && !failedRequest && <div className="chat-welcome"><BrandMark /><h2>一起，把任务往前推进。</h2><p>描述客户情况与目标，我会调度合适的专家协作。</p><div>{AGENTS.map(a => <button key={a.id} onClick={() => onAsk(a.starter, a.id)}>{a.name}<ArrowRight size={13} /></button>)}</div></div>}{conversation.map(run => <article className="chat-turn" key={run.id}><div className="user-message">{run.query}</div><div className="assistant-label"><BrandMark small /><strong>CTAI</strong><span>{run.mode === 'demo' ? '本地生成' : '模型生成'}</span></div><details className="trace-accordion"><summary><span><GitBranch size={15} />{run.agentIds.map(id => AGENTS.find(a => a.id === id)?.name).join(' → ') || '主 Agent'}<small>{run.steps.length} 个步骤</small></span><ChevronDown size={15} /></summary><div className="trace-steps">{run.steps.map(step => <div className="trace-step" key={step.id}><span className={`trace-icon ${step.status}`}>{step.status === 'success' ? <Check size={12} /> : <CircleAlert size={12} />}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><small>{step.duration}ms</small></div>)}</div></details><AnswerContent className="assistant-answer" text={run.answer} />{run.citations.length > 0 && <div className="citations"><h3><BookOpen size={14} />参考来源</h3>{run.citations.map((c, i) => <details key={c.id}><summary><span>{i + 1}</span>{c.title}<ChevronDown size={13} /></summary><p>{c.excerpt}</p></details>)}</div>}<div className="answer-footer"><span>{shortDate(run.createdAt)} · {Math.max(0.1, run.duration / 1000).toFixed(1)}s</span><button className="text-button" onClick={() => { void navigator.clipboard.writeText(run.answer).then(() => notify('已复制任务结果')).catch(() => notify('浏览器未允许复制，请手动选择结果。')); }}>复制结果</button><button className="text-button" onClick={() => { setChatOpen(false); navigate('runs'); }}>运行详情 <ExternalLink size={12} /></button></div></article>)}{(pendingQuery || failedRequest) && <div className="chat-turn"><div className="user-message">{pendingQuery || failedRequest?.query}</div>{pendingQuery && <div className="thinking-line"><BrandMark small /><span>正在处理你的问题</span><i /><i /><i /></div>}</div>}{chatError && <div className="error-message" role="alert"><CircleAlert size={17} /><span>{chatError}</span></div>}{failedRequest && <button className="button secondary" disabled={chatBusy} onClick={() => onAsk(failedRequest.query, failedRequest.agentId, failedRequest.dealId, failedRequest.talkTrackIds, failedRequest.conversationRunIds)}>重试本次问题</button>}</div>{showJump && <button className="jump-latest button secondary" onClick={jumpToLatest}><ArrowDown size={14} />回到最新</button>}<div className="chat-composer-wrap"><Composer talkTracks={state.talkTracks??[]} selectedTalkTrackIds={selectedTalkIds} onTalkTrackChange={setSelectedTalkIds} onSend={(q,a,ids)=>onAsk(q,a,undefined,ids)} placeholder="补充背景，或继续一个新问题…" compact busy={chatBusy} modelConnected={state.model.connected} /><p>Enter 发送 · Shift + Enter 换行</p></div></Overlay>}
    {toast && <div role="status" className="toast"><Check size={16} />{toast}<button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}
