'use client';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Building2, Check, CircleAlert, ExternalLink, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CompanyConnectionProvider, CompanyConnectionSnapshot, CompanyConnectionSummary } from '../lib/company-connection';
import './company-connection.css';

const providerInfo = {
  qcc: {
    name: '企查查', appKey: 'AppKey', secretKey: 'SecretKey',
    description: '',
    hint: '企业工商信息接口；需在企查查开放平台开通对应权限。',
    documentation: 'https://openapi.qcc.com/dataApi/410',
  },
  jinghai: {
    name: '鲸海数据', appKey: 'AppID', secretKey: 'API Key',
    description: '查询顺序：鲸海数据 → 企查查 → 公开网络。',
    hint: '企业详情接口；需在鲸海数据开通对应权限。',
    documentation: 'https://www.kqdaas.com/docs/getting-started',
  },
};
async function responseBody(response:Response,provider:CompanyConnectionProvider):Promise<CompanyConnectionSnapshot> {
  const body=await response.json() as CompanyConnectionSnapshot & {error?:string};
  if(!response.ok)throw new Error(body.error||`暂时无法读取${providerInfo[provider].name}配置，请重试`);
  if(!body.connection)throw new Error('配置响应不完整，请重新加载');
  if('provider' in body.connection&&body.connection.provider!==provider)throw new Error('配置服务与当前卡片不一致，请重新加载');
  return body;
}
export function CompanyConnectionSettings({provider='qcc'}:{provider?:CompanyConnectionProvider}={}) {
  const info=providerInfo[provider];
  const id=useId();const appKey=useRef<HTMLInputElement>(null);const secretKey=useRef<HTMLInputElement>(null);
  const [connection,setConnection]=useState<CompanyConnectionSummary|null>(null);
  const [storageReady,setStorageReady]=useState(false);const [enabled,setEnabled]=useState(true);
  const [pending,setPending]=useState<'load'|'save'|'remove'|null>('load');
  const [error,setError]=useState('');const [message,setMessage]=useState('');
  const busy=useRef(false);const alive=useRef(false);const controller=useRef<AbortController|null>(null);
  const attachAppKey=useCallback((node:HTMLInputElement|null)=>{if(!node&&appKey.current)appKey.current.value='';appKey.current=node;},[]);
  const attachSecretKey=useCallback((node:HTMLInputElement|null)=>{if(!node&&secretKey.current)secretKey.current.value='';secretKey.current=node;},[]);
  const accept=useCallback((body:CompanyConnectionSnapshot)=>{setConnection(body.connection);setStorageReady(body.storageReady);setEnabled(body.connection.configured?body.connection.enabled:true);},[]);
  const load=useCallback(async()=>{
    if(busy.current)return;busy.current=true;setPending('load');setError('');setMessage('');setConnection(null);setStorageReady(false);
    const abort=new AbortController();controller.current=abort;
    try{const result=await responseBody(await fetch(`/api/company-connection${provider==='jinghai'?'?provider=jinghai':''}`,{credentials:'same-origin',cache:'no-store',signal:abort.signal}),provider);if(alive.current&&!abort.signal.aborted)accept(result);}
    catch(cause){if(alive.current&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'配置加载失败，请重试');}
    finally{if(controller.current===abort){busy.current=false;if(alive.current&&!abort.signal.aborted)setPending(null);}}
  },[accept,provider]);
  useEffect(()=>{alive.current=true;let cancelled=false;queueMicrotask(()=>{if(!cancelled)void load();});return()=>{cancelled=true;alive.current=false;controller.current?.abort();controller.current=null;busy.current=false;if(appKey.current)appKey.current.value='';if(secretKey.current)secretKey.current.value='';};},[load]);
  const perform=async(action:'save'|'remove')=>{
    if(busy.current||!connection)return;busy.current=true;setPending(action);setError('');setMessage('');
    const abort=new AbortController();controller.current=abort;
    try{
      const result=await responseBody(await fetch('/api/company-connection',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:abort.signal,body:JSON.stringify({action,version:connection.version,...(provider==='jinghai'?{provider}:{}),...(action==='save'?{enabled,appKey:appKey.current?.value.trim()||'',secretKey:secretKey.current?.value.trim()||''}:{})})}),provider);
      if(!alive.current||abort.signal.aborted)return;accept(result);setMessage(result.message||'配置已保存');if(appKey.current)appKey.current.value='';if(secretKey.current)secretKey.current.value='';
    }catch(cause){if(alive.current&&!abort.signal.aborted)setError(cause instanceof Error?cause.message:'配置未能保存，请重试');}
    finally{if(controller.current===abort){busy.current=false;if(alive.current&&!abort.signal.aborted)setPending(null);}}
  };
  const submit=(event:FormEvent)=>{event.preventDefault();void perform('save');};
  return <section className="company-connection" id={provider==='qcc'?'company-api-configuration':'jinghai-api-configuration'} aria-labelledby={`${id}-title`} aria-busy={pending!==null}>
    <div className="company-connection-heading"><Building2 size={23}/><div><h2 id={`${id}-title`}>企业数据 · {info.name}</h2></div><span>{pending==='load'?'读取中':connection?.configured?(connection.enabled?'已配置':'已停用'):'未配置'}</span></div>
    {pending==='load'?<p className="company-connection-feedback"><Loader2 size={15} className="spin"/>正在读取配置…</p>:!connection?<div role="alert" className="company-connection-feedback"><CircleAlert size={16}/><span>{error}</span><button className="button secondary" onClick={()=>void load()}><RefreshCw size={14}/>重新加载</button></div>:<>
      {info.description && <p className="company-connection-description">{info.description}</p>}
      <form onSubmit={submit}><fieldset disabled={pending!==null||!storageReady}>
        <details className="company-connection-details"><summary>接口信息</summary><label className="company-connection-endpoint">官方接口<input value={provider==='jinghai'?'https://www.kqdaas.com/DataService/api/v3/company/detail':connection.endpoint} readOnly aria-label={`${info.name}官方接口`}/><small>{info.hint}</small></label></details>
        <div className="company-connection-fields"><label htmlFor={`${id}-app`}>{info.appKey}<input ref={attachAppKey} id={`${id}-app`} type="password" autoComplete="new-password" maxLength={1024} placeholder={connection.hasCredentials?'已保存，留空保留':`输入 ${info.appKey}`} required={!connection.hasCredentials}/></label><label htmlFor={`${id}-secret`}>{info.secretKey}<input ref={attachSecretKey} id={`${id}-secret`} type="password" autoComplete="new-password" maxLength={1024} placeholder={connection.hasCredentials?'已保存，留空保留':`输入 ${info.secretKey}`} required={!connection.hasCredentials}/></label></div>
        <label className="company-connection-enable"><input type="checkbox" checked={enabled} onChange={event=>setEnabled(event.target.checked)}/><span>启用{info.name}</span></label>
        <div className="company-connection-actions"><span><ShieldCheck size={14}/>凭证加密保存</span><button type="submit" className="button primary">{pending==='save'?<Loader2 size={15} className="spin"/>:<Check size={15}/>}保存</button></div>
      </fieldset></form>
      {!storageReady&&<p className="company-connection-feedback" role="alert">加密存储尚未启用，请联系管理员后再保存。</p>}
      {error&&<p className="company-connection-feedback" role="alert"><CircleAlert size={16}/>{error}<button className="text-button" disabled={pending!==null} onClick={()=>void load()}>重新加载配置</button></p>}
      {message&&<p className="company-connection-feedback" role="status"><Check size={16}/>{message}</p>}
      <div className="company-connection-footer"><a href={info.documentation} target="_blank" rel="noopener noreferrer">查看接口文档<ExternalLink size={13}/></a>{connection.configured&&<button className="text-button" disabled={pending!==null} onClick={()=>void perform('remove')}>{pending==='remove'?'移除中…':'移除配置'}</button>}</div>
    </>}
  </section>;
}
