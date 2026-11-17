'use client';

import { memo } from 'react';
import { BookOpen, ChevronDown, Sparkles } from 'lucide-react';
import { runAnswerForDisplay, runGenerationLabel } from '../lib/run-history';
import type { Run } from '../lib/types';
import { AnswerContent } from './AnswerContent';

const HistoricalAnswer = memo(AnswerContent);

interface Props {
  history: readonly Run[];
  formatTime: (timestamp: string) => string;
  notify: (message: string) => void;
}

export const CustomerConversationHistory = memo(function CustomerConversationHistory({ history, formatTime, notify }: Props) {
  return history.map(run => <article className="cw-chat-turn" key={run.id}>
    <div className="cw-user-message">{run.query}</div>
    <div className="cw-assistant-label"><Sparkles size={14} aria-hidden="true" /><strong>AI 营销助手</strong><span>{runGenerationLabel(run)}</span></div>
    {run.steps.length > 0 && <details className="cw-turn-trace">
      <summary>处理过程<ChevronDown size={13} aria-hidden="true" /></summary>
      <ol>{run.steps.map(step => <li key={step.id}><strong>{step.title}</strong><p>{step.detail}</p></li>)}</ol>
    </details>}
    {run.answer ? <HistoricalAnswer text={runAnswerForDisplay(run.answer)} /> : <p className="cw-muted">此次运行尚未返回回答。</p>}
    {run.status && run.status !== 'completed' && <p className="cw-error">{run.status === 'failed' ? '本次任务未完成。' : `任务状态：${run.status}`}</p>}
    {run.citations.length > 0 && <details className="cw-citations">
      <summary><BookOpen size={14} aria-hidden="true" />参考来源 · {run.citations.length}<ChevronDown size={13} aria-hidden="true" /></summary>
      {run.citations.map((citation, index) => <details key={`${citation.id}:${index}`}><summary>{citation.title}</summary><p>{citation.excerpt}</p></details>)}
    </details>}
    <div className="cw-turn-footer">
      <time>{formatTime(run.createdAt)}</time>
      <button type="button" onClick={() => void navigator.clipboard.writeText(run.answer).then(() => notify('已复制回答')).catch(() => notify('浏览器未允许复制，请选择文本复制。'))}>复制</button>
    </div>
  </article>);
});
