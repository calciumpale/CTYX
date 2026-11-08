import type { KnowledgeChunkConfig } from '../lib/knowledge-chunking-config';

export function KnowledgeChunkControls({ value, onChange, disabled = false }: { value: KnowledgeChunkConfig; onChange: (value: KnowledgeChunkConfig) => void; disabled?: boolean }) {
  const number = (key: keyof KnowledgeChunkConfig, label: string, min: number, max: number) => <label>{label}<input type="number" min={min} max={max} step={1} value={String(value[key])} disabled={disabled} onChange={event => onChange({ ...value, [key]: Number(event.target.value) })} /></label>;
  return <fieldset className="knowledge-form" disabled={disabled}><legend>切块参数（字符数）</legend>
    <label>检索拓扑<select value={value.strategy} onChange={event => onChange({ ...value, strategy: event.target.value as KnowledgeChunkConfig['strategy'] })}><option value="flat">普通分块</option><option value="parent-child">父子分块</option></select></label>
    <label>切分策略<select value={value.method} onChange={event => onChange({ ...value, method: event.target.value as KnowledgeChunkConfig['method'] })}>{[['recursive','自动递归'],['paragraph','按段落'],['lines','按行'],['fixed','固定长度'],['delimiter','自定义分隔符']].map(([id,label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {value.strategy === 'flat' && <>{number('chunkSize','切块大小',128,6000)}{number('overlapPercent','重叠百分比',0,30)}</>}
    {value.method === 'lines' && number('linesPerChunk','每组行数',1,200)}
    {value.method === 'delimiter' && <label>字面分隔符（每行一个，支持 \\n / \\t）<textarea value={value.delimiters.map(item => item.replaceAll('\n','\\n').replaceAll('\t','\\t')).join('\n')} onChange={event => onChange({ ...value, delimiters: event.target.value.split('\n').map(item => item.replaceAll('\\n','\n').replaceAll('\\t','\t')) })} /></label>}
    {value.strategy === 'parent-child' && <>{number('parentChunkSize','父块大小',128,6000)}{number('childChunkSize','子块大小',128,6000)}{number('childOverlapPercent','子块重叠百分比',0,30)}</>}
  </fieldset>;
}
