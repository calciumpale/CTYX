import {createKnowledgeRechunk, sourceStatements, configValue} from './knowledge-library-rechunk.ts';
import type {KnowledgeChunkConfig} from './knowledge-chunking-config.ts';
import {isKnowledgeLibraryDepartment, type KnowledgeDepartmentId, type KnowledgeLibraryDepartment} from './knowledge-department-scope.ts';
import { DomainError } from './domain.ts';
import { tokenizeKnowledge } from './knowledge-library-chunks.ts';
import { cosineSimilarity, validateVectors } from './talktrack-vectors.ts';
import { KNOWLEDGE_CHUNK_LIMIT, KNOWLEDGE_SEARCHABLE_LIMIT, KNOWLEDGE_TEXT_LIMIT } from './knowledge-library-types.ts';
import type { KnowledgeChunk, KnowledgeChunkDraft, KnowledgeChunkStrategy, KnowledgeDocument, KnowledgeHit, KnowledgeLibrary, KnowledgeLibrarySnapshot, KnowledgeRetrievalMode, KnowledgeSearchResult } from './knowledge-library-types.ts';

export interface DocumentRow {content_version:number;source_version:string|null;source_hash:string|null;applied_config:string|null;upload_request_id:string|null;upload_hash:string|null;current_rechunk_job_id:string|null; id:string;owner_id:string;library_id:string;title:string;file_name:string;strategy:KnowledgeChunkStrategy;status:KnowledgeDocument['status'];chunk_count:number;indexed_count:number;error:string|null;model_key:string|null;generation:number;dimension:number|null;index_token:string|null;index_until:string|null;updated_at:string }
interface ChunkRow { id:string;owner_id:string;document_id:string;ordinal:number;parent_ordinal:number|null;kind:KnowledgeChunkDraft['kind'];text:string;heading:string;vector_json:string|null;vector_model:string|null }
type PublicChunkRow=Pick<ChunkRow,'id'|'ordinal'|'parent_ordinal'|'kind'|'text'|'heading'>;
interface CandidateRow extends ChunkRow {title:string;file_name:string;library_name:string;updated_at:string;context:string|null;rank?:number}
type CandidateKey=Pick<CandidateRow,'id'|'document_id'|'ordinal'|'parent_ordinal'|'rank'>;
interface ScanRow {id:string;title:string;heading:string;text:string;vector_json:string|null}
// Keep each JSON binding well below D1's 2 MB string limit, including CJK UTF-8 expansion.
export function jsonPages(rows:unknown[]):string[]{
 const pages:string[]=[],encoder=new TextEncoder();let items:string[]=[],bytes=2;
 for(const row of rows){const item=JSON.stringify(row),size=encoder.encode(item).byteLength+1;
  if(items.length&&bytes+size>750_000){pages.push(`[${items.join(',')}]`);items=[];bytes=2;}
  items.push(item);bytes+=size;
 }
 if(items.length)pages.push(`[${items.join(',')}]`);return pages;
}
const stamp=()=>new Date().toISOString();
const clean=(value:unknown,max:number,label:string)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw new DomainError(`${label}格式无效`);return value.trim();};
const compact=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const publicChunk=(row:PublicChunkRow):KnowledgeChunk=>({id:row.id,ordinal:row.ordinal,parentOrdinal:row.parent_ordinal,kind:row.kind,text:row.text,heading:row.heading});
export const publicDocument=(row:DocumentRow,modelKey?:string|null):KnowledgeDocument=>{const outdated=!!modelKey&&!!row.model_key&&row.model_key!==modelKey;return{contentVersion:row.content_version??1,sourceAvailable:!!row.source_version,appliedConfig:row.applied_config ? configValue(row.applied_config,row.strategy) : undefined,id:row.id,libraryId:row.library_id,title:row.title,fileName:row.file_name,strategy:row.strategy,status:outdated?'pending':row.status,chunkCount:row.chunk_count,indexedCount:outdated?0:row.indexed_count,error:outdated?'向量模型已变化，请重新建立索引':row.error,updatedAt:row.updated_at};};
const candidateSelect="SELECT c.id,c.owner_id,c.document_id,c.ordinal,c.parent_ordinal,c.kind,c.text,c.heading,d.title,d.file_name,d.updated_at,l.name AS library_name,p.text AS context FROM workbench_knowledge_chunks c JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id JOIN workbench_knowledge_libraries l ON l.id=d.library_id AND l.owner_id=d.owner_id LEFT JOIN workbench_knowledge_chunks p ON p.owner_id=c.owner_id AND p.document_id=c.document_id AND p.ordinal=c.parent_ordinal AND p.kind='parent'";
const candidateKeySelect='SELECT c.id,c.document_id,c.ordinal,c.parent_ordinal FROM workbench_knowledge_chunks c JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id';

export function createKnowledgeLibraryStore(db:D1Database,ownerId:string,options?:{departmentId?:KnowledgeDepartmentId|null}){
 const department=options?.departmentId;
 if(department!==undefined&&department!==null&&!['zs','yy','yl','ch','wl'].includes(department))throw new DomainError('资料库部门范围无效');
 const libraryScope=department===undefined?'':` AND department_id IN ('shared','${department??'shared'}')`;
 const documentScope=department===undefined?'':` AND library_id IN (SELECT id FROM workbench_knowledge_libraries WHERE owner_id=workbench_knowledge_documents.owner_id${libraryScope})`;
 const searchScope=department===undefined?'':` AND d.library_id IN (SELECT id FROM workbench_knowledge_libraries WHERE owner_id=d.owner_id${libraryScope})`;
 if(!ownerId)throw new DomainError('请先登录',401);
 async function ownLibrary(id:string){const row=await db.prepare(`SELECT * FROM workbench_knowledge_libraries WHERE owner_id=? AND id=?${libraryScope}`).bind(ownerId,id).first<{id:string;name:string;default_config:string|null;version:number;department_id:KnowledgeLibraryDepartment}>();if(!row)throw new DomainError('知识库不存在',404);return row;}
 async function ownDocument(id:string){const row=await db.prepare(`SELECT * FROM workbench_knowledge_documents WHERE owner_id=? AND id=?${documentScope}`).bind(ownerId,id).first<DocumentRow>();if(!row)throw new DomainError('文档不存在',404);return row;}
 async function snapshot(modelKey?:string|null):Promise<Pick<KnowledgeLibrarySnapshot,'libraries'|'documents'>>{
  const libraries=await db.prepare(`SELECT l.id,l.name,l.default_config,l.version,l.department_id,COUNT(d.id) AS documentCount FROM workbench_knowledge_libraries l LEFT JOIN workbench_knowledge_documents d ON d.library_id=l.id AND d.owner_id=l.owner_id WHERE l.owner_id=?${libraryScope} GROUP BY l.id ORDER BY l.created_at,l.id`).bind(ownerId).all<KnowledgeLibrary & {default_config:string|null;department_id:KnowledgeLibraryDepartment}>();
  const documents=await db.prepare(`SELECT * FROM workbench_knowledge_documents WHERE owner_id=?${documentScope} ORDER BY updated_at DESC,id`).bind(ownerId).all<DocumentRow>();
  return{libraries:libraries.results.map(row=>({id:row.id,name:row.name,documentCount:row.documentCount,version:row.version,departmentId:row.department_id,defaultConfig:configValue(row.default_config)})),documents:await Promise.all(documents.results.map(async row=>({...publicDocument(row,modelKey),...(row.current_rechunk_job_id?{rechunkJob:await extension.getJob(row.current_rechunk_job_id)}:{})})))};
 }
 async function createLibrary(name:string,departmentId:KnowledgeLibraryDepartment='shared'):Promise<KnowledgeLibrary>{if(!isKnowledgeLibraryDepartment(departmentId))throw new DomainError('资料库部门无效');const normalized=clean(name,100,'知识库名称'),id=`kl-${crypto.randomUUID()}`;await db.prepare('INSERT INTO workbench_knowledge_libraries(id,owner_id,name,created_at,department_id) VALUES (?,?,?,?,?)').bind(id,ownerId,normalized,stamp(),departmentId).run();return{id,name:normalized,documentCount:0,version:1,defaultConfig:configValue(null),departmentId};}
 async function renameLibrary(id:string,name:string){await ownLibrary(id);const normalized=clean(name,100,'知识库名称');const result=await db.prepare('UPDATE workbench_knowledge_libraries SET name=? WHERE owner_id=? AND id=?').bind(normalized,ownerId,id).run();if(!result.meta.changes)throw new DomainError('知识库不存在',404);}
 async function addDocument(input:{libraryId:string;title:string;fileName:string;strategy:KnowledgeChunkStrategy;chunks:KnowledgeChunkDraft[];source?:string;config?:KnowledgeChunkConfig;requestId?:string;intentHash?:string}):Promise<KnowledgeDocument>{
  await ownLibrary(input.libraryId);const title=clean(input.title,200,'文档名称'),fileName=clean(input.fileName,255,'文件名');
  if(!['flat','parent-child'].includes(input.strategy)||!Array.isArray(input.chunks)||!input.chunks.length||input.chunks.length>KNOWLEDGE_CHUNK_LIMIT)throw new DomainError(`切分策略或片段数量无效，每份文档最多${KNOWLEDGE_CHUNK_LIMIT}个片段`);
  const ordinals=new Map<number,KnowledgeChunkDraft>(),parentsWithChildren=new Set<number>();let size=0;
  for(const chunk of input.chunks){if(!chunk||!Number.isSafeInteger(chunk.ordinal)||chunk.ordinal<0||ordinals.has(chunk.ordinal)||!['flat','parent','child'].includes(chunk.kind)||typeof chunk.heading!=='string'||chunk.heading.length>300)throw new DomainError('文档片段格式无效');clean(chunk.text,16000,'片段正文');size+=chunk.text.length;ordinals.set(chunk.ordinal,chunk);if(chunk.kind==='child'&&chunk.parentOrdinal!==null)parentsWithChildren.add(chunk.parentOrdinal);}
  if(size>KNOWLEDGE_TEXT_LIMIT*3)throw new DomainError('文档切分后的正文过长');
  for(const chunk of input.chunks){
   if(input.strategy==='flat'?(chunk.kind!=='flat'||chunk.parentOrdinal!==null):(chunk.kind==='flat'||chunk.kind==='parent'&&chunk.parentOrdinal!==null||chunk.kind==='child'&&(!Number.isSafeInteger(chunk.parentOrdinal)||ordinals.get(chunk.parentOrdinal!)?.kind!=='parent')))throw new DomainError('父子片段关系无效');
   if(chunk.kind==='parent'&&!parentsWithChildren.has(chunk.ordinal))throw new DomainError('父片段缺少可检索的子片段');
  }
  const id=`kd-${crypto.randomUUID()}`,time=stamp(),searchable=input.chunks.filter(chunk=>chunk.kind!=='parent');if(!searchable.length)throw new DomainError('文档没有可检索片段');
  const statements=[db.prepare("INSERT INTO workbench_knowledge_documents(id,owner_id,library_id,title,file_name,strategy,chunk_count,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM workbench_knowledge_libraries WHERE owner_id=? AND id=?)").bind(id,ownerId,input.libraryId,title,fileName,input.strategy,searchable.length,time,ownerId,input.libraryId)];
  const chunkRows=input.chunks.map(chunk=>({id:`kc-${crypto.randomUUID()}`,ordinal:chunk.ordinal,parentOrdinal:chunk.parentOrdinal,kind:chunk.kind,text:chunk.text,heading:chunk.heading}));
  for(const page of jsonPages(chunkRows))statements.push(db.prepare("INSERT INTO workbench_knowledge_chunks(id,owner_id,document_id,ordinal,parent_ordinal,kind,text,heading) SELECT json_extract(j.value,'$.id'),?,?,json_extract(j.value,'$.ordinal'),json_extract(j.value,'$.parentOrdinal'),json_extract(j.value,'$.kind'),json_extract(j.value,'$.text'),json_extract(j.value,'$.heading') FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM workbench_knowledge_documents WHERE owner_id=? AND id=?)").bind(ownerId,id,page,ownerId,id));
  const indexRows=chunkRows.filter(chunk=>chunk.kind!=='parent').map(chunk=>({id:chunk.id,tokens:tokenizeKnowledge(`${title} ${chunk.heading} ${chunk.text}`,{unique:false}).join(' ')}));
  for(const page of jsonPages(indexRows))statements.push(db.prepare("INSERT INTO workbench_knowledge_fts(chunk_id,owner_id,tokens) SELECT json_extract(j.value,'$.id'),?,json_extract(j.value,'$.tokens') FROM json_each(?) j WHERE EXISTS (SELECT 1 FROM workbench_knowledge_chunks c WHERE c.owner_id=? AND c.document_id=? AND c.id=json_extract(j.value,'$.id'))").bind(ownerId,page,ownerId,id));
  if(input.source!==undefined){
   const source=await sourceStatements(db,ownerId,id,input.source);
   statements.push(...source.statements,db.prepare('UPDATE workbench_knowledge_documents SET source_version=?,source_hash=?,applied_config=?,upload_request_id=?,upload_hash=? WHERE owner_id=? AND id=?').bind(source.version,source.hash,input.config ? JSON.stringify(input.config) : null,input.requestId??null,input.intentHash??null,ownerId,id));
  }
  // D1 batches are transactional: chunks and FTS become visible together, or all are rolled back.
  await db.batch(statements);return publicDocument(await ownDocument(id));
 }
 async function removeDocument(id:string,version?:number){const doc=await ownDocument(id);if(version!==undefined&&(!Number.isSafeInteger(version)||version!==doc.content_version))throw new DomainError('资料版本已变化',409);try{await db.batch([
  ...(version===undefined?[]:[db.prepare("SELECT CASE WHEN EXISTS (SELECT 1 FROM workbench_knowledge_documents WHERE owner_id=? AND id=? AND content_version=?) THEN 1 ELSE json('knowledge delete version conflict') END").bind(ownerId,id,version)]),
  db.prepare('DELETE FROM workbench_knowledge_fts WHERE owner_id=? AND chunk_id IN (SELECT id FROM workbench_knowledge_chunks WHERE owner_id=? AND document_id=?)').bind(ownerId,ownerId,id),
  db.prepare('DELETE FROM workbench_knowledge_chunks WHERE owner_id=? AND document_id=?').bind(ownerId,id),
  db.prepare('DELETE FROM workbench_knowledge_documents WHERE owner_id=? AND id=?').bind(ownerId,id),
 ]);}catch(error){if(version!==undefined&&(await ownDocument(id)).content_version!==version)throw new DomainError('资料版本已变化',409);throw error;}}
 async function chunks(id:string):Promise<KnowledgeChunk[]>{await ownDocument(id);const rows=await db.prepare('SELECT id,ordinal,parent_ordinal,kind,text,heading FROM workbench_knowledge_chunks WHERE owner_id=? AND document_id=? ORDER BY ordinal').bind(ownerId,id).all<PublicChunkRow>();return rows.results.map(publicChunk);}

 async function indexDocument(id:string,modelKey:string,embed:(texts:string[])=>Promise<number[][]>):Promise<KnowledgeDocument>{
  clean(modelKey,1024,'向量模型标识');let row=await ownDocument(id);const switched=row.model_key!==modelKey;
  if(!switched&&row.status==='ready')return publicDocument(row);
  const token=crypto.randomUUID(),until=new Date(Date.now()+120000).toISOString(),time=stamp();
  const acquire=switched?db.prepare("UPDATE workbench_knowledge_documents SET model_key=?,generation=generation+1,index_token=?,index_until=?,dimension=NULL,indexed_count=0,status='pending',error=NULL,updated_at=? WHERE owner_id=? AND id=? AND generation=? AND model_key IS ?").bind(modelKey,token,until,time,ownerId,id,row.generation,row.model_key):db.prepare("UPDATE workbench_knowledge_documents SET index_token=?,index_until=?,status='pending',error=NULL,updated_at=? WHERE owner_id=? AND id=? AND generation=? AND model_key=? AND (index_token IS NULL OR index_until<=?)").bind(token,until,time,ownerId,id,row.generation,modelKey,time);
  const guard='SELECT 1 FROM workbench_knowledge_documents WHERE owner_id=? AND id=? AND model_key=? AND generation=? AND index_token=?';const generation=row.generation+(switched?1:0),guardValues=[ownerId,id,modelKey,generation,token];
  const acquired=await db.batch([acquire,...(switched?[db.prepare(`UPDATE workbench_knowledge_chunks SET vector_json=NULL,vector_model=NULL WHERE owner_id=? AND document_id=? AND EXISTS (${guard})`).bind(ownerId,id,...guardValues)]:[])]);
  if(!acquired[0].meta.changes)return publicDocument(await ownDocument(id));
  row=await ownDocument(id);
  if(row.index_token!==token||row.model_key!==modelKey||row.generation!==generation)return publicDocument(row);
  const batch=(await db.prepare("SELECT * FROM workbench_knowledge_chunks WHERE owner_id=? AND document_id=? AND kind!='parent' AND (vector_json IS NULL OR vector_model IS NOT ?) ORDER BY ordinal LIMIT 16").bind(ownerId,id,modelKey).all<ChunkRow>()).results;
  try{
   const vectors=batch.length?validateVectors(await embed(batch.map(chunk=>`${chunk.heading?chunk.heading+'\n':''}${chunk.text}`)),batch.length):[];
   const dimension=vectors[0]?.length??row.dimension;if(row.dimension&&dimension!==row.dimension)throw new Error('dimension mismatch');
   const statements=batch.map((chunk,i)=>db.prepare(`UPDATE workbench_knowledge_chunks SET vector_json=?,vector_model=? WHERE owner_id=? AND document_id=? AND id=? AND text=? AND EXISTS (${guard})`).bind(JSON.stringify(vectors[i]),modelKey,ownerId,id,chunk.id,chunk.text,...guardValues));
   const count="(SELECT COUNT(*) FROM workbench_knowledge_chunks c WHERE c.owner_id=workbench_knowledge_documents.owner_id AND c.document_id=workbench_knowledge_documents.id AND c.kind!='parent' AND c.vector_model=workbench_knowledge_documents.model_key AND c.vector_json IS NOT NULL)";
   statements.push(db.prepare(`UPDATE workbench_knowledge_documents SET dimension=?,indexed_count=${count},status=CASE WHEN ${count}=chunk_count THEN 'ready' ELSE 'pending' END,error=NULL,index_token=NULL,index_until=NULL,updated_at=? WHERE owner_id=? AND id=? AND model_key=? AND generation=? AND index_token=?`).bind(dimension??null,stamp(),...guardValues));
   await db.batch(statements);
  }catch{
   await db.prepare("UPDATE workbench_knowledge_documents SET status='error',error='向量索引暂未完成，请检查向量服务与模型维度后重试；关键词检索仍可使用',index_token=NULL,index_until=NULL,updated_at=? WHERE owner_id=? AND id=? AND model_key=? AND generation=? AND index_token=?").bind(stamp(),...guardValues).run();
  }
  return publicDocument(await ownDocument(id));
 }

 async function search(input:{query:string;libraryId?:string;libraryIds?:string[];mode:KnowledgeRetrievalMode;modelKey?:string;embed?:()=>Promise<number[]>;limit?:number}):Promise<KnowledgeSearchResult>{
  const query=clean(input.query,2000,'检索问题');if(!['hybrid','bm25','vector'].includes(input.mode))throw new DomainError('检索方式无效');
  if(input.libraryId&&input.libraryIds!==undefined)throw new DomainError('请使用单个知识库或知识库列表');
  const allowlist=input.libraryIds;
  if(allowlist!==undefined){
   if(!Array.isArray(allowlist)||allowlist.length>20||allowlist.some(id=>typeof id!=='string'||!id||id.length>140))throw new DomainError('最多选择20个有效知识库');
   // An explicit empty allowlist is closed, never shorthand for all owner content.
   if(!allowlist.length)return{hits:[],mode:input.mode,notice:null};
   const ids=[...new Set(allowlist)];
   const owned=await db.prepare(`SELECT COUNT(*) AS total FROM workbench_knowledge_libraries WHERE owner_id=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(ownerId,...ids).first<{total:number}>();
   for(const id of ids)await ownLibrary(id);
   if(owned?.total!==ids.length)throw new DomainError('知识库不存在或无权使用',404);
  }
  if(input.libraryId)await ownLibrary(input.libraryId);
  const selectedIds=allowlist?[...new Set(allowlist)]:undefined;
  const limit=Math.max(1,Math.min(20,Math.trunc(input.limit||5))),values=[ownerId,...(input.libraryId?[input.libraryId]:selectedIds??[])],scope=`c.owner_id=?${input.libraryId?' AND d.library_id=?':selectedIds?` AND d.library_id IN (${selectedIds.map(()=>'?').join(',')})`:''} AND c.kind!='parent'${searchScope}`;
  // Hold only lightweight keys for the corpus and FTS rankings; text and vectors are paged below.
  const corpus=(await db.prepare(`${candidateKeySelect} WHERE ${scope} ORDER BY d.updated_at DESC,c.document_id,c.ordinal LIMIT ?`).bind(...values,KNOWLEDGE_SEARCHABLE_LIMIT+1).all<CandidateKey>()).results;
  const notices:string[]=[];if(corpus.length>KNOWLEDGE_SEARCHABLE_LIMIT)notices.push(`当前范围超过${KNOWLEDGE_SEARCHABLE_LIMIT}个检索片段，向量和精确词匹配仅扫描最近${KNOWLEDGE_SEARCHABLE_LIMIT}个；可选择单个知识库缩小范围`);
  const candidates=new Map(corpus.slice(0,KNOWLEDGE_SEARCHABLE_LIMIT).map(row=>[row.id,row])),lexical=new Map<string,number>(),dense=new Map<string,number>();
  const exactMatches=new Set<string>(),needle=compact(query);let mode=input.mode,queryVector:number[]|undefined;
  if(input.mode!=='vector'){
   const tokens=[...new Set(tokenizeKnowledge(query))].slice(0,64),expression=tokens.map(token=>`"${token.replaceAll('"','""')}"`).join(' OR ');
   if(expression){
    // CROSS JOIN keeps FTS as the outer scan; otherwise SQLite may repeat MATCH for every chunk.
    const fts=(await db.prepare(`SELECT -bm25(workbench_knowledge_fts) AS rank,c.id,c.document_id,c.ordinal,c.parent_ordinal FROM workbench_knowledge_fts CROSS JOIN workbench_knowledge_chunks c ON c.id=workbench_knowledge_fts.chunk_id AND c.owner_id=workbench_knowledge_fts.owner_id JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id WHERE workbench_knowledge_fts MATCH ? AND ${scope} ORDER BY bm25(workbench_knowledge_fts),c.id LIMIT ?`).bind(expression,...values,KNOWLEDGE_SEARCHABLE_LIMIT).all<CandidateKey>()).results;
    for(const row of fts){candidates.set(row.id,row);lexical.set(row.id,row.rank??0);}
   }
  }
  if(input.mode!=='bm25'){
   if(!input.modelKey||!input.embed){notices.push('未配置向量服务，请在设置中配置并建立文档向量索引');if(input.mode==='hybrid')mode='bm25';}
   else {
    const indexed=await db.prepare(`SELECT COUNT(*) AS total FROM workbench_knowledge_chunks c JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id WHERE ${scope} AND c.vector_model=? AND d.model_key=? AND c.vector_json IS NOT NULL`).bind(...values,input.modelKey,input.modelKey).first<{total:number}>();
    if(!indexed?.total){notices.push('当前模型尚无可用文档向量，请建立或重建索引');if(input.mode==='hybrid')mode='bm25';}
    else try{
    queryVector=validateVectors([await input.embed()],1)[0];
    if(indexed.total<corpus.length)notices.push('部分文档的向量尚未就绪；已完成片段可参与向量检索，关键词检索不受影响');
    }catch{notices.push('向量服务暂不可用，请检查配置后重试');if(input.mode==='hybrid')mode='bm25';}
   }
  }
  const ids=corpus.slice(0,KNOWLEDGE_SEARCHABLE_LIMIT).map(row=>row.id);let incompatible=false;
  if(input.mode!=='vector'||queryVector)try{
   // Four 40-row SELECTs per request: 6000 vectors fit the free-tier 50-query budget,
   // while even 8192-dimensional vectors stay below D1's 50 MB response limit.
   for(let at=0;at<ids.length;at+=160){
    const statements=[];
    for(let page=at;page<Math.min(at+160,ids.length);page+=40){const batch=ids.slice(page,page+40);
     const textFields=input.mode==='vector'?"'' AS title,'' AS heading,'' AS text":'d.title,c.heading,c.text';
     const vectorField=queryVector?'CASE WHEN c.vector_model=? AND d.model_key=? THEN c.vector_json END':'NULL';
     statements.push(db.prepare(`SELECT c.id,${textFields},${vectorField} AS vector_json FROM workbench_knowledge_chunks c JOIN workbench_knowledge_documents d ON d.id=c.document_id AND d.owner_id=c.owner_id WHERE c.owner_id=? AND c.id IN (${batch.map(()=>'?').join(',')})`).bind(...(queryVector?[input.modelKey!,input.modelKey!]:[]),ownerId,...batch));
    }
    const pages=await db.batch<ScanRow>(statements);
    for(const page of pages)for(const row of page.results){
     if(input.mode!=='vector'&&needle&&compact(`${row.title} ${row.heading} ${row.text}`).includes(needle)){exactMatches.add(row.id);if(!lexical.has(row.id))lexical.set(row.id,0);}
     if(queryVector&&row.vector_json)try{const score=cosineSimilarity(queryVector,JSON.parse(row.vector_json));if(score>0.15)dense.set(row.id,score);}catch{incompatible=true;}
    }
   }
  }catch(error){
   if(!queryVector)throw error;
   dense.clear();notices.push('向量检索暂不可用，请检查配置后重试');if(input.mode==='hybrid')mode='bm25';
  }
  if(incompatible)notices.push('部分片段的向量维度不一致，请重建相应文档索引');
  const exact=(id:string)=>exactMatches.has(id)?1:0;
  const keywordOrder=[...lexical].sort((a,b)=>exact(b[0])-exact(a[0])||b[1]-a[1]||a[0].localeCompare(b[0])).map(([id])=>id),vectorOrder=[...dense].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([id])=>id);
  const scores=new Map<string,number>();for(const order of mode==='bm25'?[keywordOrder]:mode==='vector'?[vectorOrder]:[keywordOrder,vectorOrder])order.forEach((id,i)=>scores.set(id,(scores.get(id)??0)+1/(60+i+1)));
  const selected:string[]=[],parents=new Set<string>();for(const [id] of [...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))){const row=candidates.get(id)!;const key=`${row.document_id}:${row.parent_ordinal??row.ordinal}`;if(parents.has(key))continue;parents.add(key);selected.push(id);if(selected.length>=limit)break;}
  // Load full text and parent context only for winners; exclude concurrently deleted documents.
  const current=selected.length?(await db.prepare(`${candidateSelect} WHERE ${scope} AND c.id IN (${selected.map(()=>'?').join(',')})`).bind(...values,...selected).all<CandidateRow>()).results:[];
  const rows=new Map(current.map(row=>[row.id,row]));const hits:KnowledgeHit[]=selected.flatMap(id=>{const row=rows.get(id);return row?[{id:row.id,documentId:row.document_id,title:row.title,libraryName:row.library_name,fileName:row.file_name,heading:row.heading,ordinal:row.ordinal,matchedText:row.text,context:row.context??row.text,parent:row.parent_ordinal!==null,updatedAt:row.updated_at,bm25:lexical.get(id)??null,vector:dense.get(id)??null}]:[];});
  return{hits,mode,notice:notices.join('；')||null};
 }
 const extension=createKnowledgeRechunk(db,ownerId,{ownDocument,ownLibrary,addDocument});
 return{...extension,snapshot,createLibrary,renameLibrary,addDocument,removeDocument,chunks,indexDocument,search};
}
