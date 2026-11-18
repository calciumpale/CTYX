'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { BookOpen, ChevronRight, CircleAlert, Database, FileText, Layers, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import {
  KNOWLEDGE_TEXT_LIMIT, KNOWLEDGE_UPLOAD_ACCEPT,
  type KnowledgeChunk, type KnowledgeChunkStrategy, type KnowledgeDocument, type KnowledgeLibrary,
  type KnowledgeChunkPreview, type KnowledgeLibrarySnapshot, type KnowledgeRetrievalMode, type KnowledgeSearchResult,
} from '../lib/knowledge-library-types';
import { DEFAULT_KNOWLEDGE_CHUNK_CONFIG, describeKnowledgeChunkConfig } from '../lib/knowledge-chunking-config';
import { KnowledgeChunkControls } from './KnowledgeChunkControls';
import { KNOWLEDGE_DEPARTMENTS } from '../lib/knowledge-department-scope';
import { driveRechunk, documentWithRechunkJob, type RechunkResult } from './knowledge-rechunk-driver';
import { createKnowledgeRequestIdentity } from './knowledge-request-identity';
import { drainImportQueue, type ImportQueueItem, type KnowledgePdfParser } from './knowledge-import-queue';
import { importMineruPdf, readMineruAvailability } from './knowledge-mineru-import';
import { Overlay } from './CoreViews';
import { KnowledgeDocsIllustration } from './VisualIllustrations';
import './knowledge-libraries.css';

const endpoint = '/api/knowledge-library';
const titleLimit = 150;
const previewPageSize = 40;
const strategies: Record<KnowledgeChunkStrategy, { name: string; detail: string }> = {
  flat: { name: '普通分块', detail: '把资料切成独立片段，直接检索并返回命中的片段。' },
  'parent-child': { name: '父子分块', detail: '用较小的子块检索，命中后返回所在父块，保留上下文。' },
};
const modeLabels: Record<KnowledgeRetrievalMode, string> = { hybrid: '混合检索', bm25: '全文检索（BM25）', vector: '向量检索' };
const chunkLabels: Record<KnowledgeChunk['kind'], string> = { flat: '独立片段', parent: '父块', child: '子块' };

type Dialog = { kind: 'settings' } | { kind: 'rechunk'; document: KnowledgeDocument } | { kind: 'create' } | { kind: 'rename'; library: KnowledgeLibrary } | { kind: 'upload' }
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

export function KnowledgeLibraries({ notify, onBusyChange, onDirtyChange, embedded = false }: { notify: (message: string) => void; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void; embedded?: boolean }) {
  const [snapshot, setSnapshot] = useState<KnowledgeLibrarySnapshot | null>(null);
  const [libraryId, setLibraryId] = useState('');
  const [view, setView] = useState<'documents' | 'search'>('documents');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ImportDraft>(emptyDraft);
  const [importMode, setImportMode] = useState<'file' | 'text'>('file');
  const [pdfParser, setPdfParser] = useState<KnowledgePdfParser>('browser');
  const [mineruAvailability, setMineruAvailability] = useState<'checking' | 'available' | 'unconfigured' | 'unavailable'>('checking');
  const pdfParserId = useId();
  const mineruHintId = `${pdfParserId}-hint`;
  const [chunks, setChunks] = useState<KnowledgeChunk[]>([]);
  const [previewPage, setPreviewPage] = useState(0);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('');
  const [mode, setMode] = useState<KnowledgeRetrievalMode>('hybrid');
  const [search, setSearch] = useState<{ query: string; result: KnowledgeSearchResult } | null>(null);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [dialogError, setDialogError] = useState('');
  const [queue, setQueue] = useState<ImportQueueItem[]>([]);
  const stopQueue = useRef(false);
  const pauseRechunk = useRef(false);
  const [rechunkProgress, setRechunkProgress] = useState<RechunkResult | null>(null);
  const [rechunkNotice, setRechunkNotice] = useState('');
  const [config, setConfig] = useState(DEFAULT_KNOWLEDGE_CHUNK_CONFIG);
  const [departmentId, setDepartmentId] = useState('shared');
  const [rebuildIndex, setRebuildIndex] = useState(false);
  const [sourceText, setSourceText] = useState('');
  const [proposed, setProposed] = useState<KnowledgeChunkPreview | null>(null);
  const initialConfig = dialog?.kind === 'rechunk' ? dialog.document.appliedConfig || { ...DEFAULT_KNOWLEDGE_CHUNK_CONFIG, strategy: dialog.document.strategy } : snapshot?.libraries.find(item => item.id === libraryId)?.defaultConfig || DEFAULT_KNOWLEDGE_CHUNK_CONFIG;
  const initialDepartment = snapshot?.libraries.find(item => item.id === libraryId)?.departmentId || 'unassigned';
  const dirty = Boolean(draft.text || draft.title || sourceText || queue.some(item => item.state !== 'done') || (dialog?.kind === 'create' && name.trim()) || (dialog?.kind === 'rename' && name !== dialog.library.name) || (dialog?.kind === 'settings' && (departmentId !== initialDepartment || JSON.stringify(config) !== JSON.stringify(initialConfig))) || (dialog?.kind === 'rechunk' && JSON.stringify(config) !== JSON.stringify(initialConfig)));
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (busy || dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [busy, dirty]);
  const requestIdentity = useRef(createKnowledgeRequestIdentity());
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
  const importOpen = dialog?.kind === 'upload';
  const usesMineru = pdfParser === 'mineru' || queue.some(item => item.parser === 'mineru' && item.state !== 'done');

  useEffect(() => {
    if (!importOpen || !canManage) return;
    const controller = new AbortController();
    void readMineruAvailability(controller.signal).then(configured => {
      if (!controller.signal.aborted) setMineruAvailability(configured ? 'available' : 'unconfigured');
    }).catch(() => {
      if (!controller.signal.aborted) setMineruAvailability('unavailable');
    });
    return () => controller.abort();
  }, [importOpen, canManage]);

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
    if (busy || (dirty && !window.confirm('还有未提交资料或队列。确认切换资料库？')) ) return;
    setLibraryId(id);
    setScope(id);
    setSearch(null);
    setError('');
  }
  function openDialog(next: Dialog) {
    setDialogError(''); setRechunkNotice('');
    setRechunkProgress(next.kind === 'rechunk' && next.document.rechunkJob ? { document: next.document, job: next.document.rechunkJob } : null);
    if (next.kind === 'create' || next.kind === 'rename') setName(next.kind === 'rename' ? next.library.name : '');
    if (next.kind === 'upload') {
      setImportMode('file');
      setPdfParser('browser');
      setMineruAvailability('checking');
    }
    setProposed(null); setSourceText(''); setRebuildIndex(hasEmbedding);
    setConfig(next.kind === 'rechunk' ? next.document.appliedConfig || { ...DEFAULT_KNOWLEDGE_CHUNK_CONFIG, strategy: next.document.strategy } : current?.defaultConfig || DEFAULT_KNOWLEDGE_CHUNK_CONFIG);
    setDepartmentId(next.kind === 'create' ? 'shared' : current?.departmentId || 'unassigned');
    setDialog(next);
  }
  function closeDialog() {
    if (!operation.current && (!dirty || window.confirm('还有未提交修改。关闭后导入草稿仍保留，确认关闭？'))) { setDialog(null); setDialogError(''); }
  }
  function refresh() {
    void run('load', async signal => acceptSnapshot(await request<KnowledgeLibrarySnapshot>(signal)));
  }
  function saveLibrary(event: FormEvent) {
    event.preventDefault();
    if (!dialog || !name.trim() || (dialog.kind !== 'create' && dialog.kind !== 'rename')) return;
    void run('name', async signal => {
      if (dialog.kind === 'create') {
        const { library } = await request<{ library: KnowledgeLibrary }>(signal, { action: 'createLibrary', name: name.trim(), departmentId });
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
  function acceptRechunk(result: RechunkResult) {
    updateDocument(documentWithRechunkJob(result));
    setRechunkProgress(result);
    if (['completed', 'cancelled'].includes(result.job.status)) requestIdentity.current.retireDocument(result.document.id);
  }
  async function continueRechunk(initial: RechunkResult, signal: AbortSignal, retryError = false) {
    setRechunkNotice('');
    const result = await driveRechunk(initial, jobId => request<RechunkResult>(signal, { action: 'continueRechunk', jobId }), acceptRechunk, () => pauseRechunk.current, retryError);
    if (result.reason === 'error') throw new Error(result.job.error || '重新切块失败，旧内容仍可用');
    if (result.reason === 'cancelled') throw new Error('任务已取消或被替代，旧内容仍可用；可重新确认发起新任务。');
    if (result.reason === 'waiting') setRechunkNotice('任务暂未推进，可能正由其他请求处理。稍后可继续，旧内容仍可用。');
    if (result.reason === 'paused') setRechunkNotice('已暂停后续批次，可继续重新切块。已接受的请求仍可能完成。');
    return result;
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
  function addFiles(files: File[]) {
    if (!current || operation.current) return;
    if (files.length + queue.length > 20) { setDialogError('每批最多 20 个文件'); return; }
    const added: ImportQueueItem[] = [];
    for (const file of files) {
      if ([...queue, ...added].some(item => item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified)) { setDialogError('已跳过重复选择的文件'); continue; }
      const parser = /\.pdf$/i.test(file.name) ? pdfParser : 'browser';
      added.push({ id: crypto.randomUUID(), file, libraryId: current.id, config: structuredClone(config), rebuildIndex, parser, state: 'queued' });
    }
    setQueue(previous => [...previous, ...added]);
  }
  function startQueue() {
    stopQueue.current = false;
    void run('batch', async signal => {
      await drainImportQueue(queue, () => stopQueue.current, async item => {
        if (!item.document) {
          if (item.text === undefined && item.parser === 'mineru') {
            const text = await importMineruPdf(item, signal, progress => { item.progress = progress; setQueue([...queue]); }, () => stopQueue.current);
            if (text === undefined) return 'paused';
            item.text = text;
            item.progress = '正在入库';
            setQueue([...queue]);
          } else if (item.text === undefined) {
            const { importKnowledgeFile } = await import('../lib/knowledge-library-import');
            const parsed = await importKnowledgeFile(item.file);
            item.text = parsed.text;
            item.warnings = parsed.warnings;
          }
          const result = await request<{ document: KnowledgeDocument }>(signal, { action: 'upload', requestId: item.id, libraryId: item.libraryId, title: item.file.name.replace(/\.[^.]+$/, '').slice(0, titleLimit), fileName: item.file.name, text: item.text, config: item.config });
          item.document = result.document; updateDocument(result.document);
        }
        if (item.rebuildIndex) await indexDocument(item.document, signal);
      }, () => setQueue([...queue]));
    }, true);
  }
  function saveDocument(event: FormEvent) {
    event.preventDefault();
    if (!current || !draft.title.trim() || !draft.text.trim() || (importMode === 'file' && !draft.fileName)) return;
    void run('upload', async signal => {
      const { document } = await request<{ document: KnowledgeDocument }>(signal, {
        action: 'upload', libraryId: current.id, title: draft.title.trim(), fileName: importMode === 'file' ? draft.fileName : '',
        text: draft.text, config, requestId: requestIdentity.current({ action: 'upload', libraryId: current.id, title: draft.title.trim(), fileName: importMode === 'file' ? draft.fileName : '', text: draft.text, config }),
      });
      requestIdentity.current.retire({ action: 'upload', libraryId: current.id, title: draft.title.trim(), fileName: importMode === 'file' ? draft.fileName : '', text: draft.text, config });
      updateDocument(document);
      setDraft(emptyDraft);
      setDialog(null);
      setSearch(null);
      notify(rebuildIndex ? '资料已保存，正在处理向量索引' : '资料已保存，可用全文检索验证');
      if (rebuildIndex && document.status !== 'ready') {
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
    setChunks([]);setPreviewPage(0);
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
    {embedded ? (
      <div className="knowledge-libraries-toolbar">
        <span className="knowledge-libraries-summary">{snapshot ? (snapshot.libraries.length ? `共 ${snapshot.libraries.length} 个资料库 · ${snapshot.documents.length} 份已入库文档` : canManage ? '0 个可用资料库' : '0 个可用资料库 · 只读（管理员和销售管理者可维护）') : '正在同步资料库状态…'}</span>
        <div className="knowledge-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={refresh}><RefreshCw size={15} />刷新</button>{canManage && Boolean(snapshot?.libraries.length) && <button className="button primary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'create' })}><Plus size={16} />新建资料库</button>}</div>
      </div>
    ) : (
      <header className="knowledge-libraries-heading"><div><h1>知识库</h1>{snapshot && !canManage && <span className="knowledge-readonly">只读 · 管理员和销售管理者可维护</span>}</div>
        <div className="knowledge-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={refresh}><RefreshCw size={15} />刷新</button>{canManage && Boolean(snapshot?.libraries.length) && <button className="button primary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'create' })}><Plus size={16} />新建资料库</button>}</div>
      </header>
    )}
    {error && <p className="knowledge-feedback is-error" role="alert"><CircleAlert size={17} />{error}</p>}
    {!snapshot ? (busy ? <p className="knowledge-feedback" role="status"><Loader2 size={17} className="spin" />正在读取资料库…</p> : <div className="knowledge-empty"><BookOpen size={24} /><h2>暂未能读取资料库</h2><button className="button secondary" onClick={refresh}>重新加载</button></div>) :
      !snapshot.libraries.length ? <div className="knowledge-empty knowledge-empty-standalone">
        <KnowledgeDocsIllustration className="knowledge-empty-art" />
        <h3>还没有资料库</h3>
        <p>{canManage ? '创建部门专属或全员共享资料库，上传业务文档后自动完成切块与检索索引。' : '当前工作空间尚未建立资料库，请联系管理员或销售管理者创建并导入资料。'}</p>
        {canManage && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'create' })}><Plus size={16} />新建资料库</button>}
      </div> :
      <div className="knowledge-libraries-grid">
        <nav className="knowledge-library-list" aria-label="资料库列表">
          {snapshot.libraries.map(library => <button className="knowledge-library-option" key={library.id} type="button" disabled={Boolean(busy)} aria-pressed={library.id === libraryId} onClick={() => selectLibrary(library.id)}><Database size={16} /><span>{library.name}</span><small>{library.documentCount} 份</small></button>)}
        </nav>
        <section className="knowledge-library-main" aria-label={current?.name || '资料库操作'}>
          <div className="knowledge-library-header"><div><h2>{current?.name || '全部资料'}</h2>{current && <span className="knowledge-library-count">{current.documentCount} 份</span>}</div>
            {canManage && current && <div className="knowledge-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'settings' })}>资料库设置</button><button className="button ghost" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'rename', library: current })}><Pencil size={15} />改名</button><button className="button secondary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'upload' })}><Upload size={16} />导入资料</button></div>}
          </div>
          <div className="knowledge-local-tabs" aria-label="资料库操作"><button type="button" aria-pressed={view === 'documents'} onClick={() => { setView('documents'); setError(''); }}><FileText size={16} />资料</button><button type="button" aria-pressed={view === 'search'} onClick={() => { setView('search'); setError(''); }}><Search size={16} />检索测试</button></div>
          {!hasEmbedding && <p className="knowledge-feedback"><CircleAlert size={16} />向量服务未配置，当前可用全文检索（BM25）。</p>}
          {rechunkNotice && dialog?.kind !== 'rechunk' && <p role="status">{rechunkNotice}</p>}
          {busy === 'resume-rechunk' && <button className="button secondary" onClick={() => { pauseRechunk.current = true; }}>暂停后续批次（等待当前请求完成）</button>}
          {view === 'documents' ? documents.length ? <ul className="knowledge-document-list" aria-label="资料列表">{documents.map(document => {
            const indexing = busy === document.id;
            const status = indexing ? '正在建立向量索引' : document.status === 'ready' ? '向量索引已完成' : document.status === 'error' ? '索引失败' : '待向量索引';
            return <li key={document.id}><div className="knowledge-document-info"><FileText size={20} /><div><h3>{document.title}</h3><p>{document.fileName} · {strategies[document.strategy].name} · {document.chunkCount} 个可检索切片</p>
              <p className={document.status === 'error' ? 'is-error' : ''} aria-live="polite">{status}{document.indexedCount > 0 ? ' · 已向量化 ' + document.indexedCount + ' 段' : ''}{document.error && !indexing ? ' · ' + document.error : ''}</p></div></div>
              {document.rechunkJob && !['completed', 'cancelled'].includes(document.rechunkJob.status) && <div className="knowledge-form"><p role="status">重新切块：{document.rechunkJob.status} · {document.rechunkJob.indexedCount} / {document.rechunkJob.chunkCount} · 旧内容仍可用</p>{document.rechunkJob.error && <p role="alert">{document.rechunkJob.error}</p>}{canManage && <div className="knowledge-actions"><button className="button secondary" disabled={Boolean(busy)} onClick={() => void run('resume-rechunk', async signal => { pauseRechunk.current = false; await continueRechunk({ document, job: document.rechunkJob! }, signal, true); })}>继续重新切块</button><button className="button ghost" disabled={Boolean(busy)} onClick={() => void run('cancel-rechunk', async signal => { const result = await request<RechunkResult>(signal, { action: 'cancelRechunk', jobId: document.rechunkJob!.id }); acceptRechunk(result); setRechunkNotice(''); })}>取消暂存任务</button></div>}</div>}
              <div className="knowledge-actions knowledge-row-actions"><button className="button ghost" disabled={Boolean(busy)} onClick={() => preview(document)}><Layers size={15} />预览切片</button>{canManage && <button className="button ghost" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'rechunk', document })}>切块设置 / 重新切块</button>}{canManage && hasEmbedding && document.status !== 'ready' && <button className="button ghost" disabled={Boolean(busy)} onClick={() => retryIndex(document)}>{indexing ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}{document.status === 'error' ? '重试索引' : '继续索引'}</button>}{canManage && <button className="icon-button" disabled={Boolean(busy)} aria-label={'删除 ' + document.title} onClick={() => openDialog({ kind: 'remove', document })}><Trash2 size={17} /></button>}</div>
            </li>;
          })}</ul> : <div className="knowledge-empty">
            <KnowledgeDocsIllustration className="knowledge-empty-art" />
            <h3>{current ? '这个库还没有资料' : '还没有资料库'}</h3>
            <p>{!canManage ? '请联系管理员或销售管理者导入。' : current ? '上传业务文档或粘贴正文，自动完成切块与全文检索索引。' : '创建部门专属或全员共享资料库，为 AI 助手与获客接待提供可溯源知识支撑。'}</p>
            {canManage && !current && <button type="button" className="button primary" disabled={Boolean(busy)} onClick={() => openDialog({ kind: 'create' })}><Plus size={16} />新建第一个资料库</button>}
          </div>
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
    {dialog && <Overlay title={dialog.kind === 'create' ? '新建资料库' : dialog.kind === 'rename' ? '资料库改名' : dialog.kind === 'upload' ? '导入资料' : dialog.kind === 'preview' ? '预览切片' : dialog.kind === 'settings' ? '资料库设置' : dialog.kind === 'rechunk' ? '切块设置 / 重新切块' : '删除资料'} onClose={closeDialog} wide={dialog.kind === 'preview'} className="knowledge-dialog">
      {dialogError && <p className="knowledge-feedback is-error" role="alert"><CircleAlert size={17} />{dialogError}</p>}
      {(dialog.kind === 'create' || dialog.kind === 'rename') && <form className="knowledge-form" onSubmit={saveLibrary}>
        <label>资料库名称<input placeholder="例如：产品方案与报价规范" value={name} maxLength={60} onChange={event => setName(event.target.value)} required autoFocus disabled={Boolean(busy)} /></label>
        {dialog.kind === 'create' && <label>可见范围<select value={departmentId} onChange={event => setDepartmentId(event.target.value)} disabled={Boolean(busy)}><option value="shared">全部门共享</option>{KNOWLEDGE_DEPARTMENTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><small>全部门共享可供所有岗位检索；指定部门仅授权对应业务团队与 AI 会话引用。</small></label>}
        <div className="knowledge-actions knowledge-dialog-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeDialog}>取消</button><button className="button primary" disabled={Boolean(busy) || !name.trim()}>{busy === 'name' ? '正在保存…' : dialog.kind === 'create' ? '创建资料库' : '保存名称'}</button></div>
      </form>}
      {dialog.kind === 'upload' && <form className="knowledge-form" onSubmit={saveDocument}>
        <p className="knowledge-dialog-description">{current?.name} · {importMode === 'file' ? '批量解析文档并自动切块入库' : '粘贴文本正文并保存切块索引'}</p>
        <div className="knowledge-local-tabs" aria-label="资料来源"><button type="button" aria-pressed={importMode === 'file'} disabled={Boolean(busy)} onClick={() => { setImportMode('file'); setDialogError(''); }}><Upload size={15} />上传文件</button><button type="button" aria-pressed={importMode === 'text'} disabled={Boolean(busy)} onClick={() => { setImportMode('text'); setDialogError(''); }}><FileText size={15} />粘贴文本</button></div>
        {importMode === 'file' ? <>
          <div className="knowledge-parser-choice">
            <label htmlFor={pdfParserId}>PDF 解析方式</label>
            <select id={pdfParserId} value={pdfParser} aria-describedby={mineruHintId} disabled={Boolean(busy)} onChange={event => setPdfParser(event.target.value as KnowledgePdfParser)}>
              <option value="browser">浏览器解析</option><option value="mineru" disabled={mineruAvailability !== 'available'}>MinerU 云解析</option>
            </select>
            <small id={mineruHintId} role="status">{usesMineru ? '开始导入后，原始 PDF 将发送至 MinerU 云服务。请选择获准外发的资料。其他格式仍在浏览器解析。'
              : mineruAvailability === 'unconfigured' ? '请管理员在「服务连接」中配置 MinerU，以解析扫描件和复杂版面。'
              : mineruAvailability === 'unavailable' ? '暂时无法读取 MinerU 配置，可使用浏览器解析。'
              : mineruAvailability === 'checking' ? '正在检查 MinerU 配置…' : '扫描件、表格或多栏 PDF 可选 MinerU 云解析。'}</small>
          </div>
          {hasEmbedding && <label className="knowledge-index-option"><input type="checkbox" checked={rebuildIndex} onChange={event => setRebuildIndex(event.target.checked)} disabled={Boolean(busy)} />建立向量索引（关闭后使用全文检索）</label>}
          <KnowledgeChunkControls value={config} onChange={setConfig} disabled={Boolean(busy)} />
          <p className="knowledge-dialog-description">文件加入队列时保存当前解析、切块与索引设置。修改设置后，新加入的文件会使用新设置。</p>
          <div className="knowledge-upload-dropzone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); addFiles(Array.from(event.dataTransfer.files)); }}>
            <label>选择或拖入多个文档<input type="file" multiple accept={KNOWLEDGE_UPLOAD_ACCEPT} disabled={Boolean(busy)} onChange={event => { addFiles(Array.from(event.currentTarget.files || [])); event.currentTarget.value = ''; }} /><small>支持 PDF / Word / Excel / Markdown / CSV / TXT · 最多 20 份（每份 ≤ 10MB）</small></label>
            {queue.length > 0 && <>
              <ul className="knowledge-import-queue">{queue.map(item => <li key={item.id}>
                <span aria-live="polite">{item.file.name}{item.parser === 'mineru' && ' · MinerU 云解析'} · {{ queued: item.mineruTicket && item.text === undefined ? '可继续查询' : '等待导入', working: item.progress || '处理中', done: '已完成', error: '失败' }[item.state]} {item.text !== undefined && `· ${item.text.length} 字符`} {item.error}</span>
                {Boolean(item.warnings?.length) && <p>{item.warnings?.join('；')}</p>}
                <div className="knowledge-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => setQueue(previous => previous.filter(row => row.id !== item.id))}>移除此项</button>{item.state === 'error' && <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={() => { item.state = 'queued'; item.error = undefined; setQueue([...queue]); }}>重试此项</button>}</div>
              </li>)}</ul>
              <div className="knowledge-actions knowledge-queue-toolbar">
                {queue.some(item => item.state === 'done') && <button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => setQueue(previous => previous.filter(item => item.state !== 'done'))}>清除已完成</button>}
                <button type="button" className="button ghost" disabled={Boolean(busy)} onClick={() => setQueue([])}>清空队列</button>
                {busy === 'batch' && <button type="button" className="button secondary" onClick={() => { stopQueue.current = true; }}>停止后续导入（等待当前请求完成）</button>}
              </div>
            </>}
          </div>
          <div className="knowledge-actions knowledge-dialog-actions">
            <button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeDialog}>取消</button>
            <button type="button" className="button primary" disabled={Boolean(busy) || !queue.some(item => item.state === 'queued')} onClick={startQueue}>{busy === 'batch' ? '正在导入队列…' : '开始 / 继续导入'}</button>
          </div>
        </> : <>
          <label>资料标题<input value={draft.title} maxLength={titleLimit} onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} disabled={Boolean(busy)} required placeholder="例如：园区入驻政策与租金标准" /></label>
          <label>正文<textarea rows={6} maxLength={KNOWLEDGE_TEXT_LIMIT} value={draft.text} onChange={event => setDraft(previous => ({ ...previous, text: event.target.value }))} disabled={Boolean(busy)} required placeholder="粘贴政策、话术或说明正文" /><small>{draft.text.length.toLocaleString()} / {KNOWLEDGE_TEXT_LIMIT.toLocaleString()} 字符</small></label>
          {draft.warnings.map(warning => <p key={warning} className="knowledge-feedback"><CircleAlert size={16} />{warning}</p>)}
          {hasEmbedding && <label className="knowledge-index-option"><input type="checkbox" checked={rebuildIndex} onChange={event => setRebuildIndex(event.target.checked)} disabled={Boolean(busy)} />建立向量索引（关闭后使用全文检索）</label>}
          <KnowledgeChunkControls value={config} onChange={setConfig} disabled={Boolean(busy)} />
          <div className="knowledge-actions knowledge-dialog-actions"><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={closeDialog}>取消</button><button className="button primary" disabled={Boolean(busy) || !draft.title.trim() || !draft.text.trim()}>{busy === 'upload' ? '正在导入…' : '导入资料'}</button></div>
        </>}
      </form>}
      {dialog.kind === 'preview' && <div className="knowledge-preview"><p className="knowledge-dialog-description">{dialog.document.title} · {strategies[dialog.document.strategy].name} · {dialog.document.chunkCount} 个可检索切片</p>
        {busy === 'preview' ? <p className="knowledge-feedback" role="status"><Loader2 size={17} className="spin" />正在读取切片…</p> : chunks.length ? chunks.slice(previewPage * previewPageSize, (previewPage + 1) * previewPageSize).map((chunk, index) => <details key={chunk.id} open={index === 0 || undefined}><summary><ChevronRight size={16} /><span>切片 {chunk.ordinal} · {chunkLabels[chunk.kind]}{chunk.heading ? ' · ' + chunk.heading : ''}{chunk.parentOrdinal !== null ? ' · 父块 ' + chunk.parentOrdinal : ''}</span></summary><p>{chunk.text}</p></details>) : !dialogError && <p>暂无可预览切片。</p>}
        {chunks.length > previewPageSize && <nav className="knowledge-actions" aria-label="切片分页"><button type="button" className="button secondary" disabled={previewPage === 0} onClick={() => setPreviewPage(page => page - 1)}>上一页</button><span>第 {previewPage + 1} / {Math.ceil(chunks.length / previewPageSize)} 页</span><button type="button" className="button secondary" disabled={(previewPage + 1) * previewPageSize >= chunks.length} onClick={() => setPreviewPage(page => page + 1)}>下一页</button></nav>}
      </div>}
      {(dialog.kind === 'settings' || dialog.kind === 'rechunk') && <div className="knowledge-form">
        {dialog.kind === 'settings' && <label>所属部门<select value={departmentId} onChange={event => setDepartmentId(event.target.value)}><option value="shared">全部门共享</option>{KNOWLEDGE_DEPARTMENTS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}<option value="unassigned">待分配</option></select></label>}
        {dialog.kind === 'rechunk' && <><p>当前生效：{dialog.document.appliedConfig ? describeKnowledgeChunkConfig(dialog.document.appliedConfig) : '旧版资料参数未知'}</p><p>成功激活前，旧内容及检索仍可用。</p>{!dialog.document.sourceAvailable && <label>旧资料缺少精确原文，请补充原始正文<input type="file" accept={KNOWLEDGE_UPLOAD_ACCEPT} disabled={Boolean(busy)} onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void run('parse-original', async () => { const { importKnowledgeFile } = await import('../lib/knowledge-library-import'); const parsed = await importKnowledgeFile(file); setSourceText(parsed.text); setProposed(null); }, true); }} /><textarea value={sourceText} onChange={event => { setSourceText(event.target.value); setProposed(null); }} /></label>}</>}
        {hasEmbedding && dialog.kind === 'rechunk' && <label className="knowledge-index-option"><input type="checkbox" checked={rebuildIndex} onChange={event => setRebuildIndex(event.target.checked)} disabled={Boolean(busy)} />建立向量索引（关闭后使用全文检索）</label>}
        {dialog.kind === 'rechunk' && rechunkProgress?.document.id === dialog.document.id && <p role="status">重新切块：{rechunkProgress.job.status} · {rechunkProgress.job.indexedCount} / {rechunkProgress.job.chunkCount}</p>}
        {dialog.kind === 'rechunk' && rechunkNotice && <p role="status">{rechunkNotice}</p>}
        {busy === 'rechunk' && <button className="button secondary" onClick={() => { pauseRechunk.current = true; }}>暂停后续批次（等待当前请求完成）</button>}
        <KnowledgeChunkControls value={config} onChange={value => { setConfig(value); setProposed(null); }} disabled={Boolean(busy)} />
        {proposed != null && <div className="knowledge-preview"><p>预览结果（尚未生效）</p><p>共 {proposed.totalChunks} 块 · 可检索 {proposed.searchableChunks} 块 · 父块 {proposed.parentChunks} 块</p>{proposed.samples.map((sample, index) => <details key={index} open={index === 0}><summary>样例 {index + 1} · {chunkLabels[sample.kind]}{sample.heading ? ' · ' + sample.heading : ''}</summary><p>{sample.text}</p></details>)}</div>}
        {dialog.kind === 'settings' ? <button className="button primary" disabled={Boolean(busy)} onClick={() => void run('settings', async signal => {
          if (!current) return;
          let saved = current;
          const acceptLibrary = (library: KnowledgeLibrary) => { saved = library; setSnapshot(previous => previous && { ...previous, libraries: previous.libraries.map(item => item.id === library.id ? library : item) }); };
          if (departmentId !== (saved.departmentId || 'unassigned')) {
            const result = await request<{ library: KnowledgeLibrary }>(signal, { action: 'saveLibraryDepartment', libraryId: saved.id, version: saved.version, departmentId }); acceptLibrary(result.library);
          }
          if (JSON.stringify(config) !== JSON.stringify(saved.defaultConfig || DEFAULT_KNOWLEDGE_CHUNK_CONFIG)) {
            const result = await request<{ library: KnowledgeLibrary }>(signal, { action: 'saveLibraryChunking', libraryId: saved.id, version: saved.version, config }); acceptLibrary(result.library);
          }
          setDialog(null);
        }, true)}>保存库默认值</button> : <>
          <button className="button secondary" disabled={Boolean(busy) || (!dialog.document.sourceAvailable && !sourceText.trim())} onClick={() => void run('preview-config', async signal => { const result = await request<{ preview: KnowledgeChunkPreview }>(signal, { action: 'previewChunking', documentId: dialog.document.id, version: dialog.document.contentVersion, config, ...(sourceText ? { text: sourceText } : {}) }); setProposed(result.preview); }, true)}>预览拟用切块</button>
          <button className="button primary" disabled={Boolean(busy) || !proposed} onClick={() => void run('rechunk', async signal => {
            pauseRechunk.current = false;
            setRechunkNotice('');
            const result = await request<RechunkResult>(signal, { action: 'beginRechunk', documentId: dialog.document.id, version: dialog.document.contentVersion, config, requestId: requestIdentity.current({ action: 'beginRechunk', documentId: dialog.document.id, version: dialog.document.contentVersion, config, text: sourceText, rebuildIndex }), rebuildIndex, ...(sourceText ? { text: sourceText } : {}) });
            const next = await continueRechunk(result, signal);
            if (next.reason === 'completed') { setSourceText(''); setDialog(null); }
          }, true)}>确认重新切块</button>
        </>}
      </div>}
      {dialog.kind === 'remove' && <div className="knowledge-form"><p className="knowledge-dialog-description">删除「{dialog.document.title}」后，正文、切片及索引都会移除。这项操作无法撤销。</p><div className="knowledge-actions knowledge-dialog-actions"><button className="button secondary" data-dialog-initial-focus disabled={Boolean(busy)} onClick={closeDialog}>保留资料</button><button className="button danger" disabled={Boolean(busy)} onClick={() => removeDocument(dialog.document)}>{busy === 'remove' ? '正在删除…' : '确认删除'}</button></div></div>}
    </Overlay>}
  </div>;
}
