'use client';

import { useEffect, useMemo, useState } from 'react';
import { AlarmClock, ArrowRight, CalendarDays, Check, ChevronRight, ClipboardCheck, FileText, LayoutGrid, Loader2, MessageSquare, MessageSquarePlus, Plus, RefreshCw, Sparkles } from 'lucide-react';
import type { MemberSession } from '../lib/member-types';
import type { Deal, View, ViewProps, WorkbenchState } from '../lib/types';
import type { ApprovalSummary } from '../lib/approval-types';
import { listApprovals } from '../lib/approval-client';
import { projectUrgency, urgencyLabel } from '../lib/project-deadline';
import { useBusinessSettings } from './BusinessSettingsContext';
import './role-workspaces.css';
import './role-dashboard.css';

export interface RoleDashboardProps {
  state: WorkbenchState;
  member: MemberSession;
  onNavigate: (view: View, id?: string) => void;
  onAsk: ViewProps['onAsk'];
  onRecordCustomer: () => void;
  onRecordFollowup: () => void;
  pendingApprovals: number;
}

const titleFor = (deal: Deal) => deal.projectName || deal.name;
const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' });
const deadlineFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const validDeadline = (deal: Deal) => Number.isFinite(Date.parse(deal.deadline || '')) ? Date.parse(deal.deadline!) : Infinity;
const approvalLabel: Record<ApprovalSummary['status'], string> = { pending: '审批中', approved: '已通过', rejected: '已驳回', returned: '待补充', withdrawn: '已撤回', superseded: '已更新' };

function ApprovalProgress({ member, onNavigate }: Pick<RoleDashboardProps, 'member' | 'onNavigate'>) {
  const [requests, setRequests] = useState<ApprovalSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    let controller: AbortController | null = null;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      setLoading(true);
      setFailed(false);
      void listApprovals({ scope: 'mine', limit: 3 }, current.signal).then(result => {
        if (active && !current.signal.aborted) setRequests(result.requests);
      }).catch(() => { if (active && !current.signal.aborted) setFailed(true); }).finally(() => { if (active && !current.signal.aborted) setLoading(false); });
    };
    refresh();
    window.addEventListener('ctai-approvals-updated', refresh);
    return () => { active = false; controller?.abort(); window.removeEventListener('ctai-approvals-updated', refresh); };
  }, [member.accountId, reload]);
  return <section className="role-approval-section" aria-labelledby="role-approval-title">
    <div className="role-section-heading"><h2 id="role-approval-title">审批进度</h2><button onClick={() => onNavigate('approvals')}>全部审批<ArrowRight size={16} /></button></div>
    {loading ? <p className="role-inline-state" role="status"><Loader2 size={17} className="spin" />正在读取审批进度…</p> : failed ? <div className="role-inline-state"><p role="alert">审批进度暂时未能更新。</p><button onClick={() => setReload(value => value + 1)}><RefreshCw size={15} />重试</button></div> : requests.length ? <ul className="role-approval-list">{requests.map(item => <li key={item.id}><button onClick={() => onNavigate('approvals', item.projectId)}><ClipboardCheck size={19} /><span><strong>{item.title}</strong><small>{item.projectName}{item.status === 'pending' ? ` · 第 ${item.currentStep + 1}/${item.stepCount} 级 · ${item.currentApprover}` : ''}</small></span><span className={`role-status role-status-${item.status}`}>{approvalLabel[item.status]}</span><ChevronRight size={17} /></button></li>)}</ul> : <div className="role-quiet-empty"><ClipboardCheck size={22} /><div><strong>暂无审批</strong></div></div>}
  </section>;
}

export function RoleDashboard({ state, member, onNavigate, onAsk, onRecordCustomer, onRecordFollowup, pendingApprovals }: RoleDashboardProps) {
  const { rules } = useBusinessSettings();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  const projects = useMemo(() => state.deals.filter(deal => deal.dataOrigin === 'manual' && (member.role !== 'sales' || deal.ownerId === member.salesId)), [state.deals, member.role, member.salesId]);
  const openProjects = projects.filter(deal => deal.outcome !== 'won' && deal.outcome !== 'lost');
  const followups = [...openProjects].sort((a, b) => validDeadline(a) - validDeadline(b) || (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1) || a.lastContact.localeCompare(b.lastContact)).slice(0, 5);
  const deadlines = [...openProjects].filter(deal => projectUrgency(deal, now, rules) !== 'none').sort((a, b) => validDeadline(a) - validDeadline(b));
  const intervention = [...openProjects].filter(deal => deal.priority === 'high' || deal.risks.length || ['urgent', 'overdue'].includes(projectUrgency(deal, now, rules))).sort((a, b) => validDeadline(a) - validDeadline(b));
  const talkTrackCount = (state.talkTracks || []).filter(item => item.status === 'candidate').length;
  const skillCount = state.skills.filter(item => item.status === 'candidate').length;
  const manager = member.role === 'manager';

  if (member.role === 'admin') return null;
  return <div className={`role-dashboard ${manager ? 'role-manager-dashboard' : 'role-sales-dashboard'}`}>
    <header className="page-header role-dashboard-heading"><div className="role-dashboard-title"><h1 className="page-title">{manager ? '团队概览' : '今日工作'}</h1><time dateTime={new Date(now).toISOString()}><CalendarDays size={14} />{dateFormat.format(now)}</time></div><div className="role-primary-actions" aria-label="常用操作">{manager ? <><button className="button secondary" onClick={() => onNavigate('reports')}>销售日报<ArrowRight size={15} /></button><button className="button secondary" onClick={() => onAsk('总结团队当前的商机风险、待推进项目和下一步建议', 'opportunity')}><Sparkles size={15} />问助手</button></> : <><button className="button secondary" onClick={() => onAsk('帮我梳理今天值得优先跟进的项目，并给出下一步建议', 'opportunity')}><Sparkles size={15} />问助手</button><button className="button secondary" onClick={onRecordFollowup}><MessageSquarePlus size={15} />记跟进</button><button className="button primary" onClick={onRecordCustomer}><Plus size={16} />录客户</button></>}</div></header>

    {manager ? <>
      <section className="role-manager-tasks" aria-labelledby="role-pending-title"><div className="role-section-heading"><h2 id="role-pending-title">待处理</h2></div><div className="role-task-list">
        <button onClick={() => onNavigate('approvals')}><ClipboardCheck size={21} /><span><strong>商务与合同审批</strong></span><span className="role-task-count">{pendingApprovals ? `${pendingApprovals} 项待处理` : '暂无待办'}</span><ChevronRight size={18} /></button>
        <button onClick={() => onNavigate('talktracks','talk-review')}><MessageSquare size={21} /><span><strong>实战话术审核</strong></span><span className="role-task-count">{talkTrackCount ? `${talkTrackCount} 项待审核` : '暂无待办'}</span><ChevronRight size={18} /></button>
        <button onClick={() => onNavigate('knowledge','skill-review')}><FileText size={21} /><span><strong>候选技能审核</strong></span><span className="role-task-count">{skillCount ? `${skillCount} 项待审核` : '暂无待办'}</span><ChevronRight size={18} /></button>
      </div></section>
      <section className="role-intervention-section" aria-labelledby="role-intervention-title"><div className="role-section-heading"><h2 id="role-intervention-title">需关注的项目{intervention.length > 0 && <span className="role-heading-count">{intervention.length}</span>}</h2><button onClick={() => onNavigate('deals')}>团队项目<ArrowRight size={16} /></button></div>{intervention.length ? <ul className="role-project-list">{intervention.slice(0, 4).map(deal => <li key={deal.id}><button className="role-project-row" onClick={() => onNavigate('deals', deal.id)}><span className="role-project-row-main"><strong>{titleFor(deal)}</strong><span>{deal.name} · {deal.owner || '待分配'} · {deal.stage}</span><p>{projectUrgency(deal, now, rules) === 'overdue' ? `下一步行动已逾期：${deal.nextAction || '请确认推进安排'}` : deal.risks[0] || deal.nextAction || '请确认当前推进情况'}</p></span><ChevronRight size={18} /></button></li>)}</ul> : <div className="role-quiet-empty"><Check size={24} /><div><strong>暂无需要介入的项目</strong></div></div>}</section>
    </> : <>
      <div className="role-sales-columns"><section className="role-followups-section" aria-labelledby="role-followups-title"><div className="role-section-heading"><h2 id="role-followups-title">待跟进</h2><button onClick={() => onNavigate('deals')}>我的项目<ArrowRight size={16} /></button></div>{followups.length ? <ul className="role-project-list">{followups.map(deal => <li key={deal.id}><button className="role-project-row" onClick={() => onNavigate('deals', deal.id)}><span className="role-project-row-main"><span className="role-project-row-title"><strong>{titleFor(deal)}</strong><span className="role-stage">{deal.stage}</span></span><span>{deal.name}{deal.contact ? ` · ${deal.contact}` : ''}</span><p>{deal.nextAction || '待安排下一步'}</p></span><ChevronRight size={18} /></button></li>)}</ul> : <div className="role-first-customer"><MessageSquarePlus size={29} /><h3>暂无项目</h3><button className="button primary" onClick={onRecordCustomer}><Plus size={17} />录入客户</button></div>}</section>
      <section className="role-deadlines-section" aria-labelledby="role-deadlines-title"><div className="role-section-heading"><h2 id="role-deadlines-title">到期提醒</h2>{deadlines.length > 0 && <span>{deadlines.length} 项</span>}</div>{deadlines.length ? <ul className="role-deadline-list">{deadlines.slice(0, 4).map(deal => { const urgency = projectUrgency(deal, now, rules); return <li key={deal.id}><button onClick={() => onNavigate('deals', deal.id)}><span className={`role-deadline-label role-deadline-${urgency}`}><AlarmClock size={14} />{urgencyLabel(urgency, rules)}</span><strong>{titleFor(deal)}</strong><time dateTime={deal.deadline}>{deadlineFormat.format(new Date(deal.deadline!))}</time><p>{deal.nextAction || '请确认下一步安排'}</p></button></li>; })}</ul> : <div className="role-no-deadlines"><CalendarDays size={24} /><p>近期没有到期事项</p></div>}</section></div>
      <ApprovalProgress member={member} onNavigate={onNavigate} />
    </>}
    <button className="role-team-apps-entry" onClick={() => onNavigate('studio')}><LayoutGrid size={20} /><span><strong>团队应用</strong></span><ArrowRight size={17} /></button>
  </div>;
}
