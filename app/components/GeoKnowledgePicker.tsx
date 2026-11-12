'use client';

import { ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { studioRequest } from '../lib/creative-studio-client';
import type { GeoSource } from '../lib/geo-types';
import type { KnowledgeHit, KnowledgeSearchResult } from '../lib/knowledge-library-types';
import './geo-knowledge-picker.css';

export default function GeoKnowledgePicker({ disabled, onSelect }: { disabled: boolean; onSelect: (source: GeoSource) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  async function search() {
    if (disabled || busy || !query.trim()) return;
    setBusy(true);
    setError('');
    setHits(null);
    try {
      const data = await studioRequest<KnowledgeSearchResult>('', { action: 'search', query: query.trim(), mode: 'bm25' }, '/api/knowledge-library');
      setHits(data.hits.slice(0, 6));
    } catch (error) {
      setError(error instanceof Error ? error.message : '知识库暂不可用。');
    } finally {
      setBusy(false);
    }
  }

  return <details className="geo-knowledge-picker">
    <summary><ChevronRight size={16} aria-hidden="true" /> 从知识库选取资料</summary>
    <div className="geo-knowledge-picker-body">
      <div className="geo-knowledge-search">
        <label>知识库关键词
          <input value={query} maxLength={300} disabled={disabled || busy} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void search(); } }} />
        </label>
        <button type="button" className="button secondary" onClick={() => void search()} disabled={disabled || busy || !query.trim()}><Search size={15} /> 检索</button>
      </div>
      {busy && <p role="status">正在检索知识库…</p>}
      {error && <p role="alert">{error}</p>}
      {hits?.length === 0 && <p>没有匹配片段。请换一个关键词。</p>}
      {hits?.length ? <ul>
        {hits.map(hit => <li key={hit.id}>
          <strong>{hit.title}</strong><small>{hit.libraryName} · 片段 {hit.ordinal}</small>
          <p>{hit.matchedText.slice(0, 420)}{hit.matchedText.length > 420 ? '…' : ''}</p>
          <button type="button" className="button secondary" disabled={disabled || selected.includes(hit.id)} onClick={() => {
            onSelect({ title: `${hit.title} · 片段 ${hit.ordinal}`.slice(0, 160), url: '', excerpt: hit.matchedText.slice(0, 1800) });
            setSelected(current => [...current, hit.id]);
          }}><Plus size={15} /> {selected.includes(hit.id) ? '已添加' : '添加片段'}</button>
        </li>)}
      </ul> : null}
    </div>
  </details>;
}
