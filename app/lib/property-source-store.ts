import type {KnowledgeDepartmentId} from './knowledge-department-scope.ts';
import {KNOWLEDGE_DEPARTMENTS} from './knowledge-department-scope.ts';
import type {PropertySource} from './property-records.ts';

type Document={id:string;library_id:string;library_name:string;title:string;file_name:string;updated_at:string;source_version:string|null;source_hash:string|null;content_version:number;chunk_count:number;strategy:string};
type SourcePage={ordinal:number;text:string;hash:string;length:number};
type Chunk={ordinal:number;parent_ordinal:number|null;kind:string;heading:string;text:string};
export type PropertySourceOptions={departmentId?:KnowledgeDepartmentId|null;libraryIds?:string[]};
export type PropertySourcesResult={sources:PropertySource[];complete:boolean;issues:string[]};
const MAX_DOCUMENTS=24,MAX_TOTAL_CHARACTERS=4_000_000,MAX_SOURCE_CHARACTERS=1_000_000,MAX_CHUNKS=6000;
// Stock-table names, rather than every mention of a shop in ordinary sales material.
const propertyNames=['空置','在租','空铺','待租','可租','房源','铺源','履约商铺表','商铺台账','商铺清单','商铺资源','商铺表','铺位台账','铺位清单','铺位资源'];
const digest=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('');

/** Longest exact shared suffix/prefix, without quadratic scans of large chunks. */
function overlap(previous:string,next:string):number{
 const joined=next+'\0'+previous.slice(-next.length),prefix=new Uint32Array(joined.length);
 for(let i=1;i<joined.length;i++){let j=prefix[i-1];while(j&&joined[i]!==joined[j])j=prefix[j-1];if(joined[i]===joined[j])j++;prefix[i]=j;}
 return Math.min(next.length,prefix.at(-1)??0);
}
function columnIndex(column:string){let value=0;for(const char of column)value=value*26+char.charCodeAt(0)-64;return value;}
function cellContinuation(previous:string,next:string):boolean{
 if(!/[；;]\s*$/.test(previous))return false;
 const lastLine=previous.slice(previous.lastIndexOf('\n')+1),row=/^第(\d+)行[：:]/.exec(lastLine),cell=/^([A-Z]+)(\d+)=/.exec(next);
 if(!row||!cell||row[1]!==cell[2])return false;
 const cells=[...lastLine.matchAll(/(?:^|[：:；;])([A-Z]+)(\d+)=/g)];
 return !!cells.length&&cells.every(value=>value[2]===row[1])&&columnIndex(cell[1])>columnIndex(cells.at(-1)![1]);
}
function validLegacy(document:Document,chunks:Chunk[]):boolean{
 if(!chunks.length||chunks.length>MAX_CHUNKS||!Number.isSafeInteger(document.chunk_count)||document.chunk_count<1)return false;
 const first=chunks[0].ordinal;
 if(first!==0&&first!==1)return false;
 if(chunks.some((chunk,index)=>!Number.isSafeInteger(chunk.ordinal)||chunk.ordinal!==first+index||!chunk.text.trim()))return false;
 if(chunks.filter(chunk=>chunk.kind!=='parent').length!==document.chunk_count)return false;
 if(document.strategy==='flat')return chunks.every(chunk=>chunk.kind==='flat'&&chunk.parent_ordinal===null);
 if(document.strategy!=='parent-child'||chunks.some(chunk=>chunk.kind!=='parent'&&chunk.kind!=='child'))return false;
 const parents=new Map(chunks.filter(chunk=>chunk.kind==='parent').map(chunk=>[chunk.ordinal,chunk]));
 const covered=new Set<number>();
 for(const chunk of chunks){
  if(chunk.kind==='parent'){if(chunk.parent_ordinal!==null)return false;continue;}
  const parent=chunk.parent_ordinal===null?undefined:parents.get(chunk.parent_ordinal);
  if(!parent||parent.ordinal>=chunk.ordinal||parent.heading!==chunk.heading||!parent.text.includes(chunk.text))return false;
  covered.add(parent.ordinal);
 }
 return parents.size>0&&covered.size===parents.size;
}
function reconstruct(chunks:Chunk[]):{text:string;complete:boolean}{
 const selected=chunks.some(c=>c.kind==='parent')?chunks.filter(c=>c.kind==='parent'):chunks.filter(c=>c.kind==='flat');
 let text='',heading='',previous='';
 for(const chunk of selected){
  if(!chunk.text.trim())continue;
  if(!previous||chunk.heading!==heading){
   const prefix=chunk.heading&&!chunk.text.trimStart().startsWith('#')?`## ${chunk.heading}\n`:'';
   text+=(text?'\n\n':'')+prefix+chunk.text;heading=chunk.heading;previous=chunk.text;continue;
  }
  const shared=overlap(previous,chunk.text);
  if(shared>=16||shared===chunk.text.length){text+=chunk.text.slice(shared);previous+=chunk.text.slice(shared);continue;}
  const next=chunk.text.trimStart();
  if(cellContinuation(previous,next)){text+=next;previous+=next;continue;}
  if(/^(?:第\d+行[：:]|#{1,6}\s)/.test(next)){text+='\n'+next;previous=next;continue;}
  // Without original offsets, an ambiguous boundary can change a cell's value or
  // invent a CSV/Markdown record. Reject the whole legacy source, including earlier rows.
  return{text:'',complete:false};
 }
 return{text,complete:selected.length>0};
}

/** Enumerate current inventory sources within a server-owned authorization scope. */
export async function readPropertySources(db:D1Database,ownerId:string,options:PropertySourceOptions={}):Promise<PropertySourcesResult>{
 if(!ownerId)throw new Error('Knowledge owner required');
 const department=options.departmentId;
 if(department!==undefined&&department!==null&&!KNOWLEDGE_DEPARTMENTS.some(item=>item.id===department))throw new Error('资料库部门范围无效');
 if(options.libraryIds!==undefined&&(!Array.isArray(options.libraryIds)||options.libraryIds.length>100||options.libraryIds.some(id=>typeof id!=='string'||!id||id.length>140)))throw new Error('资料库范围无效');
 if(options.libraryIds?.length===0)return{sources:[],complete:true,issues:[]};
 const values:unknown[]=[ownerId],scope=["d.owner_id=?"];
 if(department!==undefined){scope.push("l.department_id IN ('shared',?)");values.push(department??'shared');}
 if(options.libraryIds!==undefined){scope.push('d.library_id IN (SELECT value FROM json_each(?))');values.push(JSON.stringify([...new Set(options.libraryIds)]));}
 const authorized=scope.join(' AND '),join='FROM workbench_knowledge_documents d JOIN workbench_knowledge_libraries l ON l.id=d.library_id AND l.owner_id=d.owner_id';
 const nameLike=(field:string)=>propertyNames.map(name=>`${field} LIKE '%${name}%'`).join(' OR ');
 const property=`(${nameLike('l.name')} OR ${nameLike('d.title')} OR ${nameLike('d.file_name')} OR EXISTS (SELECT 1 FROM workbench_knowledge_chunks hint WHERE hint.owner_id=d.owner_id AND hint.document_id=d.id AND (${nameLike('hint.heading')})))`;
 const documents=(await db.prepare(`SELECT d.id,d.library_id,l.name AS library_name,d.title,d.file_name,d.updated_at,d.source_version,d.source_hash,d.content_version,d.chunk_count,d.strategy ${join} WHERE ${authorized} AND ${property} ORDER BY d.updated_at DESC,d.id LIMIT ?`).bind(...values,MAX_DOCUMENTS+1).all<Document>()).results;
 const result:PropertySourcesResult={sources:[],complete:true,issues:[]};
 const issue=(message:string)=>{result.complete=false;result.issues.push(message);};
 if(documents.length>MAX_DOCUMENTS)issue('房源资料数量超过本次读取上限，结果未覆盖全部资料。');
 const loaded=new Map<string,Document>();let characters=0;
 for(const document of documents.slice(0,MAX_DOCUMENTS)){
  let text:string;
  try{
   if(document.source_version){
    const pages=(await db.prepare(`SELECT s.ordinal,s.text,s.hash,s.length FROM workbench_knowledge_sources s JOIN workbench_knowledge_documents d ON d.id=s.document_id AND d.owner_id=s.owner_id JOIN workbench_knowledge_libraries l ON l.id=d.library_id AND l.owner_id=d.owner_id WHERE ${authorized} AND d.id=? AND d.content_version=? AND d.source_version=? AND s.version=d.source_version ORDER BY s.ordinal LIMIT 9`).bind(...values,document.id,document.content_version,document.source_version).all<SourcePage>()).results;
    text=pages.map(page=>page.text).join('');
    if(!pages.length||pages.length>8||!document.source_hash||text.length>MAX_SOURCE_CHARACTERS||!text.trim()||pages.some((page,index)=>page.ordinal!==index||page.hash!==document.source_hash||page.length!==text.length)||await digest(text)!==document.source_hash)throw new Error('source integrity');
   }else{
    const chunks=(await db.prepare(`SELECT c.ordinal,c.parent_ordinal,c.kind,c.heading,c.text FROM workbench_knowledge_chunks c JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id JOIN workbench_knowledge_libraries l ON l.id=d.library_id AND l.owner_id=d.owner_id WHERE ${authorized} AND d.id=? AND d.content_version=? AND d.source_version IS NULL ORDER BY c.ordinal LIMIT ?`).bind(...values,document.id,document.content_version,MAX_CHUNKS+1).all<Chunk>()).results;
    if(!validLegacy(document,chunks))throw new Error('legacy coverage');
    const recovered=reconstruct(chunks);text=recovered.text;
    if(!recovered.complete||!text.trim())throw new Error('legacy incomplete');
   }
  }catch{issue(`“${document.file_name||document.title}”的当前解析正文未通过完整性校验，本次未使用。`);continue;}
  if(characters+text.length>MAX_TOTAL_CHARACTERS){issue('房源正文超过本次读取容量，结果未覆盖全部资料。');break;}
  characters+=text.length;loaded.set(document.id,document);
  result.sources.push({documentId:document.id,title:document.title,fileName:document.file_name,libraryId:document.library_id,libraryName:document.library_name,text,updatedAt:document.updated_at});
 }
 if(loaded.size){
  // Recheck the same authorization and active version after reading; never reuse a stale source.
  const current=(await db.prepare(`SELECT d.id,d.library_id,l.name AS library_name,d.title,d.file_name,d.source_version,d.source_hash,d.content_version,d.chunk_count,d.strategy ${join} WHERE ${authorized} AND d.id IN (SELECT value FROM json_each(?))`).bind(...values,JSON.stringify([...loaded.keys()])).all<Document>()).results;
  const safe=new Set(current.filter(row=>{const before=loaded.get(row.id)!;return row.library_id===before.library_id&&row.library_name===before.library_name&&row.title===before.title&&row.file_name===before.file_name&&row.source_version===before.source_version&&row.source_hash===before.source_hash&&row.content_version===before.content_version&&row.chunk_count===before.chunk_count&&row.strategy===before.strategy;}).map(row=>row.id));
  if(safe.size!==loaded.size){result.sources=result.sources.filter(source=>safe.has(source.documentId));issue('房源资料或权限在读取期间发生变化，请重新查询。');}
 }
 return result;
}
