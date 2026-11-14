'use client';

import { Check, ChevronDown, CircleAlert, GitBranch, Loader2, Minus } from 'lucide-react';
import type { ChatProgressStep } from '../lib/chat-progress';
import './chat-processing.css';

const statusText = { running: '进行中', success: '已完成', warning: '需留意', error: '未完成', skipped: '已跳过' };
const statusIcon = { running: Loader2, success: Check, warning: CircleAlert, error: CircleAlert, skipped: Minus };

export function ChatProcessing({ steps }: { steps: ChatProgressStep[] }) {
  const latest = steps.findLast(step => step.status === 'running') ?? steps.at(-1);
  return <div className="chat-processing">
    <p className="sr-only" role="status">{latest ? `${latest.title}，${statusText[latest.status]}` : '正在处理你的问题'}</p>
    <details className="trace-accordion chat-processing-details" open>
      <summary><span><GitBranch size={14} aria-hidden="true" />处理过程</span><ChevronDown size={14} aria-hidden="true" /></summary>
      {steps.length ? <ol className="chat-processing-steps" aria-label="处理步骤">{steps.map(step => {
        const Icon = statusIcon[step.status];
        return <li key={step.id} className="chat-processing-step">
          <Icon size={15} aria-hidden="true" className={step.status === 'running' ? 'spin' : undefined} />
          <div><strong>{step.title}</strong>{step.detail && <p>{step.detail}</p>}</div>
          <span>{statusText[step.status]}</span>
        </li>;
      })}</ol> : <p className="chat-processing-waiting"><Loader2 size={15} className="spin" aria-hidden="true" />正在处理你的问题</p>}
    </details>
  </div>;
}
