import type {SalesScope} from './sales-scope.ts';
import { assertRevision, DomainError, executeAction, projectState } from './domain.ts';
import type { ApiResult, FollowupRecording, Role, WorkbenchState } from './types.ts';

export const MAX_RECORDING_BYTES=20*1024*1024;
export const MAX_MULTIPART_BYTES=MAX_RECORDING_BYTES+64*1024;
export interface RecordingForm {dealId:string;text:string;revision:number;audio:File;sourceOnly?:true;}
interface ValidatedAudio {name:string;mimeType:string;bytes:Uint8Array;}
export interface RecordingObjectStore {
  put(key:string,bytes:Uint8Array,options:{onlyIf:{etagDoesNotMatch:string};httpMetadata:{contentType:string}}):Promise<unknown>;
  delete(key:string):Promise<void>;
}
export interface RecordingPersistence {
  actorName?:string;salesScope?:SalesScope;
  load:()=>Promise<WorkbenchState>;
  save:(revision:number,state:WorkbenchState)=>Promise<void>;
  bucket:RecordingObjectStore;
}
const formats:Record<string,{mimeType:string;aliases:string[]}>= {
  mp3:{mimeType:'audio/mpeg',aliases:['audio/mpeg','audio/mp3','audio/x-mp3']},
  wav:{mimeType:'audio/wav',aliases:['audio/wav','audio/wave','audio/x-wav','audio/vnd.wave']},
  m4a:{mimeType:'audio/mp4',aliases:['audio/mp4','audio/m4a','audio/x-m4a','video/mp4']},
  aac:{mimeType:'audio/aac',aliases:['audio/aac','audio/aacp','audio/x-aac','audio/vnd.dlna.adts']},
  flac:{mimeType:'audio/flac',aliases:['audio/flac','audio/x-flac']},
  ogg:{mimeType:'audio/ogg',aliases:['audio/ogg','application/ogg']},
  webm:{mimeType:'audio/webm',aliases:['audio/webm','video/webm']},
};
const recordingId=/^recording-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ascii=(bytes:Uint8Array,at:number,length:number)=>new TextDecoder('latin1').decode(bytes.subarray(at,at+length));
function badAudio():never {throw new DomainError('录音格式与文件内容不一致，请选择有效的音频文件',415);}
function isMpegFrame(bytes:Uint8Array,at:number):boolean {
  return at+4<=bytes.length&&bytes[at]===255&&(bytes[at+1]&224)===224&&(bytes[at+1]&24)!==8&&(bytes[at+1]&6)!==0&&(bytes[at+2]&240)!==0&&(bytes[at+2]&240)!==240&&(bytes[at+2]&12)!==12;
}
function hasAudioHeader(extension:string,bytes:Uint8Array):boolean {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(extension==='wav') {
    if(bytes.length<44||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,4)!=='WAVE'||view.getUint32(4,true)>bytes.length-8)return false;
    let format=false,data=false;
    for(let at=12;at+8<=bytes.length;){const label=ascii(bytes,at,4);const size=view.getUint32(at+4,true);if(size>bytes.length-at-8)return false;if(label==='fmt '&&size>=16){const codec=view.getUint16(at+8,true);format=[1,3,6,7,17,65534].includes(codec)&&view.getUint16(at+10,true)>0&&view.getUint32(at+12,true)>0;}if(label==='data'&&size>0)data=true;at+=8+size+(size%2);}
    return format&&data;
  }
  if(extension==='mp3') {
    if(isMpegFrame(bytes,0))return true;
    if(bytes.length<14||ascii(bytes,0,3)!=='ID3'||![2,3,4].includes(bytes[3])||bytes.subarray(6,10).some(value=>value>127))return false;
    const size=(bytes[6]<<21)|(bytes[7]<<14)|(bytes[8]<<7)|bytes[9];const start=10+size+(bytes[3]===4&&(bytes[5]&16)?10:0);
    for(let at=start;at<Math.min(bytes.length-3,start+4096);at++)if(isMpegFrame(bytes,at))return true;
    return false;
  }
  if(extension==='m4a') {
    if(bytes.length<16||ascii(bytes,4,4)!=='ftyp')return false;
    const boxSize=view.getUint32(0);if(boxSize<16||boxSize>bytes.length||boxSize>4096)return false;
    return /M4A |M4B |isom|iso2|mp41|mp42|qt  /.test(ascii(bytes,8,boxSize-8));
  }
  if(extension==='aac') {
    if(bytes.length<7||bytes[0]!==255||(bytes[1]&246)!==240||((bytes[2]>>2)&15)>12)return false;
    const frameSize=((bytes[3]&3)<<11)|(bytes[4]<<3)|(bytes[5]>>5);return frameSize>=7&&frameSize<=bytes.length;
  }
  if(extension==='flac')return bytes.length>=42&&ascii(bytes,0,4)==='fLaC'&&(bytes[4]&127)===0&&bytes[5]===0&&bytes[6]===0&&bytes[7]===34;
  if(extension==='ogg') {
    if(bytes.length<28||ascii(bytes,0,4)!=='OggS'||bytes[4]!==0||bytes[26]===0)return false;
    const packet=27+bytes[26];if(packet>=bytes.length)return false;const header=ascii(bytes,packet,8);
    return header==='OpusHead'||header.startsWith('\x01vorbis')||header.startsWith('\x7fFLAC');
  }
  if(extension==='webm') {
    if(bytes.length<16||bytes[0]!==26||bytes[1]!==69||bytes[2]!==223||bytes[3]!==163)return false;
    const header=ascii(bytes,0,Math.min(bytes.length,65536));return header.includes('webm')&&(header.includes('A_OPUS')||header.includes('A_VORBIS'));
  }
  return false;
}
export async function validateRecording(file:File):Promise<ValidatedAudio> {
  if(file.size===0)throw new DomainError('录音文件为空，请重新选择');
  if(file.size>MAX_RECORDING_BYTES)throw new DomainError('录音大小不能超过20MB',413);
  const name=file.name.trim();
  if(!name||name.length>180||/[\\/\u0000-\u001f\u007f]/.test(name))throw new DomainError('录音文件名无效或过长，请重命名后上传');
  const extension=name.split('.').at(-1)?.toLowerCase()??'';const format=formats[extension];
  if(!format)throw new DomainError('支持 MP3、WAV、M4A、AAC、FLAC、OGG 和 WebM 录音',415);
  const declared=file.type.split(';')[0].trim().toLowerCase();
  if(declared&&declared!=='application/octet-stream'&&!format.aliases.includes(declared))badAudio();
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size||!hasAudioHeader(extension,bytes))badAudio();
  return {name,mimeType:format.mimeType,bytes};
}
/** Count every streamed byte, without retaining a second copy of the upload. */
export async function parseRecordingForm(request:Request):Promise<RecordingForm> {
  const contentType=request.headers.get('content-type')??'';
  if(!/^multipart\/form-data\s*;/i.test(contentType)||contentType.length>512)throw new DomainError('请使用录音上传表单提交文件',415);
  const advertised=request.headers.get('content-length');
  if(advertised&&(!/^\d+$/.test(advertised)||Number(advertised)>MAX_MULTIPART_BYTES))throw new DomainError('上传内容过大，请选择20MB以内的录音',413);
  if(!request.body)throw new DomainError('请选择录音文件');
  let size=0;let tooLarge=false;
  const limited=request.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){size+=chunk.byteLength;if(size>MAX_MULTIPART_BYTES){tooLarge=true;throw new DomainError('上传内容过大，请选择20MB以内的录音',413);}controller.enqueue(chunk);}}));
  let form:FormData;try{form=await new Response(limited,{headers:{'Content-Type':contentType}}).formData();}catch{if(tooLarge)throw new DomainError('上传内容过大，请选择20MB以内的录音',413);throw new DomainError('录音上传表单无效，请重新选择文件');}
  const allowed=new Set(['dealId','text','revision','audio','sourceOnly']);
  for(const key of form.keys())if(!allowed.has(key)||form.getAll(key).length!==1)throw new DomainError('录音上传参数不正确');
  const dealId=form.get('dealId');const text=form.get('text')??'';const revision=form.get('revision');const audio=form.get('audio');const sourceOnly=form.get('sourceOnly');
  if(sourceOnly!==null&&(sourceOnly!=='true'||text!==''))throw new DomainError('录音处理只接收原录音，请在整理结果中填写跟进记录');
  if(typeof dealId!=='string'||!dealId.trim()||dealId.length>100||typeof text!=='string'||text.length>5000||typeof revision!=='string'||!/^\d+$/.test(revision)||!Number.isSafeInteger(Number(revision)))throw new DomainError('跟进记录参数不正确，请刷新后重试');
  if(!audio||typeof audio==='string'||typeof audio.arrayBuffer!=='function')throw new DomainError('请选择录音文件');
  return {dealId:dealId.trim(),text:text.trim(),revision:Number(revision),audio,...(sourceOnly==='true'?{sourceOnly:true as const}:{})};
}
export async function recordingObjectKey(userId:string,id:string):Promise<string> {
  if(!recordingId.test(id))throw new DomainError('录音不存在或当前视角无权访问',404);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(userId)));
  return `followups/${Array.from(hash,byte=>byte.toString(16).padStart(2,'0')).join('')}/${id}`;
}
export async function saveRecordingNote(userId:string,role:Role,input:RecordingForm,deps:RecordingPersistence):Promise<ApiResult> {
  const state=await deps.load();assertRevision(state,input.revision);
  const audio=await validateRecording(input.audio);
  const recording:FollowupRecording={id:`recording-${crypto.randomUUID()}`,name:audio.name,size:audio.bytes.length,mimeType:audio.mimeType,...(input.sourceOnly?{sourceOnly:true as const}:{})};
  // The domain checks role visibility and text before any object can be written.
  const result=await executeAction(state,role,'deal_note',{dealId:input.dealId,text:input.text},{trustedRecording:recording,actorName:deps.actorName,salesScope:deps.salesScope});
  const key=await recordingObjectKey(userId,recording.id);
  const uploaded=await deps.bucket.put(key,audio.bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:audio.mimeType}});
  if(!uploaded)throw new DomainError('录音暂时无法保存，请重新上传',503);
  try {await deps.save(state.revision,result.state);}catch(error){
    try{await deps.bucket.delete(key);}catch{console.error('Follow-up recording cleanup failed');}
    throw error;
  }
  return {...result,state:projectState(result.state,role,deps.salesScope),message:input.sourceOnly?'原录音已保存':'录音及跟进记录已保存'};
}
/** Call only with a state projected to the current role. */
export function authorizedRecording(state:WorkbenchState,dealId:string,id:string):FollowupRecording {
  if(!recordingId.test(id))throw new DomainError('录音不存在或当前视角无权访问',404);
  const recording=state.deals.find(deal=>deal.id===dealId)?.notes.find(note=>note.recording?.id===id)?.recording;
  if(!recording)throw new DomainError('录音不存在或当前视角无权访问',404);
  return recording;
}
export function parseAudioRange(header:string,size:number):{offset:number;length:number} {
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  if(!match||(!match[1]&&!match[2]))throw new DomainError('请求的录音范围无效',416);
  const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
  const end=match[1]?(match[2]?Math.min(Number(match[2]),size-1):size-1):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start||(!match[1]&&Number(match[2])<=0))throw new DomainError('请求的录音范围无效',416);
  return {offset:start,length:end-start+1};
}
