'use client';

import {useEffect,useState} from 'react';
import {ArrowRight,ClipboardCheck,Loader2} from 'lucide-react';
import type {ApprovalSummary} from '../lib/approval-types';

const labels:Record<ApprovalSummary['status'],string>={pending:'审批中',approved:'已通过',rejected:'已驳回',returned:'退回修改',withdrawn:'已撤回',superseded:'已失效'};

export function ProjectApprovalStatus({projectId,onOpen,disabled=false}:{projectId:string;onOpen:(id?:string)=>void;disabled?:boolean}){
  const [requests,setRequests]=useState<ApprovalSummary[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    void fetch(`/api/approvals?scope=mine&projectId=${encodeURIComponent(projectId)}&limit=3`,{cache:'no-store',credentials:'same-origin',signal:controller.signal}).then(async response=>{
      const body=await response.json() as {requests?:ApprovalSummary[];error?:string};
      if(!response.ok)throw new Error(body.error||'审批记录暂时无法读取');
      if(!controller.signal.aborted){setRequests(body.requests??[]);setError('');}
    }).catch(cause=>{if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'审批记录暂时无法读取');}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[projectId,retry]);
  return <section className="project-section project-approval-status" aria-label="项目商务审批">
    <div className="project-section-heading"><div><h2><ClipboardCheck size={17}/>商务审批</h2><p>商务条件与合同按指定人员逐级确认。</p></div><button className="project-text-button" disabled={disabled} onClick={()=>onOpen()}>发起或查看审批 <ArrowRight size={14}/></button></div>
    {loading?<p className="project-approval-message" role="status"><Loader2 size={15} className="spin"/>正在读取审批记录…</p>:error?<div className="project-approval-message" role="alert"><span>{error}</span><button className="project-text-button" disabled={disabled} onClick={()=>{setLoading(true);setRetry(v=>v+1);}}>重新加载</button></div>:requests.length?<ul>{requests.map(request=><li key={request.id}><button disabled={disabled} onClick={()=>onOpen(request.id)}><div><strong>{request.title}</strong><span>{request.kind==='contract'?'合同审批':'商务条件'}{request.status==='pending'?` · 当前：${request.currentApprover}`:''}</span></div><span className={`project-approval-badge project-approval-${request.status}`}>{labels[request.status]}</span><ArrowRight size={15}/></button></li>)}</ul>:<p className="project-approval-message">还没有审批申请。遇到折扣、账期、交付或合同条款等需授权事项，可从这里提交。</p>}
  </section>;
}
