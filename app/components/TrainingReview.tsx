'use client';

import { Lightbulb } from 'lucide-react';
import type { TrainingSession } from '../lib/types';
import { Overlay } from './CoreViews';
import './training-review.css';

function suggestReply(customerReply: string, scenario: string) {
  if (/可以|好[的，。]|没问题/.test(customerReply) && /(?:点|[明后]天|周[一二三四五六日天]|看房|见面|预约)/.test(customerReply)) {
    return '复述双方达成的安排，确认时间、地点和对接人。把会前要准备的资料一并约好。';
  }
  if (/审批|拍板|合伙人|上级|书面|负责人/.test(customerReply)) {
    return '问清楚谁会做决定、需要看哪些材料，以及预计什么时候能确认。若有待审批条件，说明下一次反馈时间。';
  }
  if (/免租|优惠|折扣/.test(customerReply)) {
    return '先确认客户想缓解哪项开业或装修支出，再说明已确认的条件和仍需核实的部分。';
  }
  if (/对比|比较|竞品|其他园区/.test(customerReply)) {
    return '问客户两处最看重的差异。用同样的面积、计费周期和费用口径比较，再指出哪项需要对方确认。';
  }
  if (/价格|租金|费用|成本|预算|物业费|报价/.test(customerReply)) {
    return '先问客户想核对哪笔费用或总成本。把已知费用按月、一次性或另收项目说明，缺少数据时约好补充时间。';
  }
  if (/装修|开业|交付|搬迁|什么时候|排期/.test(customerReply)) {
    return '确认客户必须满足的日期和前置条件，再说明有哪些安排可配合。对还未确认的节点给出核实时间。';
  }
  if (/面积|位置|交通|客流|配套/.test(customerReply)) {
    return '先追问这个条件的最低要求，再给出能用现场信息核对的选项。';
  }
  if (/资料|清单|发给|核实|再看看|考虑/.test(customerReply)) {
    return '确认客户还需要哪项资料来判断，约定谁来发、何时发以及下一次什么时候沟通。';
  }
  if (/[？?]/.test(customerReply)) return '先直接回答客户刚问的那一点。需要核实的细节可以约定回复时间，再追问一个影响方案的条件。';
  return /首访/.test(scenario)
    ? '简短复述客户刚表达的需求，用一个具体问题了解他最先要解决的事。'
    : '承接客户刚说的内容，问一个能确认判断标准的问题，再根据他的回答推进。';
}

export function TrainingReplyTip({ message, scenario }: { message: TrainingSession['messages'][number]; scenario: string }) {
  return <div className="training-reply-tip">
    <strong><Lightbulb size={14} aria-hidden="true" />建议怎么回答</strong>
    <p>{message.replySuggestion || suggestReply(message.content, scenario)}</p>
  </div>;
}

export function TrainingReview({ session, onClose }: { session: TrainingSession; onClose: () => void }) {
  const feedback = session.feedback ?? [];
  const hasSixDimensions = feedback.length === 6 && feedback.every(item => item.maxScore != null);
  return <Overlay className="training-review-dialog" title="练习复盘" onClose={onClose}>
    <div className="training-review-content">
      <div className="training-review-total">
        <div>
          <strong>{session.scenario}</strong>
          <p>{hasSixDimensions ? (session.evaluationMode === 'rubric' ? '六维评分 · 规则评估' : '六维评分') : (feedback.length ? '历史记录评分维度' : '暂无评分明细')}</p>
        </div>
        <span>{session.score ?? '—'} <small>/ 100</small></span>
      </div>
      {feedback.length > 0 && <ul className="training-review-dimensions">
        {feedback.map(item => <li key={item.id ?? item.label}>
          <div><strong>{item.label}</strong><span>{item.score}{item.maxScore != null ? ` / ${item.maxScore}` : ' 分'}</span></div>
          {item.maxScore != null && <meter min={0} max={item.maxScore} value={item.score} aria-label={item.label} />}
          <dl><dt>对话依据</dt><dd>{item.evidence}</dd><dt>下次试试</dt><dd>{item.suggestion}</dd></dl>
        </li>)}
      </ul>}
    </div>
  </Overlay>;
}
