'use client';
import { useState } from 'react';
import type { ProspectCampaign, ProspectSnapshot } from '../lib/prospecting-types';

export function ProspectingDailyDiscovery({ campaign, runs, busy, onSave, onRun, onDirtyChange }: { campaign: ProspectCampaign; runs: ProspectSnapshot['discoveryRuns']; busy: boolean; onSave: (value: ProspectCampaign['dailyDiscovery']) => Promise<boolean>; onRun: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState<ProspectCampaign['dailyDiscovery']>();
  const value = draft ?? campaign.dailyDiscovery ?? { enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', includeNewCandidates: true };
  const latest = runs?.[0];
  const active = runs?.some(run => ['queued', 'discovering', 'collecting'].includes(run.status));
  const labels: Record<string, string> = { queued: '等待助手', discovering: '发现账号中', collecting: '采集评论中', completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' };
  const change = (patch: Partial<NonNullable<ProspectCampaign['dailyDiscovery']>>) => { setDraft({ ...value, ...patch }); onDirtyChange(true); };
  return <section className="prospect-daily" aria-label="每日发现"><form onSubmit={async event => { event.preventDefault(); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.time)) return; if (await onSave(value)) { setDraft(undefined); onDirtyChange(false); } }}><strong>每日发现</strong><label><input type="checkbox" checked={value.enabled} disabled={busy} onChange={event => change({ enabled: event.target.checked })} />每天自动运行</label><label>北京时间<input aria-label="每日发现时间" type="time" required value={value.time} disabled={busy} onChange={event => change({ time: event.target.value })} /></label><button className="button secondary" disabled={busy || !draft}>保存设置</button><button type="button" className="button secondary" disabled={busy || active || campaign.status === 'paused'} onClick={onRun}>立即运行</button></form><p>新发现账号自动纳入采集 · 下次：{campaign.dailyDiscovery?.enabled && campaign.dailyDiscovery.nextRunAt ? new Date(campaign.dailyDiscovery.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未安排'}</p>{latest && <div role="status"><span>{labels[latest.status] || latest.status}</span><span>新增 {latest.newAccounts} 个账号 · {latest.newComments} 条评论 · {latest.newLeads} 位客户</span><span>进度 {latest.completedJobs}/{latest.totalJobs}</span>{latest.error && <p>{latest.error}</p>}</div>}</section>;
}
