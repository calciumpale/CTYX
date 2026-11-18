'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ArrowDown, ArrowRight, Bell, BookOpen, BriefcaseBusiness, CalendarDays, Check, ChevronDown, ChevronRight, CircleAlert, ClipboardCheck, Clock3, ExternalLink, FileAudio, GitBranch, Globe2, Home, LayoutGrid, Loader2, LogOut, Menu, MessageSquare, Moon, PanelLeftClose, Presentation, Search, Settings, ShieldCheck, Sparkles, Sun, Users, Video, Workflow, X } from 'lucide-react';
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
import { RecordingUploadView } from './RecordingUploadView';
import { AgentMemoryButton } from './AgentMemoryPanel';
import { RunsView, SettingsView, TrainingView } from './StudioViews';
import { BuilderStudio } from './BuilderStudio';
import { AnswerContent } from './AnswerContent';
import { ChatProcessing } from './ChatProcessing';
import './answer-content.css';
import './workbench-chat.css';
import { AdminHome, BusinessRulesView, KnowledgeWorkspace, MembersView } from './AdminWorkspace';
import type { MemberSession } from '../lib/member-types';
import { MeetingImportWorkspace } from './MeetingImportWorkspace';
import { ProspectingWorkspace } from './ProspectingWorkspace';
import { ScheduleWorkspace } from './ScheduleWorkspace';
import { ReminderWorkspace, reminderApprovalTotal } from './ReminderWorkspace';
import { useBusinessSettings } from './BusinessSettingsContext';
import { deriveProjectReminders } from '../lib/workspace-reminders';
import MarketingMaterials from './MarketingMaterials';
import GEOWorkspace from './GEOWorkspace';
import './workbench-sidebar.css';

const navigationIcons: Partial<Record<View, typeof Home>> = {
  home:Home, deals:BriefcaseBusiness, recordings:FileAudio, reminders:Bell, schedule:CalendarDays, meetings:Video, prospecting:Search, geo:Globe2, materials:Presentation,
  knowledge:BookOpen, training:MessageSquare, approvals:ClipboardCheck, contracts:ClipboardCheck,
  members:Users, rules:ShieldCheck, settings:Settings, studio:Workflow, runs:Clock3,
};

const mobilePrimaryViews = new Set<string>(['reminders', 'prospecting', 'deals', 'recordings']);

export default function Workbench({member,onLogout}:{member:MemberSession;onLogout:()=>Promise<void>}) {
  const navigation=workspaceNavigation(member.role).map(item=>({...item,icon:navigationIcons[item.id]??Home}));
  const { state, loading, error, mutate, reload, uploadFollowup } = useWorkbench();
  const { rules } = useBusinessSettings();
  const [reminderNow, setReminderNow] = useState(() => Date.now());
  useEffect(() => {
    if (member.role === 'admin') return;
    const update = () => setReminderNow(Date.now());
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); };
  }, [member.role]);
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
  const [accent, setAccent] = useState<'iris' | 'jade' | 'terracotta' | 'sapphire'>('iris');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const accountMenu = useRef<HTMLDetailsElement>(null);
  const workspaceContent = useRef<HTMLElement>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [assistantDealId, setAssistantDealId] = useState<string>();
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
  const loadPendingApprovals = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/approvals?scope=inbox&limit=1', { credentials:'same-origin', cache:'no-store', signal });
    if (!response.ok) throw new Error('暂时无法读取待审批数量');
    const body = await response.json() as { pendingCount?: number };
    if (!signal?.aborted && Number.isInteger(body.pendingCount)) setApprovalPendingCount(Math.max(0, body.pendingCount!));
  }, []);
  useEffect(()=>{
    if(member.role==='admin')return;
    const controller = new AbortController();
    const refresh = () => { void loadPendingApprovals(controller.signal).catch(() => {}); };
    refresh();const timer=setInterval(refresh,60000);window.addEventListener('ctai-approvals-updated',refresh);
    return ()=>{controller.abort();clearInterval(timer);window.removeEventListener('ctai-approvals-updated',refresh);};
  },[member.role,loadPendingApprovals]);
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
      const savedAccent = localStorage.getItem('ctai-accent');
      if (savedAccent === 'iris' || savedAccent === 'jade' || savedAccent === 'terracotta' || savedAccent === 'sapphire') {
        setAccent(savedAccent);
        document.documentElement.dataset.accent = savedAccent;
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (accountMenu.current) accountMenu.current.open = false;
        setSearchOpen(v => !v);
      }
      if (e.key === 'Escape') setMobileMenu(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const menu = accountMenu.current;
      if (menu?.open && e.target instanceof Node && !menu.contains(e.target)) menu.open = false;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
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
    if (accountMenu.current) accountMenu.current.open = false;
    if(next==='home'&&member.role!=='admin')next='deals';
    if(next==='meetings')next=member.role==='admin'?'settings':'schedule';
    if(next===view&&!id&&!intent&&!contractId&&!approvalId){setMobileMenu(false);setSearchOpen(false);return;}
    if(projectBusy.current){notify('当前内容正在处理，请等待完成后离开。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成后离开。');return;}
    if(contractBusy.current){notify('合同正在导入、保存或初审，请等待完成后离开。');return;}
    if(trainingPending.current){notify('语音回应正在保存，请等待完成；失败时可在带练页直接重试。');return;}
    const proceed=()=>{stopTrainingMedia.current?.();setView(next);setMeetingEmbed(false);setProspectingSection('screen');if(next==='deals')setNavigationKey(value=>value+1);setProjectIntent(intent||null);setFocusedDeal(id||null);setFocusedApprovalContract(contractId||null);setFocusedApprovalId(approvalId||null);const url=new URL(window.location.href);url.search=workspaceSearch(url.search,{view:next,...(next==='knowledge'||next==='talktracks'?{focus:id}:{dealId:id}),contractId,approvalId,intent});window.history.replaceState(null,'',url.href);setMobileMenu(false);setSearchOpen(false);workspaceContent.current?.scrollTo({top:0,left:0,behavior:'auto'});};
    const guardedProceed=()=>{if(prospectingGuard.current&&!prospectingGuard.current(proceed)){setMobileMenu(false);setSearchOpen(false);return;}if(studioGuard.current&&!studioGuard.current(proceed)){setMobileMenu(false);setSearchOpen(false);return;}proceed();};
    if(projectDirty.current){pendingProjectLeave.current=guardedProceed;setLeaveProject(true);return;}
    if(approvalDirty.current){pendingApprovalLeave.current=guardedProceed;setLeaveApproval(true);return;}
    if(contractDirty.current){pendingContractLeave.current=guardedProceed;setLeaveContract(true);return;}
    guardedProceed();
  }, [notify, view, member.role, setView, setProjectIntent, setFocusedDeal, setFocusedApprovalContract, setFocusedApprovalId, setMobileMenu, setSearchOpen, setLeaveProject, setLeaveApproval, setLeaveContract]);
  const toggleTheme = () => { const next = theme === 'light' ? 'dark' : 'light'; setTheme(next); document.documentElement.dataset.mode = next; localStorage.setItem('ctai-theme', next); };
  const chooseAccent = (next: 'iris' | 'jade' | 'terracotta' | 'sapphire') => { setAccent(next); document.documentElement.setAttribute('data-accent', next); localStorage.setItem('ctai-accent', next); };
  const onAsk = useCallback((query: string, agentId?: AgentId, dealId?: string, talkTrackIds?:string[], priorRunIds?:string[]) => {
    if(member.role==='admin'){notify('请在搭建中心调试 Agent，销售助手由业务账号使用');return;}
    if(projectBusy.current){notify('项目正在录入或更新，请等待完成。');return;}
    if(approvalBusy.current){notify('审批操作正在保存，请等待完成。');return;}
    if(contractBusy.current){notify('合同初审正在进行，请等待完成。');return;}
    if (sending.current) { notify('当前任务正在生成，请等待完成后继续。'); return; }
    if (!state || (dealId && !state.deals.some(deal => deal.id === dealId))) {
      notify('该项目已无法访问，请刷新后重新选择项目。');
      return;
    }
    const proceed = () => {
      if (sending.current) return;
      const sameThread = chatOpen && assistantDealId === dealId;
      const contextIds = priorRunIds ?? (sameThread ? conversation.map(run => run.id) : []);
      const historyDealId = dealId ?? (sameThread ? conversation.at(-1)?.dealId : undefined);
      const visibleRuns = new Set(state.runs.filter(run => isCompletedChatRun(run)
        && run.dealId === historyDealId).map(run => run.id));
      const conversationRunIds = contextIds.filter(id => visibleRuns.has(id)).slice(-6);
      if (!sameThread) setConversation([]);
      setAssistantDealId(dealId);
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
  }, [mutate, notify, state, chatOpen, assistantDealId, conversation, selectedTalkIds, member.role, setAssistantDealId, setChatOpen, setChatError, setFailedRequest, setPendingQuery, setChatBusy, setConversation]);
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
      ...(canOpenWorkspaceView(member.role,'reminders')&&'提醒 待办 到期 逾期 reminder'.includes(q)?[{id:'reminders',type:'功能',title:'提醒',subtitle:'项目期限与待审核事项',view:'reminders' as View}]:[]),
      ...(canOpenWorkspaceView(member.role,'schedule')&&'日程 智能日程 任务 安排 拜访 calendar schedule'.includes(q)?[{id:'schedule',type:'功能',title:'日程',subtitle:'任务、日程与拜访',view:'schedule' as View}]:[]),
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
  const reminderCount = member.role === 'admin' ? 0 : deriveProjectReminders(state.deals, reminderNow, rules).counts.total
    + reminderApprovalTotal(member.role, approvalPendingCount, candidates.length);
  const props = { state, mutate, notify, onAsk };
  const title = workspaceTitle(view,member.role);
  const section = workspaceSection(view,member.role);
  const primaryItems = navigation.filter(item => mobilePrimaryViews.has(item.id));
  const moreActive = section !== undefined && !mobilePrimaryViews.has(section);
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
  const assistantDeal = state.deals.find(deal => deal.id === assistantDealId);
  function openAssistant(run?: Run, talkTrackIds?: string[]) {
    if (sending.current) {
      notify('当前任务正在生成，请等待完成后继续。');
      return;
    }
    const projectId = view === 'deals' ? state?.deals.find(deal => deal.id === focusedDeal)?.id : undefined;
    setAssistantDealId(run ? run.dealId : projectId);
    setConversation(run ? [run] : []);
    if (talkTrackIds) setSelectedTalkIds(talkTrackIds);
    setFailedRequest(null);
    setChatError('');
    setChatOpen(true);
    setMobileMenu(false);
    setSearchOpen(false);
  }
  const openSearch = () => { setSearch(''); setSearchOpen(true); setMobileMenu(false); };
  if(meetingEmbed)return <div className="meeting-embed-shell"><header className="meeting-embed-header"><span className="meeting-embed-brand"><BrandMark small/>AI营销工作台</span><a href="/?view=meetings" target="_blank" rel="noopener noreferrer">完整工作台 <ExternalLink size={13}/></a><button className="icon-button" disabled={accountBusy} onClick={requestLogout} aria-label={`退出${member.displayName}的账号`} title={`当前账号：${member.displayName}`}>{accountBusy?<Loader2 size={16} className="spin"/>:<LogOut size={16}/>}</button></header>{toast&&<p className="meeting-message" role="status">{toast}</p>}<MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} initialDealId={focusedDeal} admin={member.role==='admin'} compact/></div>;
  return <div className="app-shell">
    {mobileMenu && <button className="sidebar-backdrop" onClick={() => setMobileMenu(false)} aria-label="关闭导航" />}
    <aside className={'sidebar '+(mobileMenu?'mobile-open':'')} aria-label="主导航">
      <div className="sidebar-account-header">
        <details className="sidebar-account" ref={accountMenu} onToggle={event => setAccountMenuOpen(event.currentTarget.open)} onKeyDown={event => {
          if (event.key !== 'Escape' || !event.currentTarget.open) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }}>
          <summary className="sidebar-account-trigger" role="button" aria-label="账号菜单" aria-controls="workbench-account-actions" aria-expanded={accountMenuOpen}>
            <span className="sidebar-avatar" aria-hidden="true">{Array.from(member.displayName.trim()).slice(0, /[\p{Script=Han}]/u.test(member.displayName) ? 1 : 2).join('') || member.username.slice(0, 2)}</span>
            <span className="sidebar-account-identity"><strong>{member.displayName}</strong><small><i className="sidebar-online-dot" aria-hidden="true" />@{member.username}</small></span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div className="sidebar-account-actions" id="workbench-account-actions">
            <div className="sidebar-accent-picker" role="group" aria-label="界面主题色调">
              <span>主题色</span>
              <div>
                {([
                  ['iris', '鸢尾', '#4f46e5'],
                  ['jade', '青碧', '#0f766e'],
                  ['terracotta', '暖陶', '#c2593f'],
                  ['sapphire', '星蓝', '#2563eb'],
                ] as const).map(([key, label, swatch]) => <button key={key} type="button" className={`sidebar-accent-dot${accent === key ? ' is-active' : ''}`} style={{ '--swatch': swatch } as React.CSSProperties} aria-label={`切换${label}色调`} aria-pressed={accent === key} title={`${label}色调`} onClick={() => chooseAccent(key)} />)}
              </div>
            </div>
            <button type="button" onClick={toggleTheme}>{theme==='light'?<Moon size={15}/>:<Sun size={15}/>} {theme==='light'?'切换深色主题':'切换浅色主题'}</button>
            <button type="button" onClick={requestLogout} disabled={accountBusy}>{accountBusy?<Loader2 size={15} className="spin"/>:<LogOut size={15}/>}退出登录</button>
          </div>
        </details>
        <button className="icon-button close-nav" onClick={() => { if (accountMenu.current) accountMenu.current.open = false; setMobileMenu(false); }} aria-label="收起导航"><PanelLeftClose size={18}/></button>
      </div>
      {navigation.length > 0 && <nav aria-label="业务导航">{navigation.map(item => {
        const Icon = item.icon;
        const current = section === item.id;
        const badge = item.id === 'reminders' ? { count: reminderCount, label: '待处理提醒' }
          : item.id === 'contracts' ? { count: approvalPendingCount, label: '待审批' }
          : item.id === 'knowledge' && member.role === 'manager' ? { count: candidates.length, label: '待审核 Skill' } : null;
        const countId = `sidebar-count-${item.id}`;
        return <a key={item.id} {...linkProps(item.id)} className={`nav-item${current ? ' active' : ''}`} aria-current={current?'page':undefined}
          aria-label={item.label} aria-describedby={badge?.count ? countId : undefined}>
          <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
          <span className="sidebar-business-label" aria-hidden="true">{item.label}</span>
          {badge && badge.count > 0 && <small id={countId} className={item.id === 'reminders' ? 'sidebar-reminder-count' : undefined}>
            <span aria-hidden="true">{badge.count > 99 ? '99+' : badge.count}</span>
            <span className="sr-only">{badge.count} 项{badge.label}</span>
          </small>}
        </a>;
      })}</nav>}
      {member.role !== 'admin' && <div className="sidebar-recent">
        <div className="nav-caption">
          <span>{state.runs.length ? '最近 AI 任务' : 'AI 任务记录'}</span>
          <button type="button" className="icon-button" onClick={() => navigate('runs')} aria-label="全部 AI 任务记录"><ChevronRight size={13} /></button>
        </div>
        {state.runs.slice(0, 3).map(run => <button type="button" key={run.id} onClick={() => openAssistant(run)} disabled={chatBusy} title={run.query}>
          <span className="sidebar-recent-marker" aria-hidden="true" />
          <span className="sidebar-recent-label">{run.query}</span>
        </button>)}
      </div>}
      {managementNavigation.length > 0 && <>
        <nav className="sidebar-management" aria-label="系统管理导航">
          {managementNavigation.filter(item => item.id !== 'runs').map(item => {
            const Icon = navigationIcons[item.id] ?? Home;
            const current = view === item.id;
            return <a key={item.id} {...linkProps(item.id)} className={`nav-item${current ? ' active' : ''}`} aria-current={current ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.7} /><span>{item.label}</span>
            </a>;
          })}
        </nav>
        {managementNavigation.filter(item => item.id === 'runs').map(item => {
          const Icon = navigationIcons[item.id] ?? Clock3;
          const current = view === item.id;
          return <div key={item.id} className="sidebar-admin-foot">
            <a {...linkProps(item.id)} className={`nav-item${current ? ' active' : ''}`} aria-current={current ? 'page' : undefined}>
              <Icon size={18} strokeWidth={1.7} /><span>{item.label}</span>
            </a>
          </div>;
        })}
      </>}
    </aside>
    <div className="workspace"><header className="topbar"><div className="topbar-left"><button className="icon-button menu-toggle" onClick={()=>setMobileMenu(true)} aria-label="展开导航"><Menu size={21}/></button><span className="breadcrumb"><strong>{title}</strong></span></div><div className="topbar-actions"><button className="global-search" aria-label="搜索工作空间" onClick={openSearch}><Search size={17}/></button>{member.role !== 'admin' && <button type="button" className="icon-button topbar-chat-btn" aria-label="AI 营销助手" title="AI 营销助手" disabled={chatBusy} onClick={() => openAssistant()}><MessageSquare size={17} aria-hidden="true" /></button>}</div></header>
      <main className="main-content" ref={workspaceContent} key={view+':'+navigationKey}>
        {view==='home'&&member.role==='admin'&&<AdminHome state={state} onNavigate={navigate}/>}
        {view==='reports'&&member.role==='manager'&&<SalesDailyReport state={state} notify={notify} onNavigate={navigate}/>}
        {view==='prospecting'&&member.role!=='admin'&&<ProspectingWorkspace onGuardReady={onProspectingGuardReady} initialSection={prospectingSection} onSectionChange={onProspectingSectionChange} onNavigateProject={id=>{void reload().then(()=>navigate('deals',id)).catch(()=>notify('项目已保存，工作台暂未刷新。请稍后重新打开。'));}}/>}
        {view==='geo'&&member.role!=='admin'&&<GEOWorkspace member={member} notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='materials'&&member.role!=='admin'&&<MarketingMaterials notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='reminders'&&member.role!=='admin'&&<ReminderWorkspace state={state} member={member} pendingApprovals={approvalPendingCount} pendingSkills={candidates.length} now={reminderNow} onNavigate={navigate} onRefresh={async () => { await Promise.all([reload(), loadPendingApprovals()]); setReminderNow(Date.now()); }}/>}
        {view==='schedule'&&member.role!=='admin'&&<ScheduleWorkspace state={state} member={member} notify={notify} onNavigate={navigate} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='deals'&&member.role!=='admin'&&<CustomerWorkspace member={member} {...props} onReload={reload} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty} onNavigate={navigate} initialDealId={focusedDeal} initialIntent={projectIntent} onSelectedDealChange={onSelectedDealChange}/>}
        {view==='recordings'&&member.role!=='admin'&&<RecordingUploadView state={state} mutate={mutate} uploadFollowup={uploadFollowup} notify={notify} initialDealId={focusedDeal} onNavigateProject={id=>navigate('deals',id)} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {(view==='contracts'||view==='approvals')&&member.role!=='admin'&&<ContractCenter {...props} initialTab={view==='approvals'?'approvals':'contracts'} initialDealId={focusedDeal} initialContractId={focusedApprovalContract} initialApprovalId={focusedApprovalId} onNavigate={navigate} onReloadWorkspace={reload} onBusyChange={view==='approvals'?onApprovalBusy:onContractBusy} onDirtyChange={view==='approvals'?onApprovalDirty:onContractDirty} pendingCount={approvalPendingCount}/>}
        {view==='training'&&member.role!=='admin'&&<TrainingView {...props} onPendingChange={onTrainingPendingChange} onMediaStopReady={onTrainingMediaReady}/>}

        {(view==='knowledge'||view==='talktracks')&&<KnowledgeWorkspace key={view+':'+(focusedDeal||'')} focus={focusedDeal} {...props} member={member} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty} initialTab={view==='talktracks'?'talktracks':'documents'} onUsePlaybook={id=>{if(member.role==='admin')return;openAssistant(undefined, [id]);}}/>}
        {view==='studio'&&<BuilderStudio {...props} readOnly={member.role!=='admin'} onGuardReady={onStudioGuardReady}/>}
        {view==='runs'&&<RunsView {...props} canExtract={member.role!=='admin'}/>}
        {view==='settings'&&member.role==='admin'&&<SettingsView {...props} onConnectionChanged={reload} meetingSettings={<MeetingImportWorkspace state={state} onWorkspaceRefresh={reload} admin/>}/>}
        {view==='members'&&member.role==='admin'&&<MembersView member={member} notify={notify} onBusyChange={onProjectBusy} onDirtyChange={onProjectDirty}/>}
        {view==='rules'&&member.role==='admin'&&<BusinessRulesView state={state} notify={notify} onBusyChange={onApprovalBusy} onDirtyChange={onApprovalDirty}/>}
      </main>
      {member.role!=='admin'&&<nav className="mobile-role-navigation" aria-label="快捷导航" inert={mobileMenu}>{primaryItems.map(item=>{const Icon=item.icon;return <button key={item.id} aria-label={item.label} aria-current={section===item.id?'page':undefined} onClick={()=>navigate(item.id)}><Icon size={19}/><span>{item.mobileLabel??item.label}</span></button>;})}<button type="button" aria-label="更多功能" aria-current={moreActive?'page':undefined} onClick={()=>setMobileMenu(true)}><LayoutGrid size={19}/><span>更多</span></button></nav>}
    </div>
    {leaveProject&&<DiscardChangesDialog title="有尚未保存的内容" onCancel={()=>{setLeaveProject(false);pendingProjectLeave.current=null;}} onDiscard={()=>{projectDirty.current=false;setLeaveProject(false);const proceed=pendingProjectLeave.current;pendingProjectLeave.current=null;proceed?.();}}/>}
    {leaveApproval&&<DiscardChangesDialog title="审批内容尚未提交" onCancel={()=>{setLeaveApproval(false);pendingApprovalLeave.current=null;}} onDiscard={()=>{approvalDirty.current=false;setLeaveApproval(false);const proceed=pendingApprovalLeave.current;pendingApprovalLeave.current=null;proceed?.();}}/>}
    {leaveContract&&<DiscardChangesDialog title="合同草稿尚未保存" onCancel={()=>{setLeaveContract(false);pendingContractLeave.current=null;}} onDiscard={()=>{contractDirty.current=false;setLeaveContract(false);const proceed=pendingContractLeave.current;pendingContractLeave.current=null;proceed?.();}}/>}
    {searchOpen && <Overlay title="搜索工作空间" onClose={() => setSearchOpen(false)} className="search-dialog"><label className="modal-search"><Search size={19} /><input autoFocus placeholder="搜索项目、客户、知识或任务…" aria-label="搜索全部工作空间" value={search} onChange={e => setSearch(e.target.value)} /><kbd>ESC</kbd></label><div className="search-results">{!search.trim() ? <><p className="search-hint">快速前往</p>{navigation.filter(item=>item.id!=='reports'||state.role==='manager').map(n => { const Icon = n.icon; return <button className="search-result" key={n.id} onClick={() => navigate(n.id)}><Icon size={19} /><span><strong>{n.label}</strong></span><ArrowRight size={15} /></button>; })}</> : searchResults.length ? <><p className="search-hint">找到 {searchResults.length} 项结果</p>{searchResults.map((r, i) => <button key={`${r.type}-${r.id}-${i}`} className="search-result" onClick={() => { if (r.view === 'runs') { const run = state.runs.find(x => x.id === r.id); if (run) openAssistant(run); } else { navigate(r.view, r.view === 'deals' ? r.id : undefined); } }}><span className="search-result-icon">{r.view === 'deals' ? <BriefcaseBusiness size={18} /> : r.view === 'runs' ? <Clock3 size={18} /> : r.view === 'schedule' ? <CalendarDays size={18} /> : <BookOpen size={18} />}</span><span><strong>{r.title}</strong><small>{r.type} · {r.subtitle}</small></span><ArrowRight size={15} /></button>)}</> : <div className="empty-state"><Search size={25} /><h3>没有找到“{search}”</h3><p>可以尝试客户名称、联系人或更短的关键词。</p></div>}</div></Overlay>}
    {member.role !== 'admin' && !mobileMenu && !chatOpen && <button
      type="button" className="workbench-chat-launcher" aria-label="AI 营销助手" title="AI 营销助手"
      onClick={() => openAssistant()}
      disabled={chatBusy}><MessageSquare size={21} aria-hidden="true" /></button>}
    {chatOpen && <Overlay title="AI 营销助手" onClose={() => setChatOpen(false)} className="drawer chat-drawer" wide actions={member.role !== 'admin' ? <AgentMemoryButton disabled={chatBusy} /> : undefined}>
      <div className="chat-stream" ref={containerRef} onScroll={onScroll} onWheel={markUserInput} onTouchStart={markUserInput} onKeyDown={e => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) markUserInput();
      }} tabIndex={0}>
        <div className="chat-reading">
          {conversation.length === 0 && !pendingQuery && !failedRequest && <div className="chat-welcome">
            <span className="chat-welcome-emblem" aria-hidden="true"><Sparkles size={22} /></span>
            <span className="chat-welcome-context">{assistantDeal ? `当前项目：${assistantDeal.projectName || assistantDeal.name}` : '全局智能工作台助手'}</span>
            <h2>有什么可以一起推进？</h2>
            <p className="chat-welcome-subtitle">自动识别意图并调度领域专家，结合已确认客户事实、合同与知识库生成可追溯建议。</p>
            <div className="chat-welcome-grid">{AGENTS.map((a, idx) => <button key={a.id} onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`); e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`); }} onClick={() => onAsk(a.starter, a.id, assistantDealId)}><span className="chat-agent-icon" data-avatar-tone={idx % 6} aria-hidden="true"><Sparkles size={15} /></span><span className="chat-agent-card-copy"><strong>{a.name}</strong><small>{a.description}</small></span><ArrowRight size={14} aria-hidden="true" /></button>)}{assistantDeal && <button type="button" onPointerMove={e => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--spot-x', `${e.clientX - r.left}px`); e.currentTarget.style.setProperty('--spot-y', `${e.clientY - r.top}px`); }} onClick={() => onAsk('请结合当前客户事实与沟通记录，汇总项目现状、待核实风险及下一步推进清单。', undefined, assistantDealId)}><span className="chat-agent-icon" data-avatar-tone={5} aria-hidden="true"><BriefcaseBusiness size={15} /></span><span className="chat-agent-card-copy"><strong>AI 项目复盘</strong><small>汇总关键事实、风险边界与推进清单</small></span><ArrowRight size={14} aria-hidden="true" /></button>}</div>
          </div>}
          {conversation.map(run => {
            const duration = Math.max(0.1, run.duration / 1000).toFixed(1);
            const agents = run.agentIds.flatMap(id => AGENTS.find(a => a.id === id)?.name ?? []);
            return <article className="chat-turn" key={run.id}>
              <div className="user-message">{run.query}</div>
              <div className="assistant-label"><BrandMark small /><strong>AI 营销助手</strong><span>{runGenerationLabel(run)}</span></div>
              <details className="trace-accordion">
                <summary><span>处理过程<small>{duration} 秒 · {run.steps.length} 步</small></span><ChevronDown size={15} aria-hidden="true" /></summary>
                {(agents.length > 0 || run.steps.length > 0) && <div className="trace-steps">
                  {agents.length > 0 && <p className="trace-agents"><GitBranch size={14} aria-hidden="true" />{agents.join(' · ')}</p>}
                  {run.steps.map(step => <div className="trace-step" key={step.id}>
                    <span className={`trace-icon ${step.status}`}>{step.status === 'success' ? <Check size={12} /> : <CircleAlert size={12} />}</span>
                    <div><strong>{step.title}</strong><p>{step.detail}</p></div>
                    <small>{step.duration} ms</small>
                  </div>)}
                </div>}
              </details>
              <AnswerContent className="assistant-answer" text={run.answer} />
              {run.citations.length > 0 && <div className="citations">
                <details className="citation-group">
                  <summary><BookOpen size={15} aria-hidden="true" />参考来源 <span className="citation-count">{run.citations.length}</span><ChevronDown size={14} aria-hidden="true" /></summary>
                  <div className="citation-list">{run.citations.map((c, i) => <details key={c.id}>
                    <summary><span className="citation-index">{i + 1}</span><strong>{c.title}</strong><ChevronDown size={14} aria-hidden="true" /></summary>
                    <p>{c.excerpt}</p>
                  </details>)}</div>
                </details>
              </div>}
              <div className="answer-footer">
                <span>{shortDate(run.createdAt)}</span>
                <button className="text-button" onClick={() => { void navigator.clipboard.writeText(run.answer).then(() => notify('已复制任务结果')).catch(() => notify('浏览器未允许复制，请手动选择结果。')); }}>复制结果</button>
                <button className="text-button" onClick={() => { setChatOpen(false); navigate('runs'); }}>运行详情<ExternalLink size={12} /></button>
              </div>
            </article>;
          })}
          {(pendingQuery || failedRequest) && <div className="chat-turn">
            <div className="user-message">{pendingQuery || failedRequest?.query}</div>
            {pendingQuery && <ChatProcessing steps={chatProgress} />}
          </div>}
          {chatError && <div className="error-message" role="alert"><CircleAlert size={17} /><span>{chatError}</span></div>}
          {failedRequest && <button className="button secondary" disabled={chatBusy} onClick={() => onAsk(failedRequest.query, failedRequest.agentId, failedRequest.dealId, failedRequest.talkTrackIds, failedRequest.conversationRunIds)}>重试本次问题</button>}
        </div>
      </div>
      {showJump && <button className="jump-latest button secondary" onClick={jumpToLatest}><ArrowDown size={14} />回到最新</button>}
      <div className="chat-composer-wrap"><Composer talkTracks={state.talkTracks??[]} selectedTalkTrackIds={selectedTalkIds} onTalkTrackChange={setSelectedTalkIds} onSend={(q,a,ids)=>onAsk(q,a,assistantDealId,ids)} placeholder="输入问题…" compact busy={chatBusy} modelConnected={state.model.connected} /></div>
    </Overlay>}
    {toast && <div role="status" className="toast"><Check size={16} />{toast}<button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示"><X size={14} /></button></div>}
  </div>;
}
