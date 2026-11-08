'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ZegoConnection } from '../lib/digital-human-types';
import type { WorkspaceMember } from '../lib/member-types';
import './marketing-materials.css';
import './zego-connection-settings.css';

type AvatarGrant = ZegoConnection['avatarGrants'][number];
type ConnectionResponse = { connection: ZegoConnection; message?: string };
const customizationUrl = 'https://doc-zh.zego.im/aigc-digital-human-server/digital-human-customization/avatar-production-platform';

function responseMessage(data: { message?: string }, fallback: string) {
  return typeof data.message === 'string' && data.message.trim() ? data.message.slice(0, 300) : fallback;
}

export default function ZegoConnectionSettings({ onConnectionChanged }: { onConnectionChanged?: () => Promise<void> }) {
  const id = useId();
  const [connection, setConnection] = useState<ZegoConnection>();
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [membersReady, setMembersReady] = useState(false);
  const [appId, setAppId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [grants, setGrants] = useState<AvatarGrant[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const mounted = useRef(false);
  const loadController = useRef<AbortController | null>(null);

  const applyConnection = useCallback((next: ZegoConnection) => {
    setConnection(next);
    setAppId(next.appId);
    setAgentId(next.agentId);
    setEnabled(next.enabled);
    setGrants(next.avatarGrants.map(grant => ({ ...grant })));
    setSecret('');
  }, []);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const controller = new AbortController();
    loadController.current = controller;
    try {
      const results = await Promise.allSettled([
        fetch('/api/zego-connection', { cache: 'no-store', signal: controller.signal }).then(async response => {
          const data = await response.json() as ConnectionResponse;
          if (!response.ok) throw new Error(responseMessage(data, '读取数字人连接失败'));
          return data.connection;
        }),
        fetch('/api/workspace-members', { cache: 'no-store', signal: controller.signal }).then(async response => {
          const data = await response.json() as { members: WorkspaceMember[]; message?: string };
          if (!response.ok) throw new Error(responseMessage(data, '读取授权成员失败'));
          return data.members.filter(member => member.enabled && (member.role === 'sales' || member.role === 'manager'));
        }),
      ]);
      if (!mounted.current) return;
      const [connectionResult, membersResult] = results;
      if (connectionResult.status === 'fulfilled') applyConnection(connectionResult.value);
      if (membersResult.status === 'fulfilled') {
        setMembers(membersResult.value);
        setMembersReady(true);
      } else {
        setMembersReady(false);
      }
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) setError(failures.map(result => result.reason instanceof Error ? result.reason.message : '读取配置失败，请重试').join('；'));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [applyConnection]);

  useEffect(() => {
    mounted.current = true;
    const timer = setTimeout(() => void load(), 0);
    return () => {
      mounted.current = false;
      clearTimeout(timer);
      loadController.current?.abort();
    };
  }, [load]);

  function updateGrant(index: number, patch: Partial<AvatarGrant>) {
    setGrants(previous => previous.map((grant, position) => position === index ? { ...grant, ...patch } : grant));
  }

  async function submit(action: 'save' | 'test') {
    if (inFlight.current || !connection || !membersReady || !connection.storageReady) return;
    setError('');
    setMessage('');
    if (!/^\d+$/.test(appId.trim()) || Number(appId.trim()) < 1 || Number(appId.trim()) > 4294967295) {
      setError('AppID 必须是 1 至 4294967295 之间的整数。');
      return;
    }
    const normalizedGrants = grants.map(grant => ({ digitalHumanId: grant.digitalHumanId.trim(), memberId: grant.memberId }));
    if (normalizedGrants.some(grant => !grant.digitalHumanId || !members.some(member => member.accountId === grant.memberId))) {
      setError('请为每个私有形象选择有效的销售或经理账号，或移除不再需要的授权。');
      return;
    }
    if (new Set(normalizedGrants.map(grant => grant.digitalHumanId)).size !== normalizedGrants.length) {
      setError('同一形象只能授权给一个成员，请移除重复授权。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    const hasDraftSecret = secret.length > 0;
    try {
      const response = await fetch('/api/zego-connection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, version: connection.version, appId: appId.trim(), agentId: agentId.trim(), secret, enabled, avatarGrants: normalizedGrants }),
      });
      const data = await response.json() as ConnectionResponse;
      if (!response.ok) throw new Error(responseMessage(data, '数字人连接操作失败'));
      if (!mounted.current) return;
      if (action === 'save') {
        applyConnection(data.connection);
        setMessage(responseMessage(data, '数字人连接已保存。'));
        try { await onConnectionChanged?.(); }
        catch { if (mounted.current) setMessage('数字人连接已保存，工作台状态暂未刷新，请重新读取。'); }
      } else {
        // Retain the draft baseline version so testing cannot bypass save conflict detection.
        setSecret('');
        setMessage(`${responseMessage(data, '形象列表读取成功。')} 测试未保存配置。${hasDraftSecret ? '输入的密钥已清空；请重新输入后保存。' : ''}`);
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '数字人连接操作失败，请稍后重试');
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="material-connection zego-connection" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>ZEGO 数字人服务</h3>
    <p>先接好配置，再开通即构服务。照片或视频形象需通过<a href={customizationUrl} target="_blank" rel="noopener noreferrer">即构形象制作平台或定制服务</a>完成制作，获得形象 ID 后才能使用。</p>
    <p>仅凭 AppID 和 ServerSecret 即可保存连接、只读查询形象。直播前需在即构注册智能体、配置 TTS 音色，并填写 AgentId。保存与测试连接都不会创建数字人、开始直播或发送播报。</p>
    {error && <p role="alert" className="material-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {connection && !connection.configured && <p>尚未配置数字人连接；可以先填写并保存，开通服务后再测试。</p>}
    {connection && !connection.storageReady && <p role="status">加密存储尚未启用，请先配置服务环境。</p>}
    <form onSubmit={event => { event.preventDefault(); void submit('save'); }}>
      <fieldset disabled={busy || !connection} className="zego-fields">
        <label htmlFor={`${id}-app`}>AppID</label>
        <input id={`${id}-app`} type="text" inputMode="numeric" autoComplete="off" maxLength={10} required value={appId} onChange={event => setAppId(event.target.value)} />
        <label htmlFor={`${id}-secret`}>ServerSecret{connection?.hasSecret ? '（已保存，留空保留）' : ''}</label>
        <input id={`${id}-secret`} type="password" autoComplete="new-password" maxLength={8192} spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} />
        <label htmlFor={`${id}-agent`}>已注册 AgentId（直播前填写）</label>
        <input id={`${id}-agent`} type="text" autoComplete="off" maxLength={128} value={agentId} onChange={event => setAgentId(event.target.value)} />
        <label className="material-toggle zego-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />启用数字人服务</label>
        <div className="zego-grants">
          <h4>私有形象授权</h4>
          <p>每个私有形象仅授权给一个已启用的销售或经理账号。成员只能关联获授权的私有形象；公共形象无需添加。</p>
          {grants.map((grant, index) => <div className="zego-grant" key={index}>
            <label htmlFor={`${id}-avatar-${index}`}>私有形象 ID {index + 1}<input id={`${id}-avatar-${index}`} value={grant.digitalHumanId} maxLength={128} required onChange={event => updateGrant(index, { digitalHumanId: event.target.value })} /></label>
            <div className="zego-grant-field"><label htmlFor={`${id}-member-${index}`}>授权成员 {index + 1}</label><select id={`${id}-member-${index}`} required value={grant.memberId} disabled={!membersReady} onChange={event => updateGrant(index, { memberId: event.target.value })}>
              <option value="">选择成员</option>
              {grant.memberId && !members.some(member => member.accountId === grant.memberId) && <option value={grant.memberId} disabled>原授权成员不可用，请重新选择</option>}
              {members.map(member => <option key={member.accountId} value={member.accountId}>{member.displayName} · {member.username}（{member.role === 'manager' ? '经理' : '销售'}）</option>)}
            </select></div>
            <button type="button" aria-label={`移除形象授权 ${index + 1}`} onClick={() => setGrants(previous => previous.filter((_, position) => position !== index))}>移除</button>
          </div>)}
          <button type="button" disabled={!membersReady} onClick={() => setGrants(previous => [...previous, { digitalHumanId: '', memberId: '' }])}>添加形象授权</button>
        </div>
        <p id={`${id}-test-help`}>只读测试仅检查形象列表访问，不代表已验证 AgentId、TTS 配置或直播权限。实际开播后，还需在目标平台确认画面。</p>
        <div className="material-options">
          <button type="submit" disabled={!connection?.storageReady || !membersReady}>保存数字人连接</button>
          <button type="button" aria-describedby={`${id}-test-help`} disabled={!connection?.storageReady || !membersReady || (!secret && !connection.hasSecret)} onClick={() => void submit('test')}>只读测试连接</button>
        </div>
      </fieldset>
      <button className="zego-reload" type="button" disabled={busy} onClick={() => void load()}>重新读取数字人连接</button>
    </form>
  </section>;
}
