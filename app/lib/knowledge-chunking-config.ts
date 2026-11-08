export type KnowledgeChunkConfig = {
 version: 1; strategy: 'flat' | 'parent-child'; method: 'recursive' | 'paragraph' | 'lines' | 'fixed' | 'delimiter';
 chunkSize: number; overlapPercent: number; linesPerChunk: number; delimiters: string[];
 parentChunkSize: number; childChunkSize: number; childOverlapPercent: number;
};
export const DEFAULT_KNOWLEDGE_CHUNK_CONFIG: KnowledgeChunkConfig = Object.freeze({version:1,strategy:'flat',method:'recursive',chunkSize:750,overlapPercent:10,linesPerChunk:10,delimiters:Object.freeze(['\n\n']) as unknown as string[],parentChunkSize:1350,childChunkSize:350,childOverlapPercent:10});
export function normalizeKnowledgeChunkConfig(raw: unknown = {}): KnowledgeChunkConfig {
 if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('切块参数必须为对象。');
 const c = {...DEFAULT_KNOWLEDGE_CHUNK_CONFIG,...raw} as KnowledgeChunkConfig;
 if(c.version!==1 || !['flat','parent-child'].includes(c.strategy) || !['recursive','paragraph','lines','fixed','delimiter'].includes(c.method)) throw new Error('不支持的切块参数。');
 for(const [key,min,max] of [['chunkSize',128,6000],['parentChunkSize',128,6000],['childChunkSize',128,6000],['overlapPercent',0,30],['childOverlapPercent',0,30],['linesPerChunk',1,200]] as const) if(!Number.isInteger(c[key]) || c[key]<min || c[key]>max) throw new Error(`切块参数 ${key} 必须为 ${min}–${max} 的整数。`);
 if(c.strategy==='parent-child' && c.childChunkSize>c.parentChunkSize) throw new Error('子块大小不能超过父块。');
 if(!Array.isArray(c.delimiters) || c.delimiters.length>8 || c.delimiters.some(d=>typeof d!=='string'||!d.length||Array.from(d).length>40)) throw new Error('最多支持8个非空分隔符，每个最多40字符。');
 c.delimiters=[...new Set(c.delimiters.map(d=>d.replace(/\\n/g,'\n').replace(/\\t/g,'\t').replace(/\\r/g,'\r')))];
 return c;
}
export function describeKnowledgeChunkConfig(config: KnowledgeChunkConfig): string {
 const c=normalizeKnowledgeChunkConfig(config);
 const names={recursive:'自动递归',paragraph:'段落',lines:'按行',fixed:'固定长度',delimiter:'自定义分隔符'};
 return `${c.strategy==='flat'?'普通':'父子'} · ${names[c.method]} · ${c.strategy==='flat'?c.chunkSize:`${c.parentChunkSize}/${c.childChunkSize}`} 字符 · 重叠 ${c.strategy==='flat'?c.overlapPercent:c.childOverlapPercent}%`;
}
