import { DomainError } from './domain.ts';
import { normalizeModelBaseUrl } from './connection-config.ts';
import { validateVectors } from './talktrack-vectors.ts';
export interface EmbeddingConnection{key:string;url:string;name:string;}
export async function requestEmbeddings(model:EmbeddingConnection,texts:string[],options:{request?:typeof fetch;origin?:string}={}):Promise<{vectors:number[][];model:string}>{
  if(!texts.length||texts.length>30||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>20000))throw new DomainError('向量输入为空或超出批量限制');
  const base=normalizeModelBaseUrl(model.url,options.origin);const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45000);
  try{
    const response=await (options.request??fetch)(`${base}/embeddings`,{method:'POST',headers:{Authorization:`Bearer ${model.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:model.name,input:texts,encoding_format:'float'}),signal:controller.signal,redirect:'manual'});
    if(!response.ok)throw new DomainError(`Embedding 服务返回 HTTP ${response.status}，请检查配置`,502);
    const reader=response.body?.getReader();if(!reader)throw new Error();let size=0;const chunks:Uint8Array[]=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new Error();}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    const body=JSON.parse(new TextDecoder().decode(bytes));if(!Array.isArray(body.data)||body.data.length!==texts.length)throw new Error();
    const rows=[...body.data].sort((a,b)=>a.index-b.index);if(rows.some((r,i)=>r.index!==i))throw new Error();
    return {vectors:validateVectors(rows.map(r=>r.embedding),texts.length),model:`${base}#${model.name}`};
  }catch(error){if(error instanceof DomainError)throw error;throw new DomainError('Embedding 服务未返回有效向量，请检查模型与接口；本次索引未完成',502);}finally{clearTimeout(timer);}
}
