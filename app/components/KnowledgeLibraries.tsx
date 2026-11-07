'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ChevronRight, CircleAlert, Database, FileText, Layers, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import {
  KNOWLEDGE_TEXT_LIMIT, KNOWLEDGE_UPLOAD_ACCEPT,
  type KnowledgeChunk, type KnowledgeChunkStrategy, type KnowledgeDocument, type KnowledgeLibrary,
  type KnowledgeLibrarySnapshot, type KnowledgeRetrievalMode, type KnowledgeSearchResult,
} from '../lib/knowledge-library-types';
import { Overlay } from './CoreViews';
import './knowledge-libraries.css';

const endpoint = '/api/knowledge-library';
const titleLimit = 150;
const strategies: Record<KnowledgeChunkStrategy, { name: string; detail: string }> = {
  flat: { name: '普通分块', detail: '把资料切成独立片段，直接检索并返回命中的片段。' },
  'parent-child': { name: '父子分块', detail: '用较小的子块检索，命中后返回所在父块，保留上下文。' },
};
const modeLabels: Record<KnowledgeRetrievalMode, string> = { hybrid: '混合检索', bm25: '全文检索（BM25）', vector: '向量检索' };
const chunkLabels: Record<KnowledgeChunk['kind'], string> = { flat: '独立片段', parent: '父块', child: '子块' };

type Dialog = { kind: 'create' } | { kind: 'rename'; library: KnowledgeLibrary } | { kind: 'upload' }
  | { kind: 'preview' | 'remove'; document: KnowledgeDocument };
type ImportDraft = { title: string; text: string; fileName: string; strategy: KnowledgeChunkStrategy; warnings: string[] };
const emptyDraft: ImportDraft = { title: '', text: '', fileName: '', strategy: 'flat', warnings: [] };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
async function request<T>(signal: AbortSignal, body?: Record<string, unknown>, query?: string): Promise<T> {
  const response = await fetch(endpoint + (query ? '?' + query : ''), {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || '资料库操作未完成，请重试。');
  return payload;
}

export function KnowledgeLibraries({ notify }: { notify: (message: string) => void }) {
  const [snapshot, setSnapshot] = useState<KnowledgeLibrarySnapshot | null>(null);
  const [libraryId, setLibraryId] = useState('');
  const [view, setView] = useState<'documents' | 'search'>('documents');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ImportDraft>(emptyDraft);
  const [importMode, setImportMode] = useState<'file' | 'text'>('file');
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [mode, setMode] = useState<KnowledgeRetrievalMode>('hybrid');
  const [search, setSearch] = useState<{ query: string; result: KnowledgeSearchResult } | null>(null);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const operation = useRef<AbortController | null>(null);

  const acceptSnapshot = useCallback((next: KnowledgeLibrarySnapshot) => {
    setSnapshot(next);
    setLibraryId(previous => next.libraries.some(library => library.id === previous) ? previous : next.libraries[0]?.id || '');
    setScope(previous => next.libraries.some(library => library.id === previous) ? previous : '');
    setMode(previous => previous === 'vector' && !next.embeddingConfigured ? 'hybrid' : previous);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void request<KnowledgeLibrarySnapshot>(controller.signal).then(value => {
      if (!controller.signal.aborted) acceptSnapshot(value);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(messageOf(cause));
    }).finally(() => {
      if (!controller.signal.aborted) setBusy('');
    });
    return () => { controller.abort(); operation.current?.abort(); };
  }, [acceptSnapshot]);

  const current = snapshot?.libraries.find(library => library.id === libraryId);
  const documents = snapshot?.documents.filter(document => document.libraryId === libraryId) || [];
  const canManage = snapshot?.canManage === true;
  const hasEmbedding = snapshot?.embeddingConfigured === true;

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>, insideDialog = false) {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(label);
    if (insideDialog) setDialogError(''); else setError('');
    try { await work(controller.signal); }
    catch (cause) {
      if (!controller.signal.aborted) (insideDialog ? setDialogError : setError)(messageOf(cause));
    } finally {
      if (operation.current === controller) operation.current = null;
      if (!controller.signal.aborted) setBusy('');
    }
  }

  function selectLibrary(id: string) {
    setLibraryId(id);
    setScope(id);
    setSearch(null);
    setError('');
  }
  function openDialog(next: Dialog) {
    setDialogError('');
    if (next.kind === 'create' || next.kind === 'rename') setName(next.kind === 'rename' ? next.library.name : '');
    if (next.kind === 'upload') { setDraft(emptyDraft); setImportMode('file'); }
    setDialog(next);
  }
  function closeDialog() {
    if (!operation.current) { setDialog(null); setDialogError(''); }
  }
  function refresh() {
    void run('load', async signal => acceptSnapshot(await request<KnowledgeLibrarySnapshot>(signal)));
  }
  function saveLibrary(event: FormEvent) {
    event.preventDefault();
    if (!dialog || !name.trim() || (dialog.kind !== 'create' && dialog.kind !== 'rename')) return;
    void run('name', async signal => {
      if (dialog.kind === 'create') {
        const { library } = await request<{ library: KnowledgeLibrary }>(signal, { action: 'createLibrary', name: name.trim() });
        setSnapshot(previous => previous && { ...previous, libraries: [...previous.libraries, library] });
        selectLibrary(library.id);
        setView('documents');
        notify('资料库已创建');
      } else {
        await request(signal, { action: 'renameLibrary', libraryId: dialog.library.id, name: name.trim() });
        setSnapshot(previous => previous && { ...previous, libraries: previous.libraries.map(library => library.id === dialog.library.id ? { ...library, name: name.trim() } : library) });
        notify('资料库已改名');
      }
      setDialog(null);
    }, true);
  }
  function updateDocument(document: KnowledgeDocument) {
    setSnapshot(previous => {
      if (!previous) return previous;
      const exists = previous.documents.some(item => item.id === document.id);
      return {
        ...previous,
        documents: exists ? previous.documents.map(item => item.id === document.id ? document : item) : [document, ...previous.documents],
        libraries: exists ? previous.libraries : previous.libraries.map(library => library.id === document.libraryId ? { ...library, documentCount: library.documentCount + 1 } : library),
      };
    });
  }
  async function indexDocument(initial: KnowledgeDocument, signal: AbortSignal) {
    let currentDocument = initial;
    while (!signal.aborted && currentDocument.status !== 'ready') {
      const { document } = await request<{ document: KnowledgeDocument }>(signal, { action: 'index', documentId: initial.id });
      updateDocument(document);
      if (document.status === 'error') throw new Error(document.error || '向量索引未完成，可以重试。');
      if (document.status === 'pending' && document.indexedCount <= currentDocument.indexedCount) throw new Error('索引进度暂未更新，请刷新后继续。');
      currentDocument = document;
    }
  }
  function retryIndex(document: KnowledgeDocument) {
    if (!hasEmbedding) return;
    void run(document.id, async signal => {
      await indexDocument(document, signal);
      if (!signal.aborted) notify('向量索引已完成');
    });
  }
  function readFile(file: File | undefined) {
    if (!file) return;
    const lastFileTitle = draft.fileName.replace(/\.[^.]+$/, '').slice(0, titleLimit);
    setDraft(previous => ({ ...previous, text: '', fileName: '', warnings: [] }));
    void run('parse', async signal => {
      const { importKnowledgeFile } = await import('../lib/knowledge-library-import');
      const source = await importKnowledgeFile(file);
      if (signal.aborted) return;
      setDraft(previous => ({
        ...previous, ...source, title: previous.title && previous.title !== lastFileTitle ? previous.title : source.fileName.replace(/\.[^.]+$/, '').slice(0, titleLimit),
      }));
    }, true);
  }
  function saveDocument(event: FormEvent) {
    event.preventDefault();
    if (!current || !draft.title.trim() || !draft.text.trim() || (importMode === 'file' && !draft.fileName)) return;
    void run('upload', async signal => {
      const { document } = await request<{ document: KnowledgeDocument }>(signal, {
        action: 'upload', libraryId: current.id, title: draft.title.trim(), fileName: importMode === 'file' ? draft.fileName : '',
        text: draft.text, strategy: draft.strategy,
      });
      updateDocument(document);
      setDialog(null);
      setSearch(null);
      notify(hasEmbedding ? '资料已保存，正在处理向量索引' : '资料已保存，可用全文检索验证');
      if (hasEmbedding && document.status !== 'ready') {
        setBusy(document.id);
        try {
          await indexDocument(document, signal);
          if (!signal.aborted) notify('向量索引已完成');
        } catch (cause) {
          if (!signal.aborted) setError(messageOf(cause));
        }
      }
    }, true);
  }
  function preview(document: KnowledgeDocument) {
    setChunks([]);
    openDialog({ kind: 'preview', document });
    void run('preview', async signal => {
      const result = await request<{ chunks: KnowledgeChunk[] }>(signal, undefined, new URLSearchParams({ documentId: document.id }).toString());
      setChunks(result.chunks);
    }, true);
  }
  function removeDocument(document: KnowledgeDocument) {
    void run('remove', async signal => {
      await request(signal, { action: 'removeDocument', documentId: document.id });
      setSnapshot(previous => previous && {
        ...previous, documents: previous.documents.filter(item => item.id !== document.id),
        libraries: previous.libraries.map(library => library.id === document.libraryId ? { ...library, documentCount: Math.max(0, library.documentCount - 1) } : library),
      });
      setSearch(null);
      setDialog(null);
      notify('资料及其切片已移除');
    }, true);
  }
  function searchDocuments(event: FormEvent) {
    event.preventDefault();
    const text = query.trim();
    if (!text || (!hasEmbedding && mode === 'vector')) return;
    setSearch(null);
    void run('search', async signal => {
      const result = await request<KnowledgeSearchResult>(signal, { action: 'search', query: text, mode, ...(scope ? { libraryId: scope } : {}) });
      setSearch({ query: text, result });
    });
  }

  return <div className="knowledge-libraries">
    <header className="knowledge-libraries-heading"><div><h1>知识库</h1>{snapshot && !canManage && <span className="knowledge-readonly">只读 · 管理员和销售管理者可维护</span>}</div>
      <div className="knowledge-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={refresh}><RefreshCw size={15} />刷新</button>{canManage && <button className="button primary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'create' })}><Plus size={16} />新建资料库</button>}</div>
    </header>
    {error && <p className="knowledge-feedback is-error" role="alert"><CircleAlert size={17} />{error}</p>}
    {!snapshot ? (busy ? <p className="knowledge-feedback" role="status"><Loader2 size={17} className="spin" />正在读取资料库…</p> : <div className="knowledge-empty"><BookOpen size={24} /><h2>暂未能读取资料库</h2><button className="button secondary" onClick={refresh}>重新加载</button></div>) :
      <div className="knowledge-libraries-grid">
        <nav className="knowledge-library-list" aria-label="资料库列表">
          {snapshot.libraries.length ? snapshot.libraries.map(library => <button className="knowledge-library-option" key={library.id} type="button" disabled={Boolean(busy)} aria-pressed={library.id === libraryId} onClick={() => selectLibrary(library.id)}><Database size={16} /><span>{library.name}</span><small>{library.documentCount} 份</small></button>) : <p>暂无资料库</p>}
        </nav>
        <section className="knowledge-library-main" aria-label={current?.name || '资料库操作'}>
          <div className="knowledge-library-header"><div><h2>{current?.name || '全部资料'}</h2>{current && <span className="knowledge-library-count">{current.documentCount} 份</span>}</div>
            {canManage && current && <div className="knowledge-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'rename', library: current })}><Pencil size={15} />改名</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'upload' })}><Upload size={16} />导入资料</button></div>}
          </div>
          <div className="knowledge-local-tabs" aria-label="资料库操作"><button type="button" aria-pressed={view === 'documents'} onClick={() => { setView('documents'); setError(''); }}><FileText size={16} />资料</button><button type="button" aria-pressed={view === 'search'} onClick={() => { setView('search'); setError(''); }}><Search size={16} />检索测试</button></div>
          {!hasEmbedding && <p className="knowledge-feedback"><CircleAlert size={16} />向量服务未配置，当前可用全文检索（BM25）。</p>}
          {view === 'documents' ? documents.length ? <ul className="knowledge-document-list" aria-label="资料列表">{documents.map(document => {
            const indexing = busy === document.id;
            const status = indexing ? '正在建立向量索引' : document.status === 'ready' ? '向量索引已完成' : document.status === 'error' ? '索引失败' : '待向量索引';
            return <li key={document.id}><div className="knowledge-document-info"><FileText size={20} /><div><h3>{document.title}</h3><p>{document.fileName} · {strategies[document.strategy].name} · {document.chunkCount} 个可检索切片</p>
              <p className={document.status === 'error' ? 'is-error' : ''} aria-live="polite">{status}{document.indexedCount > 0 ? ' · 已向量化 ' + document.indexedCount + ' 段' : ''}{document.error && !indexing ? ' · ' + document.error : ''}</p></div></div>
              <div className="knowledge-actions knowledge-row-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={() => preview(document)}><Layers size={15} />预览切片</button>{canManage && hasEmbedding && document.status !== 'ready' && <button className="button ghost" disabled={Boolean(busy)} onClick={() => retryIndex(document)}>{indexing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{document.status === 'error' ? '重试索引' : '继续索引'}</button>}{canManage && <button className="icon-button" disabled={Boolean(busy)} aria-label={'删除 ' + document.title} onClick={() => openDialog({ kind: 'remove', document })}><Trash2 size={17} /></button>}</div>
            </li>;
          })}</ul> : <div className="knowledge-empty"><FileText size={26} /><h3>{current ? '这个库还没有资料' : '还没有资料库'}</h3>{!canManage && <p>请联系管理员或销售管理者导入。</p>}</div>
          : <div className="knowledge-search">
            <form className="knowledge-form" onSubmit={searchDocuments}>
              <label>检索问题<input placeholder="例如：客户续租时需要提供哪些资料？" value={query} maxLength={1500} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} required /></label>
              <div className="knowledge-search-controls"><label>检索范围<select value={scope} onChange={event => { setScope(event.target.value); setSearch(null); }} disabled={Boolean(busy)}><option value="">全部资料库</option>{snapshot.libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>
                <label>检索方式<select value={mode} onChange={event => { setMode(event.target.value as KnowledgeRetrievalMode); setSearch(null); }} disabled={Boolean(busy)}><option value="hybrid">{modeLabels.hybrid}</option><option value="bm25">{modeLabels.bm25}</option><option value="vector" disabled={!hasEmbedding}>{modeLabels.vector}</option></select></label>
                <button className="button primary" disabled={Boolean(busy) || !query.trim()}>{busy === 'search' ? <Loader2 size={16} className="spin" /> : <Search size={16} />}测试检索</button></div>
            </form>
            {search && <div className="knowledge-search-output" aria-live="polite"><div className="knowledge-search-summary"><h3>命中 {search.result.hits.length} 段</h3><p>{modeLabels[search.result.mode]} · {search.query}</p></div>
              {search.result.notice && <p className="knowledge-feedback"><CircleAlert size={16} />{search.result.notice}</p>}
              {search.result.hits.length ? <ol className="knowledge-hit-list">{search.result.hits.map(hit => <li key={hit.id}><h4>{hit.title}</h4><p>{hit.libraryName} · {hit.fileName}{hit.heading ? ' · ' + hit.heading : ''} · 切片 {hit.ordinal}</p><div className="knowledge-hit-text"><strong>命中片段</strong><p>{hit.matchedText}</p></div>{hit.parent && <details><summary><ChevronRight size={15} />查看父块上下文</summary><p>{hit.context}</p></details>}<footer>{hit.bm25 !== null && <span>BM25 {hit.bm25.toFixed(3)}</span>}{hit.vector !== null && <span>向量相似度 {hit.vector.toFixed(3)}</span>}</footer></li>)}</ol> : <p className="knowledge-empty-search">未命中。请调整关键词、检索范围或检查索引状态。</p>}
            </div>}
          </div>}
        </section>
      </div>}
    {dialog && <Overlay title={dialog.kind === 'create' ? '新建资料库' : dialog.kind === 'rename' ? '资料库改名' : dialog.kind === 'upload' ? '导入资料' : dialog.kind === 'preview' ? '预览切片' : '删除资料'} onClose={closeDialog} wide={dialog.kind === 'preview'} className="knowledge-dialog">
      {dialogError && <p className="knowledge-feedback is-error" role="alert"><CircleAlert size={17} />{dialogError}</p>}
      {(dialog.kind === 'create' || dialog.kind === 'rename') && <form className="knowledge-form" onSubmit={saveLibrary}>
        <label>资料库名称<input placeholder="例如：产品与服务" value={name} maxLength={60} onChange={event => setName(event.target.value)} required autoFocus disabled={Boolean(busy)} /></label>
        <div className="knowledge-actions knowledge-dialog-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeDialog}>取消</button><button className="button primary" disabled={Boolean(busy) || !name.trim()}>{busy === 'name' ? '正在保存…' : dialog.kind === 'create' ? '创建资料库' : '保存名称'}</button></div>
      </form>}
      {dialog.kind === 'upload' && <form className="knowledge-form" onSubmit={saveDocument}>
        <p className="knowledge-dialog-description">{current?.name} · 保存解析正文和文件名</p>
        <div className="knowledge-local-tabs" aria-label="资料来源"><button type="button" aria-pressed={importMode === 'file'} disabled={Boolean(busy)} onClick={() => { setImportMode('file'); setDraft(previous => ({ ...previous, text: '', fileName: '', warnings: [] })); setDialogError(''); }}><Upload size={15} />上传文件</button><button type="button" aria-pressed={importMode === 'text'} disabled={Boolean(busy)} onClick={() => { setImportMode('text'); setDraft(previous => ({ ...previous, text: '', fileName: '', warnings: [] })); setDialogError(''); }}><FileText size={15} />粘贴文本</button></div>
        {importMode === 'file' ? <label>选择文档<input type="file" accept={KNOWLEDGE_UPLOAD_ACCEPT} disabled={Boolean(busy)} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; readFile(file); }} /><small>Excel（XLSX / XLS）/ PDF / DOCX / TXT / Markdown / CSV · 最大 10 MB</small>{busy === 'parse' ? <small role="status">正在解析文件…</small> : draft.fileName && <small role="status">{draft.fileName} · 已提取 {draft.text.length.toLocaleString()} 字符</small>}</label> :
          <label>正文<textarea rows={6} maxLength={KNOWLEDGE_TEXT_LIMIT} value={draft.text} onChange={event => setDraft(previous => ({ ...previous, text: event.target.value }))} disabled={Boolean(busy)} required placeholder="粘贴政策、话术或说明正文" /><small>{draft.text.length.toLocaleString()} / {KNOWLEDGE_TEXT_LIMIT.toLocaleString()} 字符</small></label>}
        {draft.warnings.map(warning => <p key={warning} className="knowledge-feedback"><CircleAlert size={16} />{warning}</p>)}
        <label>资料标题<input value={draft.title} maxLength={titleLimit} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} disabled={Boolean(busy)} required /></label>
        <fieldset className="knowledge-chunk-options"><legend>分块方式</legend>{Object.entries(strategies).map(([value, info]) => <label key={value}><input type="radio" name="knowledge-chunk-strategy" value={value} checked={draft.strategy === value} disabled={Boolean(busy)} onChange={() => setDraft(previous => ({ ...previous, strategy: value as KnowledgeChunkStrategy }))} /><span><strong>{info.name}</strong><small>{info.detail}</small></span></label>)}</fieldset>
        <div className="knowledge-actions knowledge-dialog-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeDialog}>取消</button><button className="button primary" disabled={Boolean(busy) || !draft.title.trim() || !draft.text.trim() || (importMode === 'file' && !draft.fileName)}>{busy === 'upload' ? '正在导入…' : '导入资料'}</button></div>
      </form>}
      {dialog.kind === 'preview' && <div className="knowledge-preview"><p className="knowledge-dialog-description">{dialog.document.title} · {strategies[dialog.document.strategy].name} · {dialog.document.chunkCount} 个可检索切片</p>
        {busy === 'preview' ? <p className="knowledge-feedback" role="status"><Loader2 size={17} className="spin" />正在读取切片…</p> : chunks.length ? chunks.map((chunk, index) => <details key={chunk.id} open={index === 0 || undefined}><summary><ChevronRight size={16} /><span>切片 {chunk.ordinal} · {chunkLabels[chunk.kind]}{chunk.heading ? ' · ' + chunk.heading : ''}{chunk.parentOrdinal !== null ? ' · 父块 ' + chunk.parentOrdinal : ''}</span></summary><p>{chunk.text}</p></details>) : !dialogError && <p>暂无可预览切片。</p>}
      </div>}
      {dialog.kind === 'remove' && <div className="knowledge-form"><p className="knowledge-dialog-description">删除「{dialog.document.title}」后，正文、切片及索引都会移除。这项操作无法撤销。</p><div className="knowledge-actions knowledge-dialog-actions"><button className="button secondary" data-dialog-initial-focus disabled={Boolean(busy)} onClick={closeDialog}>保留资料</button><button className="button danger" disabled={Boolean(busy)} onClick={() => removeDocument(dialog.document)}>{busy === 'remove' ? '正在删除…' : '确认删除'}</button></div></div>}
    </Overlay>}
  </div>;
}
