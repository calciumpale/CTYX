'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, CalendarDays, CalendarPlus, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, ListTodo, Loader2, MapPin, Plus, RefreshCw, Send, Sparkles, Trash2, Undo2, Users, X } from 'lucide-react';
import type { MemberSession } from '../lib/member-types';
import type { View, WorkbenchState } from '../lib/types';
import type { ScheduleAction, ScheduleDraft, ScheduleItem, ScheduleKind, ScheduleList, ScheduleSuggestion, ScheduleUnscheduledPage } from '../lib/schedule-types';
import { addCalendarDays, addCalendarMonths, calendarDateLabel, calendarRange, intervalLabel, occursOnDate, shanghaiDate, shanghaiInstant, shanghaiTime, type CalendarMode } from '../lib/schedule-calendar';
import './schedule-workspace.css';

type Props = { state: WorkbenchState; member: MemberSession; notify: (message: string) => void; onNavigate: (view: View, id?: string) => void; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void };
type Panel = 'editor' | 'assistant' | 'unscheduled' | null;
type EditValues = { kind: ScheduleKind; title: string; date: string; startTime: string; endDate: string; endTime: string; allDay: boolean; unscheduled: boolean; dealId: string; location: string; notes: string };
type Editor = { item: ScheduleItem | null; values: EditValues; baseline: string; requestId: string; sourceIndex: number | null };
const KINDS: ScheduleKind[] = ['task', 'event', 'visit'];
const KIND: Record<ScheduleKind, string> = { task: '任务', event: '日程', visit: '拜访' };
const ICON = { task: ListTodo, event: CalendarDays, visit: MapPin };
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const statusLabel = { pending: '待完成', completed: '已完成', cancelled: '已取消' };
const signature = (value: unknown) => JSON.stringify(value);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';
class ScheduleClientError extends Error { constructor(message: string, public status: number) { super(message); } }
async function body<T>(response: Response): Promise<T> {
  let value: T & { error?: string };
  try { value = await response.json() as T & { error?: string }; }
  catch { throw new ScheduleClientError('日程服务暂时没有响应，请重试。', response.status >= 400 ? response.status : 0); }
  if (!response.ok) throw new ScheduleClientError(value.error || '操作未完成，请重试。', response.status);
  return value;
}
async function action<T>(input: ScheduleAction): Promise<T> {
  return body<T>(await fetch('/api/schedules', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }));
}
function editorValues(draft: ScheduleDraft | null, day: string, kind: ScheduleKind = 'event'): EditValues {
  const date = draft?.startAt ? shanghaiDate(draft.startAt) : day;
  const endDate = draft?.endAt ? shanghaiDate(draft.endAt) : date;
  return { kind: draft?.kind ?? kind, title: draft?.title ?? '', date, startTime: draft?.startAt ? shanghaiTime(draft.startAt) : '09:00', endDate: draft?.allDay && draft.endAt ? addCalendarDays(endDate, -1) : endDate, endTime: draft?.endAt ? shanghaiTime(draft.endAt) : '10:00', allDay: draft?.allDay ?? false, unscheduled: Boolean(draft && !draft.startAt), dealId: draft?.dealId ?? '', location: draft?.location ?? '', notes: draft?.notes ?? '' };
}
function toDraft(values: EditValues): ScheduleDraft {
  if (!values.title.trim()) throw new Error('请填写标题。');
  if (values.kind === 'event' && values.unscheduled) throw new Error('请为日程设置时间。');
  const startAt = values.unscheduled ? null : shanghaiInstant(values.date, values.allDay ? '00:00' : values.startTime);
  const endAt = values.unscheduled ? null : shanghaiInstant(values.allDay ? addCalendarDays(values.endDate, 1) : values.endDate, values.allDay ? '00:00' : values.endTime);
  if (startAt && endAt && Date.parse(endAt) <= Date.parse(startAt)) throw new Error('结束时间需晚于开始时间。');
  return { kind: values.kind, title: values.title.trim(), startAt, endAt, allDay: !values.unscheduled && values.allDay, dealId: values.dealId || null, location: values.location.trim(), notes: values.notes.trim() };
}
function newEditor(draft: ScheduleDraft | null, day: string, item: ScheduleItem | null = null, sourceIndex: number | null = null, kind: ScheduleKind = 'event'): Editor {
  const values = editorValues(draft, day, kind);
  return { item, values, baseline: signature(values), requestId: crypto.randomUUID(), sourceIndex };
}
function scheduleSort(a: ScheduleItem, b: ScheduleItem): number { return (a.startAt || '').localeCompare(b.startAt || '') || a.title.localeCompare(b.title, 'zh-CN'); }

type UnscheduledState = { key: string; items: ScheduleItem[]; nextCursor?: string; pendingCount?: number; totalCount?: number; loaded: boolean; loading: boolean; error: string };
const emptyUnscheduled = (key: string): UnscheduledState => ({ key, items: [], loaded: false, loading: false, error: '' });
/** Independently paged categories cannot hide each other behind a shared result limit. */
function useUnscheduledPage(kind: 'task' | 'visit', scope: 'mine' | 'team', refresh: number, active: boolean) {
  const key = signature([kind, scope, refresh]);
  const [page, setPage] = useState<UnscheduledState>(() => emptyUnscheduled(key));
  const current = useRef(page);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const write = useCallback((next: UnscheduledState) => { current.current = next; setPage(next); }, []);
  const load = useCallback(async (more = false) => {
    const previous = current.current.key === key ? current.current : emptyUnscheduled(key);
    if (previous.loading || (more && !previous.nextCursor)) return;
    const cursor = more ? previous.nextCursor : undefined;
    const request = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    write({ ...previous, loading: true, error: '' });
    try {
      const params = new URLSearchParams({ unscheduled: kind, scope });
      if (cursor) params.set('cursor', cursor);
      const result = await body<ScheduleUnscheduledPage>(await fetch(`/api/schedules?${params}`, { signal: abort.signal, credentials: 'same-origin', cache: 'no-store' }));
      if (abort.signal.aborted || request !== generation.current) return;
      const items = cursor ? [...new Map([...previous.items, ...result.items].map(item => [item.id, item])).values()] : result.items;
      write({ key, ...result, items, loaded: true, loading: false, error: '' });
    } catch (error) {
      if (!abort.signal.aborted && request === generation.current) write({ ...previous, loading: false, error: errorMessage(error) });
    }
  }, [key, kind, scope, write]);
  useEffect(() => {
    generation.current += 1; controller.current?.abort(); current.current = emptyUnscheduled(key);
  }, [key]);
  useEffect(() => {
    if (active && (current.current.key !== key || (!current.current.loaded && !current.current.error))) void load();
  }, [active, key, load]);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, []);
  return { ...(page.key === key ? page : emptyUnscheduled(key)), retry: () => void load(page.loaded && Boolean(page.nextCursor)), more: () => void load(true) };
}

export function ScheduleWorkspace({ state, member, notify, onNavigate, onBusyChange, onDirtyChange }: Props) {
  const prefix = useId();
  const [today, setToday] = useState(() => shanghaiDate());
  const [anchor, setAnchor] = useState(() => shanghaiDate());
  const [mode, setMode] = useState<CalendarMode>('week');
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const [filters, setFilters] = useState<ScheduleKind[]>(KINDS);
  const [data, setData] = useState<ScheduleList | null>(null);
  const [todayItems, setTodayItems] = useState<ScheduleItem[] | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [listError, setListError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [panel, setPanel] = useState<Panel>(null);
  const [tasksOpen, setTasksOpen] = useState(false);
  const visitPage = useUnscheduledPage('visit', scope, refresh, panel === 'unscheduled');
  const taskPage = useUnscheduledPage('task', scope, refresh, tasksOpen);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [suggestion, setSuggestion] = useState<ScheduleSuggestion | null>(null);
  const [savedSuggestions, setSavedSuggestions] = useState<number[]>([]);
  const suggestionIds = useRef<Record<number, string>>({});
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [formError, setFormError] = useState('');
  const [uncertainCreate, setUncertainCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingChange, setPendingChange] = useState<(() => void) | null>(null);
  const [undo, setUndo] = useState<ScheduleItem | null>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const focusReturn = useRef<HTMLElement | null>(null);
  const modeChosen = useRef(false);
  const range = useMemo(() => calendarRange(anchor, mode), [anchor, mode]);
  const requestKey = signature([range.from, range.to, scope, today, refresh]);
  const loading = loadedKey !== requestKey;
  const currentData = !loading && !listError ? data : null;
  const editorDirty = Boolean(editor && signature(editor.values) !== editor.baseline);
  const unsavedSuggestions = Boolean(suggestion?.drafts.some((_, index) => !savedSuggestions.includes(index)));
  const dirty = editorDirty || Boolean(query.trim() && query !== submittedQuery) || unsavedSuggestions || uncertainCreate;
  const canEdit = !editor?.item || editor.item.canEdit;
  const editorDisabled = Boolean(busy) || !canEdit || uncertainCreate;
  const items = useMemo(() => (currentData?.items ?? []).filter(item => filters.includes(item.kind)).sort(scheduleSort), [currentData, filters]);
  const byDate = useMemo(() => new Map(range.days.map(day => [day, items.filter(item => occursOnDate(item, day))])), [range.days, items]);
  const pendingVisitCount = loading || listError || visitPage.loading || visitPage.error ? undefined : visitPage.loaded ? visitPage.pendingCount : currentData?.pendingVisitCount;
  const visitTotalCount = visitPage.loading || visitPage.error ? undefined : visitPage.loaded ? visitPage.totalCount : currentData?.unscheduledCounts?.visit;
  const taskTotalCount = taskPage.loading || taskPage.error ? undefined : taskPage.loaded ? taskPage.totalCount : currentData?.unscheduledCounts?.task;
  const counts = todayItems ? Object.fromEntries(KINDS.map(kind => [kind, todayItems.filter(item => item.kind === kind && item.status === 'pending').length])) : null;

  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => { if (!modeChosen.current) setMode(media.matches ? 'list' : 'week'); };
    update(); media.addEventListener('change', update);
    const refreshDay = () => setToday(shanghaiDate());
    const timer = window.setInterval(refreshDay, 30_000);
    window.addEventListener('focus', refreshDay);
    return () => { media.removeEventListener('change', update); window.clearInterval(timer); window.removeEventListener('focus', refreshDay); };
  }, []);
  useEffect(() => {
    if (member.role === 'admin') return;
    const controller = new AbortController();
    const inside = today >= range.from && today < range.to;
    const load = async () => {
      try {
        const [result, todayResult] = await Promise.all([
          fetch(`/api/schedules?${new URLSearchParams({ from: range.from, to: range.to, scope })}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' }).then(body<ScheduleList>),
          inside ? Promise.resolve(null) : fetch(`/api/schedules?${new URLSearchParams({ from: today, to: addCalendarDays(today, 1), scope })}`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store' }).then(body<ScheduleList>),
        ]);
        if (controller.signal.aborted) return;
        setData(result); setTodayItems((todayResult?.items ?? result.items).filter(item => occursOnDate(item, today))); setListError('');
      } catch (error) {
        if (!controller.signal.aborted) { setListError(errorMessage(error)); setTodayItems(null); }
      } finally { if (!controller.signal.aborted) setLoadedKey(requestKey); }
    };
    void load(); return () => controller.abort();
  }, [range.from, range.to, scope, today, requestKey, member.role]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => { const guard = (event: BeforeUnloadEvent) => { if (dirty || busyRef.current) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  useEffect(() => { if (panel) panelHeading.current?.focus(); }, [panel, editor?.requestId]);

  const start = (operation: string) => { if (busyRef.current) return false; busyRef.current = true; setBusy(operation); setFormError(''); return true; };
  const finish = () => { busyRef.current = false; setBusy(''); };
  const reload = () => setRefresh(value => value + 1);
  const guardEditor = (change: () => void) => { if (busyRef.current) return; if (editorDirty || uncertainCreate) { setPendingChange(() => change); return; } change(); };
  const openPanel = (next: Panel) => { focusReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setPanel(next); setFormError(''); setConfirmDelete(false); };
  const closePanel = () => guardEditor(() => { setPanel(null); setEditor(null); setUncertainCreate(false); setFormError(''); setConfirmDelete(false); focusReturn.current?.focus(); });
  const openNew = (day = anchor, kind: ScheduleKind = 'event') => guardEditor(() => { setEditor(newEditor(null, day, null, null, kind)); setUncertainCreate(false); openPanel('editor'); window.setTimeout(() => titleInput.current?.focus(), 0); });
  const openItem = (item: ScheduleItem) => guardEditor(() => { setEditor(newEditor(item, anchor, item)); setUncertainCreate(false); openPanel('editor'); });
  const openSuggestion = (draft: ScheduleDraft, index: number) => guardEditor(() => {
    const next = newEditor(draft, today, null, index);
    next.requestId = suggestionIds.current[index] ?? (suggestionIds.current[index] = crypto.randomUUID());
    // An unsaved generated draft remains protected even before it is edited.
    setEditor(next); setUncertainCreate(false); openPanel('editor');
  });
  const update = <K extends keyof EditValues>(key: K, value: EditValues[K]) => { setEditor(previous => previous ? { ...previous, values: { ...previous.values, [key]: value } } : previous); setFormError(''); };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!editor || !canEdit) return;
    let draft: ScheduleDraft;
    try { draft = toDraft(editor.values); } catch (error) { setFormError(errorMessage(error)); return; }
    if (!start('save')) return;
    try {
      const result = await action<{ item: ScheduleItem }>(editor.item ? { action: 'update', id: editor.item.id, version: editor.item.version, draft } : { action: 'create', requestId: editor.requestId, draft });
      setUncertainCreate(false);
      if (editor.sourceIndex !== null) {
        setSavedSuggestions(previous => [...previous, editor.sourceIndex!]); setEditor(null); setPanel('assistant');
      } else {
        setEditor(newEditor(result.item, anchor, result.item));
      }
      reload(); notify(editor.item ? '日程已更新' : `${KIND[result.item.kind]}已创建`);
    } catch (error) {
      const uncertain = !editor.item && (!(error instanceof ScheduleClientError) || error.status === 0 || error.status >= 500);
      setUncertainCreate(uncertain);
      setFormError(`${errorMessage(error)}${uncertain ? ' 保存结果尚未确认，内容已锁定；重试会核对同一次保存。' : ''}${error instanceof ScheduleClientError && error.status === 409 && editor.item ? ' 请先重新读取记录，再编辑；当前草稿仍保留。' : ''}`);
    } finally { finish(); }
  };
  const changeStatus = async () => {
    const item = editor?.item;
    if (!item?.canEdit || !start('status')) return;
    try {
      const result = await action<{ item: ScheduleItem }>({ action: 'status', id: item.id, version: item.version, status: item.status === 'completed' ? 'pending' : 'completed' });
      setEditor(previous => previous ? { ...previous, item: result.item } : previous); reload(); notify(result.item.status === 'completed' ? '已标记完成' : '已恢复为待完成');
    } catch (error) { setFormError(errorMessage(error)); } finally { finish(); }
  };
  const deleteItem = async () => {
    const item = editor?.item;
    if (!item?.canEdit || !start('delete')) return;
    try { const result = await action<{ item: ScheduleItem }>({ action: 'delete', id: item.id, version: item.version }); setUndo(result.item); setEditor(null); setPanel(null); setConfirmDelete(false); reload(); notify('记录已删除，可撤销'); }
    catch (error) { setFormError(errorMessage(error)); } finally { finish(); }
  };
  const restoreItem = async () => {
    if (!undo || !start('restore')) return;
    try { await action<{ item: ScheduleItem }>({ action: 'restore', id: undo.id, version: undo.version }); setUndo(null); reload(); notify('记录已恢复'); }
    catch (error) { setFormError(errorMessage(error)); } finally { finish(); }
  };
  const suggest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!query.trim() || !start('suggest')) return;
    const sent = query.trim();
    try {
      const result = await action<ScheduleSuggestion>({ action: 'suggest', query: sent, anchorDate: shanghaiDate() });
      setSuggestion(result); setSavedSuggestions([]); suggestionIds.current = {}; setSubmittedQuery(query);
    } catch (error) { setFormError(errorMessage(error)); }
    finally { finish(); }
  };
  const navigateRange = (direction: number) => setAnchor(previous => mode === 'month' ? addCalendarMonths(previous, direction) : addCalendarDays(previous, direction * 7));
  const resetEditorFromCurrent = () => {
    if (!editor?.item) return;
    const selected = editor.item;
    guardEditor(() => {
      const load = async () => {
        if (!start('reread')) return;
        try {
          const { item: latest } = await body<{ item: ScheduleItem }>(await fetch(`/api/schedules?${new URLSearchParams({ id: selected.id, scope })}`, { credentials: 'same-origin', cache: 'no-store' }));
          setEditor(newEditor(latest, anchor, latest)); setUncertainCreate(false); setFormError(''); reload();
        } catch (error) { setFormError(errorMessage(error)); } finally { finish(); }
      };
      void load();
    });
  };
  const itemCard = (item: ScheduleItem, day?: string, compact = false) => {
    const Icon = ICON[item.kind];
    return <button type="button" key={item.id} className={`schedule-item ${compact ? 'schedule-item-compact' : ''} ${item.status !== 'pending' ? 'schedule-item-inactive' : ''}`} onClick={() => openItem(item)} aria-label={`${item.title}，${KIND[item.kind]}，${intervalLabel(item, day)}，${statusLabel[item.status]}`}>
      <span className="schedule-item-meta"><Icon size={13} /><span>{intervalLabel(item, day)}</span>{item.status === 'completed' && <Check size={13} aria-label="已完成" />}{item.status === 'cancelled' && <span>已取消</span>}</span>
      <strong>{item.title}</strong>
      {!compact && <span className="schedule-item-foot"><span>{KIND[item.kind]}{scope === 'team' ? ` · ${item.ownerName}` : ''}</span>{item.dealId && <span>关联项目</span>}</span>}
    </button>;
  };

  if (member.role === 'admin') return <section className="schedule-workspace"><h1>日程</h1><p>此功能仅对销售人员与销售管理者开放。</p></section>;
  return <section className={`schedule-workspace ${panel ? 'schedule-with-panel' : ''}`} aria-labelledby={`${prefix}-title`}>
    <header className="schedule-heading"><div><h1 id={`${prefix}-title`}>日程</h1><p className="schedule-summary">{mode === 'month' ? `${anchor.slice(0, 4)}年${Number(anchor.slice(5, 7))}月` : `${calendarDateLabel(range.from, true)} — ${calendarDateLabel(addCalendarDays(range.to, -1))}`}<span className="schedule-summary-counts">今天 {loading || !counts ? '—' : counts.task} 个待办任务 · {loading || !counts ? '—' : counts.event} 场日程 · {loading || !counts ? '—' : counts.visit} 条拜访计划</span></p></div>
      <div className="schedule-heading-actions">{member.role === 'manager' && <button type="button" className="schedule-button" onClick={() => onNavigate('reports')}>销售日报<ArrowRight size={15} /></button>}<button type="button" className="schedule-button" aria-expanded={panel === 'unscheduled'} onClick={() => guardEditor(() => { setEditor(null); openPanel(panel === 'unscheduled' ? null : 'unscheduled'); })}><CalendarPlus size={16} /><span>待安排拜访</span><span className="schedule-count">{pendingVisitCount ?? '—'}</span></button><button type="button" className="schedule-button schedule-primary" disabled={Boolean(busy)} onClick={() => openNew()}><Plus size={17} />新建</button></div>
    </header>

    {pendingChange && <div className="schedule-inline-confirm" role="alert"><div><strong>放弃尚未保存的内容？</strong><p>当前修改尚未保存，继续操作会丢弃这些内容。</p></div><div className="schedule-actions"><button className="schedule-button" type="button" autoFocus onClick={() => { setPendingChange(null); if (panel === 'editor') titleInput.current?.focus(); else panelHeading.current?.focus(); }}>继续编辑</button><button className="schedule-button schedule-danger" type="button" onClick={() => { const next = pendingChange; setPendingChange(null); setUncertainCreate(false); next(); }}>放弃更改</button></div></div>}
    {undo && <div className="schedule-feedback" role="status"><span>已删除“{undo.title}”</span><button className="schedule-text-button" type="button" disabled={Boolean(busy)} onClick={() => void restoreItem()}><Undo2 size={14} />撤销</button><button type="button" className="schedule-icon-button" aria-label="关闭撤销提示" onClick={() => setUndo(null)}><X size={15} /></button></div>}
    {formError && panel !== 'editor' && panel !== 'assistant' && <div className="schedule-error" role="alert"><AlertCircle size={16} /><span>{formError}</span></div>}

    <div className="schedule-body"><div className="schedule-main">
      <div className="schedule-toolbar">
        <div className="schedule-toolbar-left">
          <div className="schedule-range-nav"><button type="button" className="schedule-icon-button" aria-label={mode === 'month' ? '上个月' : '上一周'} onClick={() => navigateRange(-1)}><ChevronLeft size={17} /></button><button type="button" className="schedule-button schedule-today" onClick={() => setAnchor(today)}>今天</button><button type="button" className="schedule-icon-button" aria-label={mode === 'month' ? '下个月' : '下一周'} onClick={() => navigateRange(1)}><ChevronRight size={17} /></button><label className="schedule-jump"><span className="sr-only">跳转日期</span><input aria-label="跳转日期" type="date" value={anchor} onChange={event => { if (event.target.value) setAnchor(event.target.value); }} /></label></div>
          <span className="schedule-toolbar-divider" aria-hidden="true" />
          <div className="schedule-type-filters" aria-label="类型筛选">{KINDS.map(kind => { const Icon = ICON[kind]; const active = filters.includes(kind); return <button type="button" key={kind} className={`schedule-button schedule-filter ${active ? 'is-active' : ''}`} aria-pressed={active} onClick={() => setFilters(previous => active ? previous.filter(value => value !== kind) : [...previous, kind])}><Icon size={15} />{KIND[kind]}{active && <Check size={13} />}</button>; })}</div>
        </div>
        <div className="schedule-toolbar-right"><button type="button" className="schedule-button schedule-assistant-button" aria-expanded={panel === 'assistant'} onClick={() => guardEditor(() => { setEditor(null); openPanel(panel === 'assistant' ? null : 'assistant'); })}><Sparkles size={15} /><span>AI 日程助手</span></button>{member.role === 'manager' && <label className="schedule-scope"><Users size={15} /><span className="sr-only">日程范围</span><select aria-label="日程范围" value={scope} disabled={Boolean(busy)} onChange={event => setScope(event.target.value as 'mine' | 'team')}><option value="mine">我的日程</option><option value="team">团队日程</option></select></label>}<div className="schedule-view-switch" aria-label="日历视图">{(['week', 'month', 'list'] as const).map(value => <button type="button" className={mode === value ? 'is-active' : ''} key={value} aria-pressed={mode === value} onClick={() => { modeChosen.current = true; setMode(value); }}>{({ week: '周', month: '月', list: '列表' })[value]}</button>)}</div></div>
      </div>

      {loading ? <div className="schedule-loading" role="status"><Loader2 size={20} className="spin" /><span>正在读取日程…</span></div> : listError ? <div className="schedule-empty schedule-load-error" role="alert"><AlertCircle size={26} /><h2>日程未能加载</h2><p>{listError}</p><button type="button" className="schedule-button" onClick={reload}><RefreshCw size={15} />重新加载</button></div> : <>
        {currentData?.scheduledTruncated && <div className="schedule-feedback" role="status">记录较多，仅展示部分结果。请切换周视图缩小日期范围。</div>}
        {mode === 'list' ? <div className="schedule-list">{items.length ? range.days.filter(day => (byDate.get(day)?.length ?? 0) > 0).map(day => <section className="schedule-list-day" key={day}><h2>{calendarDateLabel(day)} <span>{WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]}{day === today ? ' · 今天' : ''}</span><button type="button" className="schedule-icon-button" aria-label={`在${calendarDateLabel(day)}新建`} onClick={() => openNew(day)}><Plus size={15} /></button></h2><div>{byDate.get(day)?.map(item => itemCard(item, day))}</div></section>) : <div className="schedule-empty"><CalendarDays size={26} /><h2>{filters.length ? '这周暂无日程' : '请选择要查看的类型'}</h2><p>{filters.length ? '新建任务、日程或拜访，开始安排本周工作。' : '使用上方类型筛选查看任务、日程和拜访。'}</p>{filters.length > 0 && <button type="button" className="schedule-button" onClick={() => openNew()}><Plus size={15} />新建日程</button>}</div>}</div> : <div className="schedule-calendar-scroll" role="region" aria-label={`${mode === 'month' ? '月' : '周'}日历，可横向滚动`} tabIndex={0}>
          <div className={`schedule-calendar schedule-calendar-${mode}`}><div className="schedule-day-headings">{mode === 'week' && <div className="schedule-time-corner" aria-hidden="true">GMT+8</div>}{(mode === 'month' ? WEEKDAYS : range.days).map((value, index) => { const day = mode === 'week' ? value : null; return <div key={value} className={day === today ? 'is-today' : ''}><span>{WEEKDAYS[index]}</span>{day && <strong>{Number(day.slice(8))}{day === today && <small>今天</small>}</strong>}</div>; })}</div>
            <div className="schedule-calendar-cells">{mode === 'week' && <div className="schedule-time-axis" aria-hidden="true">{['09:00', '11:00', '13:00', '15:00', '17:00', '19:00'].map(slot => <span key={slot}>{slot}</span>)}</div>}{range.days.map(day => { const entries = byDate.get(day) ?? []; const month = mode === 'month'; return <section key={day} className={`schedule-day ${day === today ? 'is-today' : ''} ${month && day.slice(0, 7) !== anchor.slice(0, 7) ? 'is-outside' : ''}`} aria-label={calendarDateLabel(day, true)}>{!month && day === today && <span className="schedule-now-line" aria-hidden="true"><i /></span>}{month && <div className="schedule-month-day"><span>{Number(day.slice(8))}</span>{day === today && <small>今天</small>}<button type="button" className="schedule-icon-button" aria-label={`在${calendarDateLabel(day)}新建`} onClick={() => openNew(day)}><Plus size={13} /></button></div>}<div className="schedule-day-items">{entries.slice(0, month ? 3 : entries.length).map(item => itemCard(item, day, month))}{month && entries.length > 3 && <button type="button" className="schedule-more" onClick={() => { setAnchor(day); setMode('list'); modeChosen.current = true; }}>还有 {entries.length - 3} 项</button>}</div>{!month && <button type="button" className="schedule-add-day" onClick={() => openNew(day)} aria-label={`在${calendarDateLabel(day)}新建`}><Plus size={14} /><span>新建</span></button>}</section>; })}</div>
          </div>
        </div>}
        {((currentData?.unscheduledCounts?.task ?? 0) > 0 || tasksOpen) && <details className="schedule-unscheduled-tasks" open={tasksOpen} onToggle={event => setTasksOpen(event.currentTarget.open)}><summary>未安排时间的任务 · {taskTotalCount ?? '—'}</summary><div className="schedule-unscheduled-list">{taskPage.items.map(item => itemCard(item))}{taskPage.loading && <p role="status">正在读取任务…</p>}{taskPage.error && <div className="schedule-error" role="alert"><span>{taskPage.error}</span><button className="schedule-text-button" type="button" onClick={taskPage.retry}>重试</button></div>}{!taskPage.loading && !taskPage.error && taskPage.loaded && taskPage.items.length === 0 && <p>暂无未安排时间的任务</p>}{taskPage.nextCursor && <button className="schedule-button" type="button" disabled={taskPage.loading} onClick={taskPage.more}>{taskPage.loading ? '正在读取…' : '加载更多任务'}</button>}</div></details>}
      </>}
      <footer className="schedule-footer"><span>{!loading && !listError && !items.length ? `${filters.length ? '当前范围暂无安排' : '请选择查看类型'} · ` : ''}北京时间 · Asia/Shanghai{scope === 'team' ? ' · 团队成员记录仅可查看' : ''}</span></footer>
    </div>

    {panel && <aside className="schedule-panel" aria-labelledby={`${prefix}-panel-title`} onKeyDown={event => { if (event.key === 'Escape' && !busyRef.current) { event.stopPropagation(); closePanel(); } }}><div className="schedule-panel-heading"><h2 id={`${prefix}-panel-title`} ref={panelHeading} tabIndex={-1}>{panel === 'assistant' ? <><Sparkles size={17} />AI 日程助手</> : panel === 'unscheduled' ? <>待安排拜访<span className="schedule-count">{visitTotalCount ?? '—'}</span></> : editor?.item ? `${KIND[editor.values.kind]}详情` : '新建安排'}</h2><button type="button" className="schedule-icon-button" disabled={Boolean(busy)} aria-label="关闭详情面板" onClick={closePanel}><X size={18} /></button></div>
      {panel === 'unscheduled' && <div className="schedule-panel-content"><p className="schedule-panel-caption">选择一条拜访，补充时间后保存。</p><div className="schedule-unscheduled-list">{visitPage.items.map(item => itemCard(item))}{visitPage.loading && <p role="status">正在读取拜访…</p>}{visitPage.error && <div className="schedule-error" role="alert"><span>{visitPage.error}</span><button className="schedule-text-button" type="button" onClick={visitPage.retry}>重试</button></div>}{visitPage.nextCursor && <button className="schedule-button" type="button" disabled={visitPage.loading} onClick={visitPage.more}>{visitPage.loading ? '正在读取…' : '加载更多拜访'}</button>}</div>{!visitPage.loading && !visitPage.error && visitPage.loaded && visitPage.items.length === 0 && <div className="schedule-panel-empty"><CalendarPlus size={24} /><p>暂无待安排拜访</p><button className="schedule-button" type="button" onClick={() => openNew(anchor, 'visit')}><Plus size={15} />新建拜访</button></div>}</div>}
      {panel === 'assistant' && <div className="schedule-panel-content"><form className="schedule-ai-form" onSubmit={event => { if (unsavedSuggestions) { event.preventDefault(); setPendingChange(() => () => { setSuggestion(null); setEditor(null); void suggest(event); }); } else void suggest(event); }}><label htmlFor={`${prefix}-query`}>想安排什么？</label><textarea id={`${prefix}-query`} value={query} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} rows={4} maxLength={4000} placeholder="例如：明天下午 2 点拜访客户，留出 1 小时准备方案" /><div className="schedule-ai-form-footer"><span>时间基准：{calendarDateLabel(today)}，北京时间</span><button className="schedule-button schedule-primary" type="submit" disabled={Boolean(busy) || !query.trim()}>{busy === 'suggest' ? <Loader2 size={15} className="spin" /> : <Send size={15} />}{busy === 'suggest' ? '正在安排…' : '生成建议'}</button></div></form><p className="schedule-panel-caption">建议生成后，逐条编辑确认并保存。</p>{formError && <div className="schedule-error" role="alert"><AlertCircle size={16} /><span>{formError}</span></div>}{suggestion && <section className="schedule-suggestions"><h3>安排建议</h3>{suggestion.message && <p className="schedule-suggestion-message">{suggestion.message}</p>}{suggestion.warnings.length > 0 && <ul className="schedule-warnings">{suggestion.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}{suggestion.drafts.map((draft, index) => <article key={index}><div className="schedule-suggestion-meta"><span>{KIND[draft.kind]}</span>{savedSuggestions.includes(index) && <span className="schedule-success"><CheckCircle2 size={13} />已保存</span>}</div><h4>{draft.title}</h4><p>{draft.startAt ? `${calendarDateLabel(shanghaiDate(draft.startAt))} · ` : ''}{intervalLabel(draft)}</p>{draft.location && <p><MapPin size={13} />{draft.location}</p>}<button type="button" className="schedule-button" disabled={Boolean(busy) || savedSuggestions.includes(index)} onClick={() => openSuggestion(draft, index)}>{savedSuggestions.includes(index) ? <Check size={14} /> : null}{savedSuggestions.includes(index) ? '已保存' : '编辑并保存'}</button></article>)}</section>}</div>}
      {panel === 'editor' && editor && <form className="schedule-editor" onSubmit={event => void save(event)}><div className="schedule-panel-content">
        {editor.sourceIndex !== null && <div className="schedule-feedback">AI 建议 · 尚未保存</div>}{editor.item && <div className="schedule-record-meta"><span>{statusLabel[editor.item.status]}</span><span>{editor.item.ownerName}{!editor.item.canEdit ? ' · 仅可查看' : ''}</span></div>}
        {formError && <div className="schedule-error" role="alert"><AlertCircle size={16} /><span>{formError}</span></div>}
        <label className="schedule-field">标题<input ref={titleInput} value={editor.values.title} maxLength={120} required disabled={editorDisabled} onChange={event => update('title', event.target.value)} placeholder="例如：园区二期选址方案沟通" /></label>
        <div className="schedule-form-row">
          <label className="schedule-field">类型<select value={editor.values.kind} disabled={editorDisabled} onChange={event => { const kind = event.target.value as ScheduleKind; setEditor(previous => previous ? { ...previous, values: { ...previous.values, kind, unscheduled: kind === 'event' ? false : previous.values.unscheduled } } : previous); }}><option value="task">任务</option><option value="event">日程</option><option value="visit">拜访</option></select></label>
          <label className="schedule-field">关联项目<span className="schedule-optional">可选</span><select value={editor.values.dealId} disabled={editorDisabled} onChange={event => update('dealId', event.target.value)}><option value="">不关联项目</option>{editor.values.dealId && !state.deals.some(deal => deal.id === editor.values.dealId) && <option value={editor.values.dealId}>已关联项目（当前不可访问）</option>}{state.deals.map(deal => <option value={deal.id} key={deal.id}>{deal.projectName || deal.name}</option>)}</select></label>
        </div>
        {editor.values.dealId && state.deals.some(deal => deal.id === editor.values.dealId) && <button className="schedule-text-button schedule-project-link" type="button" disabled={Boolean(busy)} onClick={() => onNavigate('deals', editor.values.dealId)}>打开关联项目<ArrowRight size={13} /></button>}
        <div className="schedule-check-row">
          {editor.values.kind !== 'event' && <label className="schedule-check"><input type="checkbox" checked={editor.values.unscheduled} disabled={editorDisabled} onChange={event => update('unscheduled', event.target.checked)} />暂不安排时间</label>}
          {!editor.values.unscheduled && <label className="schedule-check"><input type="checkbox" checked={editor.values.allDay} disabled={editorDisabled} onChange={event => update('allDay', event.target.checked)} />全天安排</label>}
        </div>
        {!editor.values.unscheduled && <><div className="schedule-form-row"><label className="schedule-field">开始日期<input type="date" value={editor.values.date} required disabled={editorDisabled} onChange={event => { const date = event.target.value; setEditor(previous => previous ? { ...previous, values: { ...previous.values, date, endDate: previous.values.endDate < date ? date : previous.values.endDate } } : previous); }} /></label>{!editor.values.allDay && <label className="schedule-field">开始时间<input type="time" value={editor.values.startTime} required disabled={editorDisabled} onChange={event => update('startTime', event.target.value)} /></label>}</div><div className="schedule-form-row"><label className="schedule-field">{editor.values.allDay ? '最后一天' : '结束日期'}<input type="date" value={editor.values.endDate} min={editor.values.date} required disabled={editorDisabled} onChange={event => update('endDate', event.target.value)} /></label>{!editor.values.allDay && <label className="schedule-field">结束时间<input type="time" value={editor.values.endTime} required disabled={editorDisabled} onChange={event => update('endTime', event.target.value)} /></label>}</div><p className="schedule-field-hint"><Clock3 size={12} />以上均为北京时间</p></>}
        <label className="schedule-field">地点<span className="schedule-optional">可选</span><input value={editor.values.location} maxLength={300} disabled={editorDisabled} onChange={event => update('location', event.target.value)} placeholder="地址或线上会议链接" /></label>
        <label className="schedule-field">备注<span className="schedule-optional">可选</span><textarea value={editor.values.notes} rows={2} maxLength={4000} disabled={editorDisabled} onChange={event => update('notes', event.target.value)} placeholder="补充沟通重点或需准备的材料" /></label>
        {editor.item?.canEdit && <div className="schedule-record-actions"><button type="button" className="schedule-button" disabled={Boolean(busy) || editorDirty} onClick={() => void changeStatus()}>{editor.item.status === 'completed' ? <Undo2 size={14} /> : <CheckCircle2 size={14} />}{editor.item.status === 'completed' ? '恢复待完成' : '标记完成'}</button><button type="button" className="schedule-text-button schedule-danger-text" disabled={Boolean(busy)} onClick={() => setConfirmDelete(true)}><Trash2 size={14} />删除</button></div>}
        {confirmDelete && <div className="schedule-delete-confirm" role="alert"><p>删除“{editor.item?.title}”？删除后可撤销。</p><div className="schedule-actions"><button type="button" className="schedule-button" disabled={Boolean(busy)} onClick={() => setConfirmDelete(false)}>保留</button><button type="button" className="schedule-button schedule-danger" disabled={Boolean(busy)} onClick={() => void deleteItem()}>{busy === 'delete' ? '正在删除…' : '确认删除'}</button></div></div>}
      </div><div className="schedule-editor-footer">{editor.item && <button type="button" className="schedule-text-button" disabled={Boolean(busy) || loading} onClick={resetEditorFromCurrent}>重新读取</button>}{editor.sourceIndex !== null ? <button className="schedule-button" type="button" disabled={Boolean(busy)} onClick={() => guardEditor(() => { setEditor(null); setPanel('assistant'); setUncertainCreate(false); setFormError(''); })}>返回建议</button> : <button className="schedule-button" type="button" disabled={Boolean(busy)} onClick={closePanel}>取消</button>}{canEdit && <button className="schedule-button schedule-primary" type="submit" disabled={Boolean(busy) || (Boolean(editor.item) && !editorDirty)}>{busy === 'save' ? <Loader2 size={15} className="spin" /> : <Check size={15} />}{busy === 'save' ? '正在保存…' : uncertainCreate ? '重试保存' : '保存安排'}</button>}</div></form>}
    </aside>}
    </div>
  </section>;
}
