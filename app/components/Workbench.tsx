'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDown, ArrowRight, Bell, BookOpen, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ChevronRight, CircleAlert, ClipboardCheck, Clock3, ExternalLink, GitBranch, Globe2, Home, Loader2, LogOut, Menu, MessageSquare, Moon, PanelLeftClose, Presentation, Search, Settings, ShieldCheck, Sun, Users, Video, Workflow, X } from 'lucide-react';
import { useWorkbench } from '../lib/api';
import { useChatScroll } from '../lib/use-chat-scroll';
import { upsertChatProgressStep, type ChatProgressStep } from '../lib/chat-progress';
import { isCompletedChatRun, isMatchingChatRun } from '../lib/chat-request';
import { canOpenWorkspaceView, readWorkspaceRoute, workspaceManagementNavigation, workspaceNavigation, workspaceSearch, workspaceSection, workspaceTitle } from '../lib/workspace-navigation';
import { AGENTS, type AgentId, type Run, type View } from '../lib/types';
import { runGenerationLabel } from '../lib/run-history';
import { BrandMark, Composer, DiscardChangesDialog, Overlay, shortDate } from './CoreViews';
import { ContractCenter } from './ContractCenter';
import { SalesDailyReport } from './SalesDailyReport';
import { CustomerWorkspace } from './CustomerWorkspace';
import { AgentMemoryButton } from './AgentMemoryPanel';
import { RunsView, SettingsView, TrainingView } from './StudioViews';
import { BuilderStudio } from './BuilderStudio';
import { AnswerContent } from './AnswerContent';
import { ChatProcessing } from './ChatProcessing';
import './answer-content.css';
import { AdminHome, BusinessRulesView, KnowledgeWorkspace, MEMBER_LABELS, MembersView } from './AdminWorkspace';
import type { MemberSession } from '../lib/member-types';
import { MeetingImportWorkspace } from './MeetingImportWorkspace';
import { ProspectingWorkspace } from './ProspectingWorkspace';
import { ScheduleWorkspace } from './ScheduleWorkspace';
import MarketingMaterials from './MarketingMaterials';
import GEOWorkspace from './GEOWorkspace';

const navigationIcons: Partial<Record<View, typeof Home>> = {
  home:Home, deals:BriefcaseBusiness, schedule:CalendarDays, meetings:Video, prospecting:Search, geo:Globe2, materials:Presentation,
  knowledge:BookOpen, training:MessageSquare, approvals:ClipboardCheck, contracts:ClipboardCheck,
  members:Users, rules:ShieldCheck, settings:Settings, studio:Workflow, runs:Clock3,
};

export default function Workbench({member,onLogout}:{member:MemberSession;onLogout:()=>Promise<void>}) {
  const navigation=workspaceNavigation(member.role).map(item=>({...item,icon:navigationIcons[item.id]??Home}));
  const { state, loading, error, mutate, reload } = useWorkbench();
  useEffect(()=>{
    const refreshSpeech=()=>{void reload().catch(()=>{});};
    window.addEventListener('speech-transcription-completed',refreshSpeech);
    return()=>window.removeEventListener('speech-transcription-completed',refreshSpeech);
  },[reload]);
  const [view, setView] = useState<View>(member.role==='admin'?'home':'deals');
  const [routeReady,setRouteReady]=useState(false);
  const [prospectingSection,setProspectingSection]=useState<'create'|'screen'|'handoff'|'web'>('screen');
  const [navigationKey, setNavigationKey] = useState(0);
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
  const [chatProgress, setChatProgress] = useState<ChatProgressStep[]>([]);
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
  const prospectingGuard=useRef<((proceed:()=>void)=>boolean)|null>(null);
  const onProspectingGuardReady=useCallback((guard:((proceed:()=>void)=>boolean)|null)=>{prospectingGuard.current=guard;},[]);
  const onStudioGuardReady=useCallback((guard:((proceed:()=>void)=>boolean)|null)=>{studioGuard.current=guard;},[]);
  const contractBusy=useRef(false);const contractDirty=useRef(false);const pendingContractLeave=useRef<(()=>void)|null>(null);const [leaveContract,setLeaveContract]=useState(false);
  const onContractBusy=useCallback((value:boolean)=>{contractBusy.current=value;},[]);
  const onContractDirty=useCallback((value:boolean)=>{contractDirty.current=value;},[]);
  const projectBusy=useRef(false);const projectDirty=useRef(false);const pendingProjectLeave=useRef<(()=>void)|null>(null);const [leaveProject,setLeaveProject]=useState(false);
  const onProjectBusy=useCallback((value:boolean)=>{projectBusy.current=value;},[]);
  const onProjectDirty=useCallback((value:boolean)=>{projectDirty.current=value;},[]);
  const stopTrainingMedia=useRef<(()=>void)|null>(null);
  const onTrainingPendingChange=useCallback((count:number)=>{trainingPending.current=count;},[]);
  const onTrainingMediaReady=useCallback((stop:(()=>void)|null)=>{stopTrainingMedia.current=stop;},[]);
  const { containerRef, markUserInput, onScroll, showJump, jumpToLatest } = useChatScroll(`${conversation.map(r => r.id).join(',')}:${pendingQuery}:${chatBusy}:${chatOpen}:${chatProgress.map(step => step.id+step.status).join(",")}`);
  const notify = useCallback((message: string) => { setToast(message); if (toastTimer.current) clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 4200); }, [setToast]);
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
    const route=readWorkspaceRoute(window.location.search,member.role);
    // Initial routing does not depend on a paint. Safari can suspend animation
    // frames while the workspace is in a background tab.
    const timer=window.setTimeout(()=>{
      setView(route.view);
      setProjectIntent(route.intent??null);
      setMeetingEmbed(route.meetingEmbed===true);
      setFocusedDeal(route.focus??route.dealId??null);
      setFocusedApprovalContract(route.contractId??null);
      setFocusedApprovalId(route.approvalId??null);
      setProspectingSection(route.prospectingSection??'screen');
      setRouteReady(true);
    });
    return()=>window.clearTimeout(timer);
  }, [member.role]);
  const navigate = useCallback((next: View, id?: string, contractId?:string, approvalId?:string,intent?:'create'|'followup') => {
    if(!canOpenWorkspaceView(member.role,next)){notify('当前账号没有这个功能的访问权限');return;}
    if(next==='home'&&member.role!=='admin')next='deals';
    if(next==='meetings')next=member.role==='admin'?'settings':'schedule';
    if(next===view&&!id&&!intent&&!contractId&&!approvalId){setMobileMenu(false);setSearchOpen(false);return;}
    if(projectBusy.current){notify('当前内容正在处理，请等待完成后离开。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成后离开。');return;}
    if(contractBusy.current){notify('合同正在导入、保存或初审，请等待完成后离开。');return;}
    if(trainingPending.current){notify('语音回应正在保存，请等待完成；失败时可在带练页直接重试。');return;}
    const proceed=()=>{stopTrainingMedia.current?.();setView(next);setMeetingEmbed(false);setProspectingSection('screen');if(next==='deals')setNavigationKey(value=>value+1);setProjectIntent(intent||null);setFocusedDeal(id||null);setFocusedApprovalContract(contractId||null);setFocusedApprovalId(approvalId||null);const url=new URL(window.location.href);url.search=workspaceSearch(url.search,{view:next,...(next==='knowledge'||next==='talktracks'?{focus:id}:{dealId:id}),contractId,approvalId,intent});window.history.replaceState(null,'',url.href);setMobileMenu(false);setSearchOpen(false);setNoticesOpen(false);window.scrollTo({top:0,left:0,behavior:'auto'});};
    const guardedProceed=()=>{if(prospectingGuard.current&&!prospectingGuard.current(proceed)){setMobileMenu(false);setSearchOpen(false);setNoticesOpen(false);return;}if(studioGuard.current&&!studioGuard.current(proceed)){setMobileMenu(false);setSearchOpen(false);setNoticesOpen(false);return;}proceed();};
    if(projectDirty.current){pendingProjectLeave.current=guardedProceed;setLeaveProject(true);return;}
    if(approvalDirty.current){pendingApprovalLeave.current=guardedProceed;setLeaveApproval(true);return;}
    if(contractDirty.current){pendingContractLeave.current=guardedProceed;setLeaveContract(true);return;}
    guardedProceed();
  }, [notify, view, member.role, setView, setProjectIntent, setFocusedDeal, setFocusedApprovalContract, setFocusedApprovalId, setMobileMenu, setSearchOpen, setNoticesOpen, setLeaveProject, setLeaveApproval, setLeaveContract]);
  const toggleTheme = () => { const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); document.documentElement.dataset.mode = next; localStorage.setItem('ctai-theme', next); };
  const onAsk = useCallback((query: string, agentId?: AgentId, dealId?: string, talkTrackIds?:string[], priorRunIds?:string[]) => {
    if(member.role==='admin'){notify('请在搭建中心调试 Agent，销售助手由业务账号使用');return;}
    if(projectBusy.current){notify('项目正在录入或更新，请等待完成。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成。');return;}
    if(contractBusy.current){notify('合同初审正在进行，请等待完成。');return;}
    if (sending.current) { notify('当前任务正在生成，请等待完成后继续。'); return; }
    const proceed = () => {
      if (sending.current) return;
      const conversationRunIds = priorRunIds ?? conversation
        .filter(run => isCompletedChatRun(run) && (dealId === undefined || run.dealId === dealId))
        .slice(-6).map(run => run.id);
      const request = { query, agentId, dealId, conversationRunIds, talkTrackIds: talkTrackIds ?? selectedTalkIds };
      setChatOpen(true); setChatError(''); setFailedRequest(null); setPendingQuery(query); setChatProgress([]); setChatBusy(true); sending.current = true;
      void mutate('chat', request, step => setChatProgress(current => upsertChatProgressStep(current, step))).then(result => {
        const run = result.run;
        if (!isMatchingChatRun(run, request)) throw new Error('本次未返回当前问题的完整回答，请重试。');
        setConversation(old => old.some(item => item.id === run.id) ? old : [...old, run]);
      }).catch(cause => {
        setChatError(cause instanceof Error ? cause.message : '任务暂时未完成，请重试。');
        setFailedRequest(request);
      }).finally(() => { setChatBusy(false); sending.current = false; setPendingQuery(''); setChatProgress([]); });
    };
    if(studioGuard.current&&!studioGuard.current(proceed)){setChatOpen(false);return;}
    proceed();
  }, [mutate, notify, conversation,selectedTalkIds,member.role,setChatOpen,setChatError,setFailedRequest,setPendingQuery,setChatBusy,setConversation]);
  const requestLogout = () => {
    if(accountBusy)return;
    if(projectBusy.current||approvalBusy.current||contractBusy.current||trainingPending.current||sending.current){notify('当前操作正在保存，请完成后再退出登录');return;}
    const proceed=()=>{stopTrainingMedia.current?.();setAccountBusy(true);void onLogout().catch(cause=>notify(cause instanceof Error?cause.message:'退出未完成，请重试')).finally(()=>setAccountBusy(false));};
    const guarded=()=>{if(prospectingGuard.current&&!prospectingGuard.current(proceed))return;if(studioGuard.current&&!studioGuard.current(proceed))return;proceed();};
    if(projectDirty.current){pendingProjectLeave.current=guarded;setLeaveProject(true);return;}
    if(approvalDirty.current){pendingApprovalLeave.current=guarded;setLeaveApproval(true);return;}
    if(contractDirty.current){pendingContractLeave.current=guarded;setLeaveContract(true);return;}
    guarded();
  };
  const searchResults = useMemo(() => {
    if (!state || !search.trim()) return [];
    const q = search.trim().toLowerCase();
    return [
      ...(canOpenWorkspaceView(member.role,'schedule')&&'提醒及日程 智能日程 任务 安排 拜访 calendar schedule'.includes(q)?[{id:'schedule',type:'功能',title:'提醒及日程',subtitle:'提醒、任务、日程与拜访',view:'schedule' as View}]:[]),
      ...state.deals.filter(d => `${d.projectName || ''} ${d.name} ${d.contact} ${d.summary}`.toLowerCase().includes(q)).map(d => ({ id: d.id, type: '项目', title: d.projectName || d.name, subtitle: `${d.name} · ${d.stage} · ${d.nextAction}`, view: 'deals' as View })),
      ...state.knowledge.filter(k => `${k.title} ${k.content}`.toLowerCase().includes(q)).map(k => ({ id: k.id, type: '知识', title: k.title, subtitle: k.category, view: 'knowledge' as View })),
      ...state.skills.filter(s => `${s.title} ${s.description}`.toLowerCase().includes(q)).map(s => ({ id: s.id, type: s.status === 'candidate' ? '候选 Skill' : 'Skill', title: s.title, subtitle: s.description, view: 'knowledge' as View })),
      ...state.runs.filter(r => r.query.toLowerCase().includes(q)).map(r => ({ id: r.id, type: '运行记录', title: r.query, subtitle: `${shortDate(r.createdAt)} · ${runGenerationLabel(r)}`, view: 'runs' as View })),
    ].slice(0, 15);
  }, [state, search, member.role]);
  const onSelectedDealChange=useCallback((id:string)=>{
    setFocusedDeal(id);setProjectIntent(null);
    const url=new URL(window.location.href);url.search=workspaceSearch(url.search,{view:'deals',dealId:id});window.history.replaceState(null,'',url.href);
  },[]);
  const onProspectingSectionChange=useCallback((section:'create'|'screen'|'handoff'|'web')=>{
    setProspectingSection(section);
    const url=new URL(window.location.href);url.search=workspaceSearch(url.search,{view:'prospecting',prospectingSection:section});window.history.replaceState(null,'',url.href);
  },[]);
  if (loading || !state || !routeReady) return <div className="loading-screen"><BrandMark /><h1>AI营销工作台</h1>{error ? <><p role="alert">{error}</p><button className="button secondary" onClick={() => void reload().catch(() => {})}>重新加载</button></> : <p><Loader2 size={16} className="spin" />正在加载…</p>}</div>;
  const candidates = state.skills.filter(s => s.status === 'candidate');
  const noticeCount = (state.role === 'manager' ? candidates.length : 0) + Math.min(3, state.activities.length);
  const props = { state, mutate, notify, onAsk };
  const title = workspaceTitle(view,member.role);
  const section = workspaceSection(view,member.role);
  const homeView=member.role==='admin'?'home':'deals';
  const managementNavigation = workspaceManagementNavigation(member.role);
  const linkProps = (next:View,id?:string,intent?:'create'|'followup') => ({
    href:'/'+workspaceSearch('',{view:next,dealId:id,intent}),
    onClick:(event:MouseEvent<HTMLAnchorElement>)=>{
      if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;
      event.preventDefault();
      const menu=event.currentTarget.closest('details');if(menu)menu.open=false;
      navigate(next,id,undefined,undefined,intent);
    },
  });
  const globalControls = <><button className="global-search" aria-label="搜索工作空间" onClick={()=>{setSearch('');setSearchOpen(true);}}><Search size={16}/><span>搜索</span><kbd>⌘ K</kbd></button><button className="icon-button notification-button" onClick={()=>{setNoticesOpen(true);setNoticeRead(true);}} aria-label={'通知'+(noticeCount?'，'+noticeCount+'项动态':'')}><Bell size={18}/>{noticeCount>0&&!noticeRead&&<i/>}</button></>;
  if(meetingEmbed)return <div className="meeting-embed-shell"><header className="meeting-embed-header"><span className="meeting-embed-brand"><BrandMark small/>AI营销工作台</span><a href="/?view=meetings" target="_blank" rel="noopener noreferrer">完整工作台 <ExternalLink size={13}/></a><button className="icon-button" disabled={accountBusy} onClick={requestLogout} aria-label={`退出${member.displayName}的账号`} title={`当前账号：${member.displayName}`}>{accountBusy?<Loader2 size={16} className="spin"/>:<LogOut size={16}/>}</button></header>{toast&&<p className="meeting-message" role="status">{toast}</p>}<MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} initialDealId={focusedDeal} admin={member.role==='admin'} compact/></div>;
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-backdrop" onClick={() => setMobileMenu(false)} aria-label="关闭导航" />}
    <aside className={'sidebar '+(mobileMenu?'mobile-open':'')} aria-label="主导航">
      <div className="sidebar-brand"><a {...linkProps(homeView)} className="brand-link" aria-label="AI营销工作台首页"><BrandMark small/><span>AI营销工作台</span></a><button className="icon-button close-nav" onClick={()=>setMobileMenu(false)} aria-label="收起导航"><PanelLeftClose size={18}/></button></div>
      <div className="sidebar-tools">{globalControls}</div>
      {member.role!=='admin'&&<button className="new-task-button" onClick={()=>{setConversation([]);setFailedRequest(null);setChatError('');setChatOpen(true);setMobileMenu(false);}} disabled={chatBusy}><MessageSquare size={17}/><span>AI 营销助手</span></button>}
      <nav aria-label="业务导航">{navigation.map(item=>{const Icon=item.icon;const current=section===item.id;return <a key={item.id} {...linkProps(item.id)} className={'nav-item '+(current?'active':'')} aria-current={current?'page':undefined}><Icon size={18} strokeWidth={1.7}/><span>{item.label}</span>{item.id==='contracts'&&approvalPendingCount>0&&<small aria-label={`${approvalPendingCount} 项待审批`}>{approvalPendingCount>99?'99+':approvalPendingCount}</small>}{item.id==='knowledge'&&member.role==='manager'&&candidates.length>0&&<small>{candidates.length}</small>}</a>;})}</nav>
      {member.role!=='admin'&&<div className="sidebar-recent"><div className="nav-caption">{state.runs.length?'最近 AI 任务':'AI 任务记录'}<button className="icon-button" onClick={()=>navigate('runs')} aria-label="全部 AI 任务记录"><ChevronRight size={13}/></button></div>{state.runs.slice(0,3).map(run=><button key={run.id} onClick={()=>{if(member.role==='admin'){navigate('runs');return;}setConversation([run]);setFailedRequest(null);setChatError('');setChatOpen(true);setMobileMenu(false);}} title={run.query}><span/>{run.query}</button>)}</div>}
      <div className="sidebar-bottom">{managementNavigation.length>0&&<details className="management-menu" onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary className="nav-item"><Settings size={17}/><span>系统管理</span><ChevronDown size={14}/></summary><nav aria-label="系统管理导航">{managementNavigation.map(item=><a key={item.id} {...linkProps(item.id)} aria-current={view===item.id?'page':undefined}>{item.label}</a>)}</nav></details>}<div className="connection-status"><span className={'status-dot '+(state.model.connected?'connected':'')}/><span>{state.model.connected?'模型已连接':'模型未配置'}</span></div><div className="profile-row"><span className="profile-avatar">{member.displayName.slice(0,1)}</span><div><strong>{member.displayName}</strong><span>{MEMBER_LABELS[member.role]} · {member.username}</span></div><button className="icon-button" onClick={toggleTheme} aria-label={theme==='light'?'切换深色主题':'切换浅色主题'}>{theme==='light'?<Moon size={17}/>:<Sun size={17}/>}</button><button className="account-logout" onClick={requestLogout} disabled={accountBusy} aria-label="退出登录" title="退出登录">{accountBusy?<Loader2 size={17} className="spin"/>:<LogOut size={17}/>}</button></div></div>
    </aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={()=>setMobileMenu(true)} aria-label="展开导航"><Menu size={21}/></button><span className="breadcrumb"><strong>{title}</strong></span></div><div className="topbar-actions">{globalControls}</div></header>
      <main className="main-content" key={view+':'+navigationKey}>
        {view==='home'&&member.role==='admin'&&<AdminHome state={state} onNavigate={navigate}/>}
        {view==='reports'&&member.role==='manager'&&<SalesDailyReport state={state} notify={notify} onNavigate={navigate}/>}
        {view==='prospecting'&&member.role!=='admin'&&<ProspectingWorkspace onGuardReady={onProspectingGuardReady} initialSection={prospectingSection} onSectionChange={onProspectingSectionChange} onNavigateProject={id=>{void reload().then(()=>navigate('deals',id)).catch(()=>notify('项目已保存，工作台暂未刷新。请稍后重新打开。'));}}/>}
        {view==='geo'&&member.role!=='admin'&&<GEOWorkspace member={member} notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='materials'&&member.role!=='admin'&&<MarketingMaterials notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='schedule'&&member.role!=='admin'&&<ScheduleWorkspace pendingApprovals={approvalPendingCount} state={state} member={member} notify={notify} onNavigate={navigate} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='deals'&&member.role!=='admin'&&<CustomerWorkspace member={member} {...props} onReload={reload} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty} onNavigate={navigate} initialDealId={focusedDeal} initialIntent={projectIntent} onSelectedDealChange={onSelectedDealChange}/>}
        {(view==='contracts'||view==='approvals')&&member.role!=='admin'&&<ContractCenter {...props} initialTab={view==='approvals'?'approvals':'contracts'} initialDealId={focusedDeal} initialContractId={focusedApprovalContract} initialApprovalId={focusedApprovalId} onNavigate={navigate} onReloadWorkspace={reload} onBusyChange={view==='approvals'?onApprovalBusy:onContractBusy} onDirtyChange={view==='approvals'?onApprovalDirty:onContractDirty} pendingCount={approvalPendingCount}/>}
        {view==='training'&&member.role!=='admin'&&<TrainingView {...props} onPendingChange={onTrainingPendingChange} onMediaStopReady={onTrainingMediaReady}/>}

        {(view==='knowledge'||view==='talktracks')&&<KnowledgeWorkspace key={view+':'+(focusedDeal||'')} focus={focusedDeal} {...props} member={member} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty} initialTab={view==='talktracks'?'talktracks':'documents'} onUsePlaybook={id=>{if(member.role==='admin')return;setSelectedTalkIds([id]);setConversation([]);setFailedRequest(null);setChatError('');setChatOpen(true);}}/>}
        {view==='studio'&&<BuilderStudio {...props} readOnly={member.role!=='admin'} onGuardReady={onStudioGuardReady}/>}
        {view==='runs'&&<RunsView {...props} canExtract={member.role!=='admin'}/>}
        {view==='settings'&&member.role==='admin'&&<><SettingsView {...props} onConnectionChanged={reload}/><section className="meeting-settings-status"><MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} admin/></section></>}
        {view==='members'&&member.role==='admin'&&<MembersView member={member} notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='rules'&&member.role==='admin'&&<BusinessRulesView state={state} notify={notify} onBusyChange={onApprovalBusy} onDirtyChange={onApprovalDirty}/>}
      </main>
    </div>
    {member.role!=='admin'&&!mobileMenu&&<nav className="mobile-role-navigation" aria-label="快捷导航">{navigation.map(item=>{const Icon=item.icon;return <button key={item.id} aria-label={item.label} aria-current={section===item.id?'page':undefined} onClick={()=>navigate(item.id)}><Icon size={20}/><span>{item.mobileLabel??item.label}</span></button>;})}</nav>}
    {leaveProject&&<DiscardChangesDialog title="有尚未保存的内容" onCancel={()=>{setLeaveProject(false);pendingProjectLeave.current=null;}} onDiscard={()=>{projectDirty.current=false;setLeaveProject(false);const proceed=pendingProjectLeave.current;pendingProjectLeave.current=null;proceed?.();}}/>}
    {leaveApproval&&<DiscardChangesDialog title="审批内容尚未提交" onCancel={()=>{setLeaveApproval(false);pendingApprovalLeave.current=null;}} onDiscard={()=>{approvalDirty.current=false;setLeaveApproval(false);const proceed=pendingApprovalLeave.current;pendingApprovalLeave.current=null;proceed?.();}}/>}
    {leaveContract&&<DiscardChangesDialog title="合同草稿尚未保存" onCancel={()=>{setLeaveContract(false);pendingContractLeave.current=null;}} onDiscard={()=>{contractDirty.current=false;setLeaveContract(false);const proceed=pendingContractLeave.current;pendingContractLeave.current=null;proceed?.();}}/>}
    {searchOpen && <Overlay title="搜索工作空间" onClose={() => setSearchOpen(false)} className="search-dialog"><label className="modal-search"><Search size={19} /><input autoFocus placeholder="搜索项目、客户、知识或任务…" aria-label="搜索全部工作空间" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC</kbd></label><div className="search-results">{!search.trim() ? <><p className="search-hint">快速前往</p>{navigation.filter(item=>item.id!=='reports'||state.role==='manager').map(n => { const Icon = n.icon; return <button className="search-result" key={n.id} onClick={() => navigate(n.id)}><Icon size={19} /><span><strong>{n.label}</strong></span><ArrowRight size={15} /></button>; })}</> : searchResults.length ? <><p className="search-hint">找到 {searchResults.length} 项结果</p>{searchResults.map((r, i) => <button key={`${r.type}-${r.id}-${i}`} className="search-result" onClick={() => { if (r.view === 'runs') { const run = state.runs.find(x => x.id === r.id); if (run) { setConversation([run]);setChatError('');setFailedRequest(null); setChatOpen(true); setSearchOpen(false); } } else { navigate(r.view, r.view === 'deals' ? r.id : undefined); } }}><span className="search-result-icon">{r.view === 'deals' ? <BriefcaseBusiness size={18} /> : r.view === 'runs' ? <Clock3 size={18} /> : r.view === 'schedule' ? <CalendarDays size={18} /> : <BookOpen size={18} />}</span><span><strong>{r.title}</strong><small>{r.type} · {r.subtitle}</small></span><ArrowRight size={15} /></button>)}</> : <div className="empty-state"><Search size={25} /><h3>没有找到“{search}”</h3><p>可以尝试客户名称、联系人或更短的关键词。</p></div>}</div></Overlay>}
    {noticesOpen && <Overlay title="工作动态" onClose={() => setNoticesOpen(false)} className="notifications-dialog">{state.role === 'manager' && candidates.length > 0 && <button className="notification-item" onClick={() => navigate('knowledge')}><span className="notification-symbol"><BookOpen size={18} /></span><span><strong>{candidates.length} 项候选 Skill 待你审核</strong></span><ChevronRight size={16} /></button>}{state.activities.slice(0, 8).map(a => <div className="notification-item" key={a.id}><span className="notification-symbol"><Clock3 size={17} /></span><span><strong>{a.title}</strong><p>{a.detail}</p><small>{new Date(a.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></span></div>)}{noticeCount === 0 && <div className="empty-state"><Bell size={28} /><h3>现在没有新的动态</h3><p>完成任务后，相关记录会出现在这里。</p></div>}</Overlay>}
    {chatOpen && <Overlay title="AI 营销助手" onClose={() => setChatOpen(false)} className="drawer chat-drawer" wide actions={member.role !== 'admin' ? <AgentMemoryButton disabled={chatBusy} /> : undefined}><div className="chat-stream" ref={containerRef} onScroll={onScroll} onWheel={markUserInput} onTouchStart={markUserInput} onKeyDown={e => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) markUserInput(); }} tabIndex={0}>{conversation.length === 0 && !pendingQuery && !failedRequest && <div className="chat-welcome"><h2>新对话</h2><div>{AGENTS.map(a => <button key={a.id} onClick={() => onAsk(a.starter, a.id)}>{a.name}<ArrowRight size={13} /></button>)}</div></div>}{conversation.map(run => <article className="chat-turn" key={run.id}><div className="user-message">{run.query}</div><div className="assistant-label"><BrandMark small /><strong>AI 营销助手</strong><span>{runGenerationLabel(run)}</span></div><details className="trace-accordion"><summary><span><GitBranch size={15} />{run.agentIds.map(id => AGENTS.find(a => a.id === id)?.name).join(' → ') || '主 Agent'}<small>{run.steps.length} 个步骤</small></span><ChevronDown size={15} /></summary><div className="trace-steps">{run.steps.map(step => <div className="trace-step" key={step.id}><span className={`trace-icon ${step.status}`}>{step.status === 'success' ? <Check size={12} /> : <CircleAlert size={12} />}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div><small>{step.duration}ms</small></div>)}</div></details><AnswerContent className="assistant-answer" text={run.answer} />{run.citations.length > 0 && <div className="citations"><h3><BookOpen size={14} />参考来源</h3>{run.citations.map((c, i) => <details key={c.id}><summary><span>{i + 1}</span>{c.title}<ChevronDown size={13} /></summary><p>{c.excerpt}</p></details>)}</div>}<div className="answer-footer"><span>{shortDate(run.createdAt)} · {Math.max(0.1, run.duration / 1000).toFixed(1)}s</span><button className="text-button" onClick={() => { void navigator.clipboard.writeText(run.answer).then(() => notify('已复制任务结果')).catch(() => notify('浏览器未允许复制，请手动选择结果。')); }}>复制结果</button><button className="text-button" onClick={() => { setChatOpen(false); navigate('runs'); }}>运行详情 <ExternalLink size={12} /></button></div></article>)}{(pendingQuery || failedRequest) && <div className="chat-turn"><div className="user-message">{pendingQuery || failedRequest?.query}</div>{pendingQuery && <ChatProcessing steps={chatProgress} />}</div>}{chatError && <div className="error-message" role="alert"><CircleAlert size={17} /><span>{chatError}</span></div>}{failedRequest && <button className="button secondary" disabled={chatBusy} onClick={() => onAsk(failedRequest.query, failedRequest.agentId, failedRequest.dealId, failedRequest.talkTrackIds, failedRequest.conversationRunIds)}>重试本次问题</button>}</div>{showJump && <button className="jump-latest button secondary" onClick={jumpToLatest}><ArrowDown size={14} />回到最新</button>}<div className="chat-composer-wrap"><Composer talkTracks={state.talkTracks??[]} selectedTalkTrackIds={selectedTalkIds} onTalkTrackChange={setSelectedTalkIds} onSend={(q,a,ids)=>onAsk(q,a,undefined,ids)} placeholder="输入问题…" compact busy={chatBusy} modelConnected={state.model.connected} /></div></Overlay>}
    {toast && <div role="status" className="toast"><Check size={16} />{toast}<button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}
