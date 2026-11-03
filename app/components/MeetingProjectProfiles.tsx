'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CircleAlert, Loader2 } from 'lucide-react';
import type { MeetingImportSummary, MeetingSyncView } from '../lib/meeting-import-types';
import { MeetingAnalysisContent } from './MeetingImportWorkspace';

export function MeetingProjectProfiles({ dealId, disabled = false, onImport }: { dealId: string; disabled?: boolean; onImport: () => void }) {
  const [items, setItems] = useState<MeetingImportSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void Promise.resolve().then(() => { if (active) { setLoading(true); setError(''); } });
    void fetch(`/api/meeting-imports?dealId=${encodeURIComponent(dealId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json() as MeetingSyncView & { error?: string };
      if (!response.ok) throw new Error(body.error || '会议画像暂未能加载，请重试。');
      if (active) setItems(body.imports);
    }).catch(reason => { if (active && !(reason instanceof DOMException && reason.name === 'AbortError')) setError(reason instanceof Error ? reason.message : '会议画像暂未能加载，请重试。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [dealId, retry]);
  return <section className="project-section meeting-project-profiles"><div className="project-section-heading"><div><h2>会议中的客户画像</h2><p>从已关联的会议中整理企业、人物和沟通要点，保留材料依据。</p></div><button className="button secondary" disabled={disabled} onClick={onImport}>导入会议 <ArrowRight size={14} /></button></div>
    {loading ? <p className="meeting-detail-loading"><Loader2 size={15} className="spin" />正在读取会议画像…</p> : error ? <div className="meeting-message is-error" role="alert"><CircleAlert size={16} /><div><p>{error}</p><button className="button secondary" onClick={() => setRetry(value => value + 1)}>重新加载</button></div></div> : items.length ? items.map(item => <details className="meeting-project-source" key={item.id}><summary><span>{item.record.subject}</span><small>{item.analysis.status === 'ready' ? '查看画像' : '画像待生成'}</small></summary><MeetingAnalysisContent analysis={item.analysis} /></details>) : <p className="meeting-history-empty">还没有关联会议。导入纪要或转写后，系统会整理有依据的公司与人物信息。</p>}
  </section>;
}
