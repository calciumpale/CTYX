'use client';
/* Private source previews must use the authenticated route directly. */
/* eslint-disable @next/next/no-img-element */
import {useCallback, useEffect, useRef, useState} from 'react';
import {ExternalLink, FileImage, FileVideo, Radio, UploadCloud, UserRound} from 'lucide-react';
import type {DigitalHumanAsset, DigitalHumanLive, DigitalHumanSnapshot} from '../lib/digital-human-types';
import './digital-human-workspace.css';

const productionGuide = 'https://doc-zh.zego.im/aigc-digital-human-server/digital-human-customization/avatar-production-platform';
const sourceStatuses: Record<DigitalHumanAsset['status'], string> = {
  uploading: '等待上传完成', upload_failed: '上传未完成', awaiting_customization: '待 ZEGO 定制', ready: '形象已关联',
};
const liveStatuses: Record<DigitalHumanLive['status'], string> = {
  draft: '配置已保存', starting: '正在创建推流实例', start_unknown: '启动结果待核对', running: '推流实例已创建',
  stopping: '正在停止', stop_unknown: '停止结果待核对', stopped: '已停止', error: '操作未完成',
};
const providerStates = {IDLE: '空闲', LISTENING: '聆听中', THINKING: '处理中', SPEAKING: '播报中'};
const empty: DigitalHumanSnapshot = {
  assets: [], lives: [], connection: {configured: false, enabled: false, storageReady: false, liveReady: false, customizationMode: 'zego_platform'},
};
type Props = {notify: (message: string) => void; onBusyChange?: (busy: boolean) => void; onDirtyChange?: (dirty: boolean) => void; active?: boolean};
type LiveDraft = {liveId?: string; name: string; platform: string; pushUrl: string};
type ApiResult = Partial<DigitalHumanSnapshot> & {asset?: DigitalHumanAsset; live?: DigitalHumanLive; message?: string; error?: string};

function fileProblem(file: File): string | null {
  if (!['image/png', 'image/jpeg', 'video/mp4'].includes(file.type)) return '请选择 PNG、JPG 照片或 MP4 视频。';
  const limit = file.type.startsWith('image/') ? 20 * 1024 * 1024 : 100 * 1024 * 1024;
  if (!file.size || file.size > limit) return file.type.startsWith('image/') ? '照片须大于 0 且不超过 20 MB。' : '视频须大于 0 且不超过 100 MB。';
  return null;
}
function fromLive(live: DigitalHumanLive | undefined, name: string): LiveDraft {
  return {liveId: live?.id, name: live?.name ?? `${name}直播`, platform: live?.platform ?? 'douyin', pushUrl: ''};
}
function changedLive(draft: LiveDraft, live: DigitalHumanLive | undefined): boolean {
  return !!draft.pushUrl || draft.name !== (live?.name ?? '') || draft.platform !== (live?.platform ?? 'douyin');
}
function prettySize(size: number): string { return `${(size / 1024 / 1024).toFixed(size >= 1024 * 1024 ? 1 : 2)} MB`; }
function liveGenerationKey(live: DigitalHumanLive): string { return `${live.id}:${live.generationId ?? 'not-started'}`; }
function mergeVersions<T extends {id: string; version: number}>(current: T[], incoming: T[]): T[] {
  const latest = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) {
    const previous = latest.get(item.id);
    if (!previous || item.version >= previous.version) latest.set(item.id, item);
  }
  // No deletion action exists on this surface; an older list must not hide a new record.
  const order = new Set([...incoming.map(item => item.id), ...current.map(item => item.id)]);
  return Array.from(order, id => latest.get(id)!);
}

export default function DigitalHumanWorkspace({notify, onBusyChange, onDirtyChange, active = true}: Props) {
  const [snapshot, setSnapshot] = useState<DigitalHumanSnapshot>(empty);
  const [loading, setLoading] = useState(true), [pending, setPending] = useState(false), [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null), [name, setName] = useState(''), [preview, setPreview] = useState('');
  const [dragging, setDragging] = useState(false), [selectedId, setSelectedId] = useState('');
  const [bindIds, setBindIds] = useState<Record<string, string>>({});
  const [existingName, setExistingName] = useState(''), [existingId, setExistingId] = useState('');
  const [liveDrafts, setLiveDrafts] = useState<Record<string, LiveDraft>>({});
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null), mounted = useRef(true), inFlight = useRef(false);
  const previewUrl = useRef('');
  const requests = useRef(new Set<AbortController>());
  const intents = useRef(new Map<string, {hash: string; id: string}>());
  const loaded = useRef(false), pollBudget = useRef(new Map<string, number>());
  const {assets, lives, connection} = snapshot;
  const asset = assets.find(item => item.id === selectedId) ?? assets[0];
  const assetLive = asset ? lives.find(item => item.id === liveDrafts[asset.id]?.liveId) ?? lives.find(item => item.assetId === asset.id) : undefined;
  const liveDraft = asset ? liveDrafts[asset.id] ?? fromLive(assetLive, asset.name) : undefined;
  const liveDirty = Object.entries(liveDrafts).some(([assetId, draft]) => changedLive(draft, lives.find(item => item.id === draft.liveId) ?? lives.find(item => item.assetId === assetId)));
  const selectedLiveDirty = !!asset && !!liveDrafts[asset.id] && changedLive(liveDrafts[asset.id], assetLive);
  const scriptDirty = Object.entries(scripts).some(([id, text]) => !!text.trim() && text.trim() !== lives.find(item => item.id === id)?.lastCommand?.text);
  const dirty = !!file || !!name.trim() || !!existingId.trim() || !!existingName.trim() || Object.values(bindIds).some(Boolean) || liveDirty || scriptDirty;
  const script = assetLive ? scripts[assetLive.id] ?? '' : '';
  const sameCommand = !!assetLive?.lastCommand && assetLive.lastCommand.text === script.trim();
  const commandLocked = sameCommand && ['sending', 'accepted', 'unknown'].includes(assetLive!.lastCommand!.status);
  const transition = !!assetLive && ['starting', 'stopping'].includes(assetLive.status);

  const request = useCallback(async (path: string, init: RequestInit = {}) => {
    const controller = new AbortController(); requests.current.add(controller);
    try {
      const response = await fetch(path, {...init, signal: controller.signal, credentials: 'same-origin'});
      const body = await response.json() as ApiResult;
      if (!response.ok) throw new Error(body.message || body.error || '数字人服务暂时不可用，请稍后重试。');
      return body;
    } finally { requests.current.delete(controller); }
  }, []);
  const accept = useCallback((result: ApiResult) => {
    if (!mounted.current) return;
    setSnapshot(old => ({
      assets: result.assets ? mergeVersions(old.assets, result.assets) : result.asset ? mergeVersions(old.assets, [result.asset]) : old.assets,
      lives: result.lives ? mergeVersions(old.lives, result.lives) : result.live ? mergeVersions(old.lives, [result.live]) : old.lives,
      connection: result.connection ?? old.connection,
    }));
  }, []);
  const load = useCallback(async (clearError = true) => {
    try { const result = await request('/api/digital-humans', {cache: 'no-store'}); accept(result); if (mounted.current && clearError) setError(''); loaded.current = true; }
    catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { if (mounted.current) setLoading(false); }
  }, [accept, request]);
  useEffect(() => {
    mounted.current = true; const activeRequests = requests.current;
    return () => { mounted.current = false; for (const controller of activeRequests) controller.abort(); activeRequests.clear(); if (previewUrl.current) URL.revokeObjectURL(previewUrl.current); onBusyChange?.(false); onDirtyChange?.(false); };
  }, [onBusyChange, onDirtyChange]);
  useEffect(() => { if (active && !loaded.current) void load(); }, [active, load]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    // Reconcile intent bookkeeping only from the accepted, version-merged state.
    for (const live of snapshot.lives) {
      if (live.status === 'running' || live.status === 'stopped') intents.current.delete(`startLive:${live.id}`);
      if (live.status === 'stopped') intents.current.delete(`stopLive:${live.id}`);
    }
  }, [snapshot.lives]);
  function replacePreview(next: File | null) {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = next ? URL.createObjectURL(next) : '';
    setPreview(previewUrl.current);
  }

  function intent(key: string, payload: unknown, fresh = false): string {
    const hash = JSON.stringify(payload), previous = intents.current.get(key);
    if (!fresh && previous?.hash === hash) return previous.id;
    const next = {hash, id: crypto.randomUUID()}; intents.current.set(key, next); return next.id;
  }
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true); setError(''); onBusyChange?.(true);
    try { await work(); }
    catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { inFlight.current = false; if (mounted.current) { setPending(false); onBusyChange?.(false); } }
  }
  async function command(body: Record<string, unknown>): Promise<ApiResult> {
    const result = await request('/api/digital-humans', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    accept(result); return result;
  }
  function chooseFile(files: FileList | File[]) {
    if (pending || files.length !== 1) { if (files.length !== 1) setError('每个数字人请选择一张照片或一段视频。'); return; }
    const next = files[0], problem = fileProblem(next);
    if (problem) { setError(problem); return; }
    // A deliberate new file selection is a new upload intent, even when metadata matches.
    // Retrying the current selection keeps its identity until its saved result is confirmed.
    intents.current.delete('upload');
    replacePreview(next); setFile(next); setName(next.name.replace(/\.[^.]+$/, '').slice(0, 80)); setError(''); onDirtyChange?.(true);
  }
  async function upload() {
    if (!file || !name.trim()) return;
    const source = file;
    await run(async () => {
      const payload = {name: name.trim(), sourceKind: source.type.startsWith('image/') ? 'photo' : 'video', fileName: source.name, mime: source.type, size: source.size};
      const reservation = await command({action: 'createAsset', requestId: intent('upload', payload), ...payload});
      if (!mounted.current) return;
      let next = reservation.asset;
      if (!next) throw new Error('未能读取上传记录，请刷新列表后重试。');
      if (['uploading', 'upload_failed'].includes(next.status)) {
        const result = await request(`/api/digital-humans/source?assetId=${encodeURIComponent(next.id)}&version=${next.version}`, {method: 'PUT', headers: {'Content-Type': source.type}, body: source});
        accept(result); next = result.asset;
      }
      if (!mounted.current || !next) return;
      setSelectedId(next.id); replacePreview(null); setFile(null); setName(''); intents.current.delete('upload'); notify('定制素材已保存');
    });
  }
  async function bindAvatar() {
    if (!asset || !bindIds[asset.id]?.trim()) return;
    const id = asset.id;
    await run(async () => {
      await command({action: 'bindAvatar', assetId: id, version: asset.version, digitalHumanId: bindIds[id].trim()});
      if (mounted.current) { setBindIds(old => ({...old, [id]: ''})); notify('ZEGO 形象已关联'); }
    });
  }
  async function addAvatar() {
    if (!existingId.trim() || !existingName.trim()) return;
    await run(async () => {
      const payload = {name: existingName.trim(), digitalHumanId: existingId.trim()};
      const result = await command({action: 'addAvatar', requestId: intent('existing', payload), ...payload});
      if (mounted.current && result.asset) { setSelectedId(result.asset.id); setExistingId(''); setExistingName(''); intents.current.delete('existing'); notify('已有形象已添加'); }
    });
  }
  function updateLive(patch: Partial<LiveDraft>) {
    if (!asset || !liveDraft) return;
    setLiveDrafts(old => ({...old, [asset.id]: {...liveDraft, ...patch}})); onDirtyChange?.(true);
  }
  async function saveLive() {
    if (!asset || !liveDraft) return;
    const currentAsset = asset, draft = liveDraft;
    await run(async () => {
      const payload = {assetId: currentAsset.id, name: draft.name.trim(), platform: draft.platform, pushUrl: draft.pushUrl};
      const result = await command({action: 'saveLive', requestId: intent(`save:${currentAsset.id}`, payload), ...(assetLive ? {liveId: assetLive.id, version: assetLive.version} : {}), ...payload});
      if (mounted.current && result.live) { const next = result.live; setLiveDrafts(old => ({...old, [currentAsset.id]: fromLive(next, currentAsset.name)})); intents.current.delete(`save:${currentAsset.id}`); notify('直播配置已保存'); }
    });
  }
  async function liveAction(action: 'startLive' | 'refreshLive' | 'stopLive') {
    if (!assetLive) return;
    const live = assetLive;
    await run(async () => {
      const result = await command({action, liveId: live.id, version: live.version, requestId: intent(`${action}:${live.id}`, {id: live.id, ...(action === 'startLive' ? {} : {version: live.version})})});
      if (action === 'startLive' && result.live?.status === 'running') pollBudget.current.delete(liveGenerationKey(result.live));
      if (result.live && ['running', 'stopped', 'error'].includes(result.live.status)) intents.current.delete(`${action}:${live.id}`);
    });
  }
  async function speak(fresh = false) {
    if (!assetLive || !script.trim() || Array.from(script).length > 300) return;
    const live = assetLive;
    await run(async () => {
      const payload = {liveId: live.id, text: script.trim()};
      const result = await command({action: 'speak', ...payload, generationId: live.generationId, version: live.version, requestId: intent(`speak:${liveGenerationKey(live)}`, payload, fresh || sameCommand && live.lastCommand?.status === 'failed')});
      if (mounted.current && result.live?.lastCommand?.status === 'accepted') notify('讲稿已提交播报');
    });
  }
  useEffect(() => {
    if (!active || !assetLive || !['running', 'stop_unknown'].includes(assetLive.status) || pending || error) return;
    const generation = liveGenerationKey(assetLive);
    if ((pollBudget.current.get(generation) ?? 0) >= 120) return;
    const live = assetLive;
    const timer = setTimeout(() => { pollBudget.current.set(generation, (pollBudget.current.get(generation) ?? 0) + 1); void run(async () => { await command({action: 'refreshLive', liveId: live.id, version: live.version, requestId: crypto.randomUUID()}); }); }, 10000);
    return () => clearTimeout(timer);
    // The live version is the request fence; only settled records schedule another query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, assetLive, pending, error]);

  return <section className="digital-human-workspace" aria-label="数字人工作区">
    <div className="digital-human-intro"><div><h3>让你的形象走进直播</h3><p>准备照片或视频，在 ZEGO 完成形象定制后，关联到这里并配置直播推流。</p></div><button type="button" disabled={pending || loading} onClick={() => void load()}>刷新数字人列表</button></div>
    {!loading && (!connection.configured || !connection.enabled) && <p className="digital-human-notice" role="status">ZEGO 服务待配置。可先保存定制素材；关联形象和推流需管理员在「服务连接 → 数字人」完成设置。</p>}
    {error && <p role="alert" className="material-error">{error}</p>}
    <div className="digital-human-columns">
      <aside className="digital-human-sources">
        <form className="digital-human-upload" onSubmit={event => {event.preventDefault(); void upload();}}>
          <h3>准备定制素材</h3>
          <input ref={fileInput} type="file" accept="image/png,image/jpeg,video/mp4,.png,.jpg,.jpeg,.mp4" className="digital-human-file-input" aria-label="选择数字人照片或视频" disabled={pending} onChange={event => {if (event.target.files?.length) chooseFile(event.target.files); event.target.value = '';}}/>
          <button type="button" className={`digital-human-drop${dragging ? ' digital-human-drop-active' : ''}`} disabled={pending} onClick={() => fileInput.current?.click()} onDragOver={event => {event.preventDefault(); if (!pending) setDragging(true);}} onDragLeave={() => setDragging(false)} onDrop={event => {event.preventDefault(); setDragging(false); if (!pending) chooseFile(event.dataTransfer.files);}}>
            <UploadCloud size={26}/><strong>{file ? file.name : '拖入照片或视频，或点击选择'}</strong><span>{file ? prettySize(file.size) : 'PNG / JPG ≤20 MB · MP4 ≤100 MB'}</span>
          </button>
          {preview && <div className="digital-human-local-preview">{file?.type.startsWith('image/') ? <img src={preview} alt="待上传的数字人照片"/> : <video src={preview} controls preload="metadata"/>}</div>}
          <label>数字人名称<input value={name} maxLength={80} disabled={pending} onChange={event => setName(event.target.value)} placeholder="例如：品牌讲解员"/></label>
          <button className="material-primary" type="submit" disabled={pending || !file || !name.trim() || loading || !connection.storageReady}>{pending && file ? '正在保存素材…' : '保存定制素材'}</button>
          <p>素材先私密保存在当前账号。形象定制需在 ZEGO 已开通的平台或服务中完成。</p>
        </form>
        <details className="digital-human-existing"><summary>使用已有 ZEGO 形象</summary><form onSubmit={event => {event.preventDefault(); void addAvatar();}}><label>已有形象名称<input value={existingName} maxLength={80} disabled={pending} onChange={event => setExistingName(event.target.value)}/></label><label>已有形象 ID<input value={existingId} maxLength={128} disabled={pending} onChange={event => setExistingId(event.target.value)}/></label><p>私有形象需由管理员授权给当前账号。</p><button type="submit" disabled={pending || !connection.configured || !connection.enabled || !existingId.trim() || !existingName.trim()}>验证并添加</button></form></details>
      </aside>
      <div className="digital-human-main">
        <h3>我的数字人</h3>
        {loading ? <p role="status">正在读取数字人…</p> : !assets.length ? <div className="digital-human-empty"><UserRound size={32}/><h4>从一张照片或一段视频开始</h4><p>保存素材后，定制进度、形象关联和直播配置会集中在这里。</p></div> : <>
          <div className="digital-human-list" aria-label="数字人列表">{assets.map(item => <button type="button" key={item.id} disabled={pending} aria-pressed={asset?.id === item.id} onClick={() => setSelectedId(item.id)}>{item.sourceKind === 'video' ? <FileVideo size={18}/> : item.sourceKind === 'photo' ? <FileImage size={18}/> : <UserRound size={18}/>}<span><strong>{item.name}</strong><small>{sourceStatuses[item.status]}</small></span></button>)}</div>
          {asset && <article className="digital-human-detail" aria-label={`${asset.name}数字人详情`}>
            <div className="digital-human-detail-heading"><div><h3>{asset.name}</h3><p>{sourceStatuses[asset.status]}{asset.digitalHumanName ? ` · ${asset.digitalHumanName}` : ''}</p></div>{asset.sourceUrl && <a href={asset.sourceUrl} download>下载定制素材</a>}</div>
            {asset.error && <p role="status" className="material-error">{asset.error}</p>}
            {asset.sourceUrl && <div className="digital-human-source-preview">{asset.sourceKind === 'photo' ? <img src={asset.sourceUrl} alt={`${asset.name}的定制源照片`}/> : asset.sourceKind === 'video' ? <video src={asset.sourceUrl} controls preload="metadata"/> : null}<small>上传的原始素材</small></div>}
            {asset.status === 'awaiting_customization' && <div className="digital-human-customization"><h4>下一步：完成 ZEGO 形象定制</h4><p>当前公开服务端接口不提供照片、视频训练提交。请在 ZEGO 开通的定制平台或服务中制作形象，完成后填写其形象 ID。</p><a href={productionGuide} target="_blank" rel="noreferrer">查看 ZEGO 形象制作流程 <ExternalLink size={13}/></a></div>}
            {['awaiting_customization', 'ready'].includes(asset.status) && <form className="digital-human-bind" onSubmit={event => {event.preventDefault(); void bindAvatar();}}><label>ZEGO 形象 ID<input value={bindIds[asset.id] ?? ''} maxLength={128} placeholder={asset.digitalHumanId || '填写定制完成后的 DigitalHumanId'} disabled={pending || !!assetLive && !['draft', 'stopped', 'error'].includes(assetLive.status)} onChange={event => setBindIds(old => ({...old, [asset.id]: event.target.value}))}/></label><button type="submit" disabled={pending || !connection.configured || !connection.enabled || !bindIds[asset.id]?.trim() || !!assetLive && !['draft', 'stopped', 'error'].includes(assetLive.status)}>验证并关联形象</button><p>系统会向 ZEGO 核验形象；私有形象需管理员授权。</p></form>}
            {asset.status === 'ready' && liveDraft && <section className="digital-human-live" aria-label="数字人直播配置">
              <h3><Radio size={17}/>直播配置</h3><p>填写平台提供的完整推流地址。保存后不会开播，启动推流和播报分别由你操作。</p>
              <form onSubmit={event => {event.preventDefault(); void saveLive();}}><fieldset disabled={pending || transition || !!assetLive && !['draft', 'stopped', 'error'].includes(assetLive.status)}><label>直播名称<input value={liveDraft.name} maxLength={80} onChange={event => updateLive({name: event.target.value})}/></label><label>目标平台<select value={liveDraft.platform} onChange={event => updateLive({platform: event.target.value})}><option value="douyin">抖音</option><option value="kuaishou">快手</option><option value="wechat">视频号</option><option value="other">其他直播平台</option></select></label><label>完整推流地址<input type="password" autoComplete="off" value={liveDraft.pushUrl} maxLength={4096} onChange={event => updateLive({pushUrl: event.target.value})} placeholder={assetLive?.hasPushUrl ? '已安全保存，留空保留' : 'rtmp://推流服务器/应用/推流密钥'}/></label>{assetLive?.hasPushUrl && <p>已保存：{assetLive.pushUrlDisplay}</p>}<button type="submit" disabled={pending || !liveDraft.name.trim() || !liveDraft.pushUrl.trim() && !assetLive?.hasPushUrl}>保存直播配置</button></fieldset></form>
              {assetLive && <div className="digital-human-live-state"><p role="status"><strong>{liveStatuses[assetLive.status]}</strong>{assetLive.providerState ? ` · ZEGO ${providerStates[assetLive.providerState]}` : ''}</p>{assetLive.error && <p className="material-error">{assetLive.error}</p>}<div className="digital-human-actions"><button type="button" className="material-primary" disabled={pending || !connection.liveReady || selectedLiveDirty || !['draft', 'stopped', 'error'].includes(assetLive.status)} onClick={() => void liveAction('startLive')}>启动推流</button><button type="button" disabled={pending || !assetLive.hasInstance || transition} onClick={() => void liveAction('refreshLive')}>查询直播状态</button><button type="button" disabled={pending || !assetLive.hasInstance || transition || assetLive.status === 'stopped'} onClick={() => void liveAction('stopLive')}>停止推流</button></div>
                {!connection.liveReady && <p>推流前，请管理员配置已注册且包含语音合成的 ZEGO Agent ID，并开通相应服务。</p>}
                {assetLive.status === 'start_unknown' && <p>请先在 ZEGO 控制台核对本次启动；系统不会自动创建另一个推流实例。</p>}
                <p>实例创建成功后，请在目标平台检查实际画面。连续 2 分钟未提交播报时，ZEGO 会自动回收空闲实例。</p>
                {assetLive.status === 'running' && <form className="digital-human-script" onSubmit={event => {event.preventDefault(); void speak();}}><label>直播讲稿<textarea value={script} rows={4} maxLength={600} disabled={pending} onChange={event => setScripts(old => ({...old, [assetLive.id]: event.target.value}))} placeholder="填写这一段要播报的内容，最多 300 字"/></label><small>{Array.from(script).length} / 300 字</small><div className="digital-human-actions"><button type="submit" disabled={pending || !connection.enabled || !script.trim() || Array.from(script).length > 300 || commandLocked}>提交播报</button>{sameCommand && assetLive.lastCommand?.status === 'accepted' && <button type="button" disabled={pending || !connection.enabled} onClick={() => void speak(true)}>再次播报相同讲稿</button>}</div>{assetLive.lastCommand && <p role="status">{assetLive.lastCommand.status === 'accepted' ? '讲稿已提交给 ZEGO。再次播报会重新调用语音服务。' : assetLive.lastCommand.status === 'unknown' ? '本次播报结果待核对，系统不会自动重复提交。' : assetLive.lastCommand.status === 'sending' ? '正在提交讲稿…' : '讲稿未成功提交，请核对后重试。'}</p>}</form>}
              </div>}
            </section>}
          </article>}
        </>}
      </div>
    </div>
  </section>;
}
