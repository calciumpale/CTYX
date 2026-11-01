'use client';

import type { CSSProperties } from 'react';
import { AlarmClock, ArrowUpRight, CalendarClock, MessageSquarePlus, Palette, Plus } from 'lucide-react';
import { STAGES, type Deal } from '../lib/types';
import { normalizedCardColor, projectCardTone, projectUrgency, urgencyLabel } from '../lib/project-deadline';
import { ProjectSalesBadges } from './ProjectSalesIntelligence';
import { useBusinessSettings } from './BusinessSettingsContext';
import './project-board.css';

const titleFor = (deal: Deal) => deal.projectName || deal.name;
const deadlineFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export function ProjectDeadlineBadge({ deal, now }: { deal: Deal; now: number }) {
  const { rules } = useBusinessSettings();
  const urgency = projectUrgency(deal, now, rules);
  if (!deal.deadline || !Number.isFinite(Date.parse(deal.deadline))) return null;
  return <span className={`project-deadline project-deadline-${urgency}`} title={`下一步截止时间：${deadlineFormat.format(new Date(deal.deadline))}（北京时间）`}>
    {urgency === 'urgent' || urgency === 'overdue' ? <AlarmClock size={13} /> : <CalendarClock size={13} />}
    {urgency !== 'none' && <strong>{urgencyLabel(urgency, rules)}</strong>}<time dateTime={deal.deadline}>{deadlineFormat.format(new Date(deal.deadline))}</time>
  </span>;
}

export function ProjectOutcomeBadge({ deal }: { deal: Deal }) {
  return deal.outcome === 'won' || deal.outcome === 'lost' ? <span className={`project-outcome-badge project-outcome-${deal.outcome}`}>{deal.outcome === 'won' ? '已成单' : '已结束'}</span> : null;
}

export function ProjectBoard({ projects, stageFilter, now, onOpen, onFollowup, onCustomize, onCreate, disabled }: {
  projects: Deal[]; stageFilter: string; now: number; disabled?: boolean;
  onOpen: (deal: Deal) => void; onFollowup: (deal: Deal) => void; onCustomize: (deal: Deal) => void; onCreate: (stage: string) => void;
}) {
  const { rules } = useBusinessSettings();
  const stages = STAGES.filter(stage => stageFilter === 'all' || stage === stageFilter);
  return <>
    <div className="project-board-caption"><p>按阶段查看项目，可左右滚动。</p><span>截止前{rules.urgentDays}天内标红，{rules.warningDays}天内标橙；自定义颜色优先。</span></div>
    <section className="project-board" aria-label="按阶段排列的项目看板，可左右滚动" tabIndex={0}>
      {stages.map(stage => {
        const items = projects.filter(project => project.stage === stage);
        return <section className="project-board-column" key={stage} aria-label={`${stage}阶段，${items.length}个项目`}>
          <header className="project-board-column-heading"><h2>{stage}<span>{items.length}</span></h2><button disabled={disabled} className="icon-button" aria-label={`新建${stage}阶段项目`} onClick={() => onCreate(stage)}><Plus size={16} /></button></header>
          {items.length ? <ul className="project-board-cards">{items.map(deal => {
            const color = normalizedCardColor(deal.cardColor);
            const tone = projectCardTone(deal, now, rules);
            return <li key={deal.id} className={`project-board-card project-card-${tone}`} style={color ? { '--project-card-color': color } as CSSProperties : undefined}>
              <button disabled={disabled} className="project-board-open" onClick={() => onOpen(deal)} aria-label={`查看项目：${titleFor(deal)}`}><span className="project-board-card-title"><strong>{titleFor(deal)}</strong><ArrowUpRight size={15} /></span><span className="project-board-customer">{deal.name}{deal.contact ? ` · ${deal.contact}` : ''}</span></button>
              <div className="project-board-card-flags"><ProjectOutcomeBadge deal={deal} /><ProjectSalesBadges deal={deal} /><ProjectDeadlineBadge deal={deal} now={now} /></div>
              <p className="project-board-action">{deal.nextAction || '待安排下一步行动'}</p>
              <footer><span className="project-board-owner"><span aria-hidden="true">{Array.from(deal.owner || '待')[0]}</span>{deal.owner || '尚未分配'}</span><div><button disabled={disabled} className="icon-button" aria-label={`设置${titleFor(deal)}的截止时间和卡片颜色`} onClick={() => onCustomize(deal)} title="截止时间与卡片颜色"><Palette size={15} /></button><button disabled={disabled} className="project-board-followup" onClick={() => onFollowup(deal)} aria-label={`为${titleFor(deal)}新增跟进`}><MessageSquarePlus size={14} />跟进</button></div></footer>
            </li>;
          })}</ul> : <div className="project-board-column-empty"><p>暂无项目</p><button disabled={disabled} onClick={() => onCreate(stage)}><Plus size={14} />添加项目</button></div>}
        </section>;
      })}
    </section>
  </>;
}
