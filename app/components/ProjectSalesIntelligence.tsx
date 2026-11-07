'use client';

import {useEffect,useRef,useState} from 'react';
import {ChartNoAxesCombined,ChevronDown,History,Lightbulb,Loader2,RefreshCw,Target} from 'lucide-react';
import {salesIntelligenceIsCurrent} from '../lib/sales-intelligence';
import type {Deal,Mutate,View} from '../lib/types';
import type {SalesAssessment,SalesEvidence,SalesNextAction} from '../lib/sales-intelligence-types';
import './project-sales-intelligence.css';

const GRADE={A:'高意向',B:'中低意向',C:'无明显意向'};
const DIMENSION={need:'需求明确度',budget:'预算匹配',decision:'决策链',timeline:'采购时间',engagement:'互动意愿'};
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function Evidence({items}:{items:SalesEvidence[]}){return items.length?<details className="sales-evidence"><summary>查看依据 <ChevronDown size={12}/></summary>{items.map((item,index)=><blockquote key={`${item.refId}:${index}`}><p>{item.quote}</p></blockquote>)}</details>:null;}
function Actions({items}:{items:SalesNextAction[]}){return <ol className="sales-next-actions">{items.map((item,index)=><li key={index}><span>{index+1}</span><div><strong>{item.action}</strong><p>{item.reason}</p><Evidence items={item.evidence}/></div></li>)}</ol>;}

function InsightDetails({assessment:latest}:{assessment:SalesAssessment}) {
  return <details className="sales-dimensions"><summary>评分依据与待确认信息 <ChevronDown size={14}/></summary><dl>{latest.insight.dimensions.map(dimension=><div key={dimension.key}><dt>{DIMENSION[dimension.key]}</dt><dd><strong>{dimension.score===null?'未知':dimension.score}<small> / {dimension.max}</small></strong><p>{dimension.reason}</p><Evidence items={dimension.evidence}/></dd></div>)}</dl>{latest.insight.missingInfo.length>0&&<div className="sales-missing-info"><h4>待确认</h4><ul>{latest.insight.missingInfo.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}<p className="sales-method-note">A：75–100 分；B：30–74 分；C：0–29 分。资料不足时保留待评估。</p></details>;
}
function hasOnlyMissingEvidence(value:SalesAssessment) {
  return value.insight.score===null && value.insight.grade===null && value.forecast.kind==='unknown' && value.forecast.probability===null
    && value.insight.dimensions.every(item=>item.score===null && !item.evidence.length)
    && !value.forecast.factors.length
    && [...value.insight.nextActions,...value.forecast.nextActions].every(item=>!item.evidence.length)
    && JSON.stringify(value.insight.nextActions)===JSON.stringify(value.forecast.nextActions);
}

export function ProjectSalesIntelligence({deal,mutate,notify,modelConnected,disabled,onBusyChange,onReload}:{deal:Deal;mutate:Mutate;notify:(message:string)=>void;modelConnected:boolean;disabled?:boolean;onNavigate?:(view:View,id?:string)=>void;onBusyChange?:(value:boolean)=>void;onReload?:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');const locked=useRef(false);
  const data=deal.intelligence,latest=data?.latest,current=salesIntelligenceIsCurrent(deal);
  const missingEvidence=!!latest && hasOnlyMissingEvidence(latest);
  const modelUnavailable=!modelConnected && deal.outcome!=='won' && deal.outcome!=='lost';
  const showStatus=!!data && data.status!=='ready' && !(missingEvidence && current && data.status==='needs_info');
  const [now,setNow]=useState(()=>Date.now());
  const processing=data?.status==='processing',expired=processing&&now-Date.parse(data.updatedAt)>=120000,pending=processing&&!expired;
  useEffect(()=>{if(!processing)return;const timer=setInterval(()=>{setNow(Date.now());if(Date.now()-Date.parse(data.updatedAt)<120000&&!locked.current)void onReload?.().catch(()=>{});},10000);return()=>clearInterval(timer);},[processing,data?.updatedAt,onReload]);
  const assess=async()=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');onBusyChange?.(true);try{const result=await mutate('deal_assess',{dealId:deal.id,version:deal.version});const updated=result.state.deals.find(d=>d.id===deal.id)?.intelligence;notify(updated?.message||'客户评估已更新');}catch(cause){setError(cause instanceof Error?cause.message:'评估暂未完成，请重试');}finally{locked.current=false;setBusy(false);onBusyChange?.(false);}};
  return <section className="project-section sales-intelligence" aria-label="意向与成交预测" aria-busy={busy||pending}>
    <header className="sales-intelligence-heading"><div><h2><Target size={18}/>意向与成交预测</h2><p>{latest?`${current?'最近评估':'上次评估'} ${date(latest.assessedAt)}`:'尚未评估'}</p></div><button className="button secondary" disabled={disabled||busy||pending||(!modelConnected&&deal.outcome!=='won'&&deal.outcome!=='lost')} onClick={()=>void assess()}>{busy||pending?<Loader2 size={15} className="spin"/>:<RefreshCw size={15}/>} {busy||pending?'正在评估':expired?'重试评估':latest?'重新评估':'开始评估'}</button></header>
    {deal.dataOrigin!=='manual'&&<p className="sales-status-note">依据预置资料分析，不计入真实销售日报。</p>}
    {error&&<p className="project-error" role="alert">{error}</p>}
    {showStatus&&<p className="sales-status-note" role="status">{data?.status==='waiting_config'&&modelUnavailable?'评估需管理员配置模型。':data?.message}{latest&&!current?' · 以下保留上次结果，尚未反映最新资料。':''}</p>}
    {expired&&<p className="sales-status-note">上次评估等待时间较长，可以重试；原始资料已保存。</p>}
    {modelUnavailable&&latest&&!missingEvidence&&data?.status!=='waiting_config'&&<div className="sales-model-notice"><p>评估需管理员配置模型，可先补充客户画像与跟进记录。</p></div>}
    {latest?<>{missingEvidence?<div className="sales-assessment-empty sales-shared-empty"><p role="status">{current?'待补充采购信息，暂未评分或估算成交概率。':'上次评估未形成分值或概率。'}{modelUnavailable?' 评估需管理员配置模型。':''}</p><details className="sales-missing-advice"><summary>补充建议与依据 <ChevronDown size={14}/></summary><Actions items={latest.insight.nextActions}/><InsightDetails assessment={latest}/></details></div>:<div className={`sales-assessment-columns${!current?' sales-assessment-previous':''}`}>
      <section aria-label="客户洞察评分"><h3><Lightbulb size={16}/>客户意向</h3><div className="sales-grade-line">{latest.insight.grade?<><span className={`sales-grade sales-grade-${latest.insight.grade}`}>{latest.insight.grade}</span><div><strong>{GRADE[latest.insight.grade]}</strong><p>意向评分 <b>{latest.insight.score}</b> / 100</p></div></>:<strong className="sales-unassessed">待补充资料</strong>}{!current&&<span className="sales-previous-label">上次结果</span>}</div><p className="sales-assessment-summary">{latest.insight.summary}</p><InsightDetails assessment={latest}/><h4 className="sales-actions-heading">下一步建议</h4><Actions items={latest.insight.nextActions}/></section>
      <section aria-label="成交预测"><h3><ChartNoAxesCombined size={16}/>成交可能性</h3><div className="sales-probability-line"><strong>{latest.forecast.probability===null?'待评估':`${latest.forecast.probability}%`}</strong><span>{latest.forecast.kind==='observed'?'已确认结果':latest.forecast.kind==='estimated'?'模型估计':'资料不足'}{latest.forecast.confidence&&latest.forecast.kind==='estimated'?` · ${{low:'低',medium:'中',high:'高'}[latest.forecast.confidence]}把握`:''}</span></div>{latest.forecast.range&&latest.forecast.kind==='estimated'&&<p className="sales-probability-range">估计区间 {latest.forecast.range.low}%–{latest.forecast.range.high}%</p>}<p className="sales-assessment-summary">{latest.forecast.summary}</p>{latest.forecast.kind==='estimated'&&<p className="sales-method-note">依据当前记录的模型估计，尚未经过历史成交数据校准。</p>}{latest.forecast.factors.length>0&&<details className="sales-factors"><summary>有利因素与阻碍 <ChevronDown size={14}/></summary><ul>{latest.forecast.factors.map((factor,index)=><li key={index}><span>{factor.direction==='positive'?'有利因素':'需关注'}</span><p>{factor.reason}</p><Evidence items={factor.evidence}/></li>)}</ul></details>}<h4 className="sales-actions-heading">下一步建议</h4><Actions items={latest.forecast.nextActions}/></section>
    </div>}{latest.warnings.length>0&&<details className="sales-coverage"><summary>评估范围与说明 <ChevronDown size={13}/></summary>{latest.warnings.map((warning,index)=><p key={index}>{warning}</p>)}</details>}{data!.history.length>0&&<details className="sales-history"><summary><History size={14}/>最近评估变化 <ChevronDown size={13}/></summary><ul>{data!.history.map((item,index)=><li key={`${item.sourceHash}:${index}`}><time>{date(item.assessedAt)}</time><strong>{item.grade?`${item.grade} · ${GRADE[item.grade]}`:'待评估'}</strong><span>{item.probability===null?'概率待评估':`${item.probability}%${item.forecastKind==='observed'?' · 已确认':' · 模型估计'}`}</span><p>{item.summary}</p></li>)}</ul></details>}</>:!showStatus&&!expired&&<div className="sales-assessment-empty"><p>{pending||busy?'正在评估…':modelUnavailable?'评估需管理员配置模型，可先补充客户信息。':'暂无评估结果'}</p></div>}
  </section>;
}

export function ProjectSalesBadges({deal}:{deal:Deal}){const current=salesIntelligenceIsCurrent(deal),latest=deal.intelligence?.latest;if(!latest||!current)return deal.intelligence?.status==='processing'?<span className="sales-project-badge">评估中</span>:null;return <>{latest.insight.grade&&<span className="sales-project-badge">{latest.insight.grade} · {GRADE[latest.insight.grade]}</span>}{latest.forecast.probability!==null&&<span className="sales-project-badge">{latest.forecast.kind==='observed'?'已确认结果':'成交估计'} {latest.forecast.probability}%</span>}</>;}
