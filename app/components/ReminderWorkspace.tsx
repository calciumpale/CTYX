'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowRight, Bell, CalendarDays, ClipboardCheck, FileText, RefreshCw } from 'lucide-react';
import type { MemberSession } from '../lib/member-types';
import { urgencyLabel } from '../lib/project-deadline';
import { shanghaiDate } from '../lib/schedule-calendar';
import { preferredScrollBehavior } from '../lib/scroll-behavior';
import type { View, WorkbenchState } from '../lib/types';
import { deriveProjectReminders, type ProjectReminder } from '../lib/workspace-reminders';
import { useBusinessSettings } from './BusinessSettingsContext';
import './reminder-workspace.css';

type Props = {
  state: WorkbenchState;
  member: MemberSession;
  pendingApprovals?: number;
  pendingSkills?: number;
  onNavigate: (view: View, id?: string) => void;
  onRefresh: () => Promise<void>;
  now?: number;
};
type ReminderType = 'all' | 'project' | 'approval' | 'skill';
type ReminderPeriod = 'all' | 'today' | 'overdue';
const deadlineFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const groupLabels = { overdue: '已逾期', urgent: '临近截止', upcoming: '即将截止' } as const;
const groups = ['overdue', 'urgent', 'upcoming'] as const;

export function reminderApprovalTotal(role: MemberSession['role'], pendingApprovals = 0, pendingSkills = 0): number {
  return role === 'manager' ? pendingApprovals + pendingSkills : 0;
}

export function ReminderWorkspace({ state, member, pendingApprovals = 0, pendingSkills = 0, onNavigate, onRefresh, now }: Props) {
  const id = useId();
  const { rules, refreshRules } = useBusinessSettings();
  const [clock, setClock] = useState(() => Date.now());
  const [type, setType] = useState<ReminderType>('all');
  const [period, setPeriod] = useState<ReminderPeriod>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const results = useRef<HTMLDivElement>(null);
  const time = now ?? clock;
  const today = shanghaiDate(time);
  const { items, counts } = useMemo(() => deriveProjectReminders(state.deals, time, rules), [state.deals, time, rules]);
  const total = counts.total + reminderApprovalTotal(member.role, pendingApprovals, pendingSkills);
  const reviewItems = member.role === 'manager' ? [
    { type: 'approval' as const, count: pendingApprovals, label: '合同审批', desc: '商务条款或合同初审已提交，等待你在审批流中确认签署意见。', action: '查看待审批', view: 'approvals' as const },
    { type: 'skill' as const, count: pendingSkills, label: '候选 Skill', desc: '来自团队实战对话提炼的经验候选，需核对原始证据与适用边界后发布生效。', action: '查看候选 Skill', view: 'knowledge' as const, id: 'skill-review' },
  ] : [];
  const visibleReviews = reviewItems.filter(item => item.count > 0 && (type === 'all' || type === item.type) && period === 'all');
  const visibleProjects = type === 'all' || type === 'project' ? items.filter(item =>
    period === 'all' || (period === 'overdue' ? item.urgency === 'overdue' : shanghaiDate(item.deadline) === today),
  ) : [];
  const visibleCount = visibleProjects.length + visibleReviews.reduce((count, item) => count + item.count, 0);
  const todayCount = items.filter(item => item.urgency !== 'overdue' && shanghaiDate(item.deadline) === today).length;

  useEffect(() => {
    if (now !== undefined) return;
    const update = () => setClock(Date.now());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener('focus', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
    };
  }, [now]);

  async function refresh() {
    setRefreshing(true);
    setFeedback('');
    setError('');
    try {
      await Promise.all([onRefresh(), refreshRules()]);
      setFeedback('提醒已刷新。');
    } catch {
      setError('未能刷新提醒，仍显示上次读取的资料。');
    } finally {
      setClock(Date.now());
      setRefreshing(false);
    }
  }

  function focusFirstReminder() {
    const first = results.current?.querySelector<HTMLElement>('[data-reminder-title]');
    if (!first) return;
    first.focus({ preventScroll: true });
    first.closest('article')?.scrollIntoView({ block: 'nearest', behavior: preferredScrollBehavior() });
  }

  function projectCard(item: ProjectReminder) {
    const titleId = `${id}-project-${item.dealId}`;
    return <li key={item.dealId}><article className="reminder-card">
      <div className="reminder-card-meta">
        <span className="reminder-badge" data-urgency={item.urgency}>{urgencyLabel(item.urgency, rules)}</span>
        <span className="reminder-category">项目截止</span>
        <time dateTime={item.deadline}>{deadlineFormat.format(new Date(item.deadline))}</time>
      </div>
      <h4 id={titleId} data-reminder-title tabIndex={-1}>{item.title}</h4>
      {(item.company !== item.title || item.nextAction) && <dl className="reminder-context">
        {item.company !== item.title && <div><dt><FileText size={14} aria-hidden="true" />关联企业</dt><dd>{item.company}</dd></div>}
        {item.nextAction && <div><dt><ArrowRight size={14} aria-hidden="true" />下一步</dt><dd>{item.nextAction}</dd></div>}
      </dl>}
      <div className="reminder-actions"><button type="button" className="button secondary" aria-describedby={titleId} onClick={() => onNavigate('deals', item.dealId)}>打开项目<ArrowRight size={15} aria-hidden="true" /></button></div>
    </article></li>;
  }

  return <section className="reminder-workspace" aria-labelledby={`${id}-title`}>
    <header className="reminder-header">
      <div><h1 id={`${id}-title`}>提醒</h1><p>项目截止和待审核事项</p></div>
      <button type="button" className="button secondary" disabled={refreshing} onClick={() => void refresh()}>
        <RefreshCw size={15} className={refreshing ? 'spin' : undefined} aria-hidden="true" />{refreshing ? '刷新中…' : '刷新'}
      </button>
    </header>
    <div className="reminder-content">
      {error && <p className="reminder-error" role="alert">{error}</p>}
      <p className="sr-only" role="status">{feedback}</p>
      <section className="reminder-overview" aria-labelledby={`${id}-overview`}>
        <div className="reminder-overview-main">
          <h2 id={`${id}-overview`}>今日待办概览</h2>
          <p className="reminder-overview-title">{total ? `当前共 ${total} 项事项待跟进` : '当前没有待处理提醒'}</p>
          <p className="reminder-overview-summary">{counts.total > 0 ? `${counts.overdue ? `${counts.overdue} 个项目已逾期` : '暂无逾期项目'}${todayCount > 0 ? `，另有 ${todayCount} 个项目今日截止` : ''}。` : visibleReviews.length > 0 ? '所有关联项目均在正常跟进周期内，请重点关注下方待审核事项。' : member.role === 'manager' ? '团队关联项目与待审核事项均已处理完毕，运行状态正常。' : '所有关联项目均在正常跟进周期内，暂无逾期或临近截止事项。'}</p>
          <div className="reminder-actions">
            {visibleCount > 0 && <button type="button" className="button primary" onClick={focusFirstReminder}><ArrowDown size={15} aria-hidden="true" />查看首条提醒</button>}
            <button type="button" className="button secondary" onClick={() => onNavigate('schedule')}><CalendarDays size={15} aria-hidden="true" />查看日程</button>
          </div>
        </div>
        <div className="reminder-kpi-strip" aria-label="提醒分类统计">
          {member.role === 'manager' ? <>
            <div className="reminder-kpi-item"><span>项目截止</span><strong>{counts.total}</strong><small>{counts.overdue ? `${counts.overdue} 项逾期` : '进度正常'}</small></div>
            <div className="reminder-kpi-item"><span>合同待审</span><strong>{pendingApprovals}</strong><small>{pendingApprovals ? '待人工审批' : '全部已处理'}</small></div>
            <div className="reminder-kpi-item"><span>候选经验</span><strong>{pendingSkills}</strong><small>{pendingSkills ? '待核验发布' : '无积压候选'}</small></div>
          </> : <>
            <div className="reminder-kpi-item"><span>逾期跟进</span><strong>{counts.overdue}</strong><small>{counts.overdue ? '需优先推进' : '无逾期事项'}</small></div>
            <div className="reminder-kpi-item"><span>临近截止</span><strong>{counts.total - counts.overdue}</strong><small>{counts.total > counts.overdue ? '关注截止节点' : '周期正常'}</small></div>
            <div className="reminder-kpi-item"><span>在跟客户</span><strong>{state.deals.filter(deal => !deal.outcome && !deal.archive).length}</strong><small>持续推进中</small></div>
          </>}
        </div>
      </section>

      {total === 0 && <section className="reminder-calm-panel" aria-label="巡检正常与快捷跟进">
        <div className="reminder-calm-head">
          <span className="reminder-calm-icon" aria-hidden="true"><ClipboardCheck size={20} /></span>
          <div>
            <h3>项目截止巡检全部正常</h3>
            <p>当前归属项目均处于健康推进周期内。你可以直接前往以下高频工作区推进今日业务。</p>
          </div>
        </div>
        <div className="reminder-calm-shortcuts">
          <button type="button" onClick={() => onNavigate('deals')}><span>01 · 商机协同</span><strong>进入项目跟进</strong><small>梳理客户痛点、记录拜访纪要并生成下一步推进方案</small></button>
          <button type="button" onClick={() => onNavigate('schedule')}><span>02 · 时间规划</span><strong>安排今日日程</strong><small>在周视图登记客户回访、方案演示与关键提醒节点</small></button>
          <button type="button" onClick={() => onNavigate('prospecting')}><span>03 · 增量线索</span><strong>发现高意向客群</strong><small>采集公开评论线索或检索全网询价动态拓展新商机</small></button>
        </div>
      </section>}

      {total > 0 && <section className="reminder-results" aria-labelledby={`${id}-results`}>
        <header className="reminder-results-header">
          <h2 id={`${id}-results`}>待处理<span className="reminder-count">{total}</span></h2>
          <div className="reminder-filters" role="group" aria-label="筛选提醒">
            <label htmlFor={`${id}-type`} className="sr-only">提醒类型</label>
            <select id={`${id}-type`} value={type} onChange={event => {
              const value = event.target.value as ReminderType;
              setType(value);
              if (value === 'approval' || value === 'skill') setPeriod('all');
            }}>
              <option value="all">全部提醒类型</option><option value="project">项目截止</option>
              {member.role === 'manager' && <><option value="approval">合同审批</option><option value="skill">候选 Skill</option></>}
            </select>
            <label htmlFor={`${id}-period`} className="sr-only">截止时间</label>
            <select id={`${id}-period`} value={period} disabled={type === 'approval' || type === 'skill'} onChange={event => setPeriod(event.target.value as ReminderPeriod)}>
              <option value="all">全部截止时间</option><option value="today">仅看今天截止</option><option value="overdue">仅看已逾期</option>
            </select>
            <span className="reminder-filter-count" role="status">显示 {visibleCount} 件</span>
          </div>
        </header>
        <div className="reminder-groups" ref={results}>
          {groups.map(urgency => {
            const entries = visibleProjects.filter(item => item.urgency === urgency);
            return entries.length > 0 && <section key={urgency} aria-labelledby={`${id}-${urgency}`}>
              <h3 id={`${id}-${urgency}`} className="reminder-group-heading">{groupLabels[urgency]}<span>{entries.length} 件</span></h3>
              <ul role="list" className="reminder-list">{entries.map(projectCard)}</ul>
            </section>;
          })}
          {visibleReviews.length > 0 && <section aria-labelledby={`${id}-reviews`}>
            <h3 id={`${id}-reviews`} className="reminder-group-heading">待我审核<span>{visibleReviews.reduce((count, item) => count + item.count, 0)} 件</span></h3>
            <ul role="list" className="reminder-list">{visibleReviews.map(item => {
              const candidatePreviews = item.type === 'skill' ? state.skills.filter(skill => skill.status === 'candidate').slice(0, 4) : [];
              return <li key={item.type}><article className="reminder-card reminder-review-card">
                <div className="reminder-review-head">
                  <div className="reminder-review-body">
                    <div className="reminder-card-meta"><span className="reminder-badge" data-urgency="upcoming">待审核</span><span className="reminder-category">{item.label}</span></div>
                    <h4 data-reminder-title tabIndex={-1}>{item.count} 件 {item.label} 待处理</h4>
                    <p className="reminder-review-desc">{item.desc}</p>
                  </div>
                  <div className="reminder-actions"><button type="button" className="button primary" onClick={() => onNavigate(item.view, item.id)}>{item.action}<ArrowRight size={15} aria-hidden="true" /></button></div>
                </div>
                {candidatePreviews.length > 0 && <div className="reminder-skill-previews" aria-label="待审核经验预览">
                  {candidatePreviews.map(skill => <button key={skill.id} type="button" className="reminder-skill-row" onClick={() => onNavigate(item.view, item.id)}>
                    <span className="reminder-skill-cat">{skill.category}</span>
                    <strong>{skill.title}</strong>
                    <small>{skill.scenario}</small>
                    <em>{skill.author} 提交</em>
                  </button>)}
                </div>}
              </article></li>;
            })}</ul>
          </section>}
          {counts.total === 0 && visibleReviews.length > 0 && <div className="reminder-rule-note" aria-hidden="true">
            <ClipboardCheck size={16} />
            <span>项目截止巡检正常：当前团队 {state.deals.length} 个在跟项目均未触发逾期或临近截止预警。</span>
          </div>}
          {visibleCount === 0 && <div className="reminder-empty">
            <Bell size={22} aria-hidden="true" />
            <h3>没有符合筛选条件的提醒</h3>
            <button type="button" className="button secondary" onClick={() => { setType('all'); setPeriod('all'); }}>清除筛选</button>
          </div>}
        </div>
      </section>}
    </div>
  </section>;
}
