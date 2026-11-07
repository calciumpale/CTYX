/** Contract files stay in the browser. Only the explicitly extracted text is sent for review. */
export interface ImportedContract {text:string;fileName:string;format:'txt'|'docx'|'pdf';pages?:number;warnings:string[];}
export interface ContractImportOptions {textLimit?:number;docxXmlLimit?:number;}
export const CONTRACT_FILE_LIMIT=10*1024*1024;
export const CONTRACT_TEXT_LIMIT=80_000;
const XML_LIMIT=2*1024*1024;

const textLimitMessage=(textLimit:number)=>`合同文字超过 ${textLimit.toLocaleString('en-US')} 字符，请拆分合同后分别审核。`;

function checkedText(raw:string,textLimit:number):string {
  const text=raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
  if(!text)throw new Error('合同没有可读取的文字，请检查文件内容。');
  if(text.length>textLimit)throw new Error(textLimitMessage(textLimit));
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uFFFE\uFFFF]/.test(text))throw new Error('文件包含二进制内容或编码乱码，请转换为 UTF-8 TXT 后重试。');
  const privateChars=(text.match(/[\uE000-\uF8FF]/g)||[]).length;
  if(privateChars>Math.max(2,text.length*.02))throw new Error('文件文字编码无法可靠识别，可能存在乱码。请复制可读文字或转换文件后重试。');
  if(!/[\p{L}\p{N}]/u.test(text))throw new Error('合同中没有可识别的正文，请检查文件内容。');
  return text;
}

function decodeText(bytes:Uint8Array):{text:string;warnings:string[]} {
  if(bytes[0]===255&&bytes[1]===254)return {text:new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(2)),warnings:[]};
  if(bytes[0]===254&&bytes[1]===255)return {text:new TextDecoder('utf-16be',{fatal:true}).decode(bytes.subarray(2)),warnings:[]};
  try{return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),warnings:[]};}
  catch {
    try{return {text:new TextDecoder('gb18030',{fatal:true}).decode(bytes),warnings:['文件按 GB18030 中文编码读取，请核对合同金额、名称和日期。']};}
    catch{throw new Error('无法识别文件编码，请另存为 UTF-8 TXT 后重试。');}
  }
}

interface ZipPart {name:string;offset:number;compressed:number;size:number;method:number;crc:number;}
function zipParts(bytes:Uint8Array):ZipPart[] {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u16=(at:number)=>view.getUint16(at,true),u32=(at:number)=>view.getUint32(at,true);
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65_557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===bytes.length){end=i;break;}
  if(end<0)throw new Error('DOCX 文件损坏，无法读取压缩目录。');
  const count=u16(end+10),directorySize=u32(end+12),directoryOffset=u32(end+16);
  if(u16(end+4)||u16(end+6)||count!==u16(end+8)||count===0xffff||directoryOffset===0xffffffff||directorySize===0xffffffff)throw new Error('暂不支持分卷或 ZIP64 DOCX，请另存为普通 DOCX。');
  if(count>2048||directoryOffset+directorySize>end)throw new Error('DOCX 压缩目录异常或文件数量过多。');
  const parts:ZipPart[]=[],names=new Set<string>();let at=directoryOffset,total=0;
  for(let i=0;i<count;i++) {
    if(at+46>end||u32(at)!==0x02014b50)throw new Error('DOCX 压缩目录损坏。');
    const flags=u16(at+8),method=u16(at+10),compressed=u32(at+20),size=u32(at+24),nameSize=u16(at+28),extra=u16(at+30),comment=u16(at+32),offset=u32(at+42);
    if(flags&1)throw new Error('无法读取加密 DOCX，请先解除密码保护。');
    if(size===0xffffffff||compressed===0xffffffff||offset===0xffffffff||at+46+nameSize+extra+comment>directoryOffset+directorySize)throw new Error('DOCX 压缩条目损坏或使用了不支持的 ZIP64。');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(at+46,at+46+nameSize));
    if(names.has(name))throw new Error('DOCX 存在重复文件条目，请重新另存文件。');
    names.add(name);total+=size;
    if(total>40*1024*1024||size>20*1024*1024)throw new Error('DOCX 解压后内容过大，请压缩图片或拆分合同。');
    if(offset+30>directoryOffset||u32(offset)!==0x04034b50||offset+30+u16(offset+26)+u16(offset+28)+compressed>directoryOffset)throw new Error('DOCX 压缩内容损坏。');
    parts.push({name,offset:offset+30+u16(offset+26)+u16(offset+28),compressed,size,method,crc:u32(at+16)});
    at+=46+nameSize+extra+comment;
  }
  if(at!==directoryOffset+directorySize)throw new Error('DOCX 压缩目录长度不一致。');
  return parts;
}

const crcTable=Array.from({length:256},(_,value)=>{let c=value;for(let i=0;i<8;i++)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Uint8Array):number{let crc=0xffffffff;for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
async function inflatePart(bytes:Uint8Array,part:ZipPart,xmlLimit:number):Promise<string> {
  if(part.size>xmlLimit||part.size>Math.max(64*1024,part.compressed*200))throw new Error('DOCX 正文解压大小或压缩比异常，请拆分或重新导出文件。');
  const input=bytes.subarray(part.offset,part.offset+part.compressed);let output:Uint8Array;
  if(part.method===0)output=input;
  else if(part.method===8){
    const {Inflate}=await import('fflate');const chunks:Uint8Array[]=[];let size=0;
    const inflater=new Inflate(chunk=>{size+=chunk.length;if(size>xmlLimit||size>part.size)throw new Error('DOCX 正文解压大小异常，已停止读取。');chunks.push(chunk);});
    // Small input chunks bound the memory needed even when central-directory sizes are forged.
    for(let at=0;at<input.length;at+=1024)inflater.push(input.subarray(at,at+1024),at+1024>=input.length);
    output=new Uint8Array(size);let at=0;for(const chunk of chunks){output.set(chunk,at);at+=chunk.length;}
  }else throw new Error('DOCX 使用了不支持的压缩格式，请重新另存为 DOCX。');
  if(output.length!==part.size||crc32(output)!==part.crc)throw new Error('DOCX 正文校验失败，文件可能已损坏。');
  return new TextDecoder('utf-8',{fatal:true}).decode(output);
}

function xmlEntities(text:string):string {
  return text.replace(/&([^;\s<]+);|&/g,(_,entity:string|undefined)=>{
    if(!entity)throw new Error('DOCX XML 中存在未转义的实体。');
    const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
    if(entity in named)return named[entity];
    const number=/^#x[0-9a-f]+$/i.test(entity)?parseInt(entity.slice(2),16):/^#\d+$/.test(entity)?Number(entity.slice(1)):NaN;
    if(!Number.isInteger(number)||number<1||number>0x10ffff||(number>=0xd800&&number<=0xdfff))throw new Error('DOCX XML 含有无法识别的实体。');
    return String.fromCodePoint(number);
  });
}

/** A text-only XML tokenizer: no DOM insertion, external entities, relationships, or embedded content. */
function wordText(xml:string):{text:string;revisions:boolean} {
  if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('DOCX XML 含有不支持的外部实体。');
  const token=/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z_][\w.:-]*(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>|[^<]+/gy;
  const stack:string[]=[],out:string[]=[];let at=0,root='',closed=false,revisions=false;
  const local=(name:string)=>name.slice(name.lastIndexOf(':')+1);
  const close=(name:string)=>{if(stack.pop()!==name)throw new Error('DOCX XML 结构损坏。');const kind=local(name);if(kind==='delText')out.push(']');if(['p','tr'].includes(kind))out.push('\n');if(kind==='tc')out.push('\t');if(!stack.length)closed=true;};
  while(at<xml.length){
    token.lastIndex=at;const match=token.exec(xml);if(!match)throw new Error('DOCX XML 格式损坏。');const value=match[0];at=token.lastIndex;
    if(value.startsWith('<!--')||value.startsWith('<?'))continue;
    if(value.startsWith('<![CDATA[')){if(['t','delText'].includes(local(stack.at(-1)||'')))out.push(value.slice(9,-3));continue;}
    if(value.startsWith('<')){
      const name=/^<\/?([^\s/>]+)/.exec(value)![1];const kind=local(name);
      if(value.startsWith('</')){if(!/^<\/[^\s/>]+\s*>$/.test(value))throw new Error('DOCX XML 结束标签损坏。');close(name);continue;}
      if(closed)throw new Error('DOCX XML 包含多个根节点。');
      if(!stack.length){root=kind;if(!['document','hdr','ftr','footnotes','endnotes','comments'].includes(root)||!/(?:schemas\.openxmlformats\.org\/wordprocessingml\/2006\/main|purl\.oclc\.org\/ooxml\/wordprocessingml\/main)/.test(value))throw new Error('DOCX XML 正文命名空间无效。');}
      if(kind==='altChunk')throw new Error('合同含有不支持的外部正文（altChunk），请转换为 PDF 或 TXT 后审核。');
      stack.push(name);if(['ins','del','delText'].includes(kind))revisions=true;
      if(kind==='delText')out.push('[删除修订：');if(kind==='tab')out.push('\t');if(['br','cr'].includes(kind))out.push('\n');if(kind==='noBreakHyphen')out.push('‑');
      if(value.endsWith('/>'))close(name);
    }else if(['t','delText'].includes(local(stack.at(-1)||'')))out.push(xmlEntities(value));
    else if(!stack.length&&value.trim())throw new Error('DOCX XML 根节点外存在异常内容。');
  }
  if(stack.length||!root||!closed)throw new Error('DOCX XML 正文不完整。');
  return {text:out.join('').replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim(),revisions};
}

async function extractDocx(bytes:Uint8Array,textLimit:number,xmlLimit:number):Promise<{text:string;warnings:string[]}> {
  if(bytes[0]!==80||bytes[1]!==75)throw new Error('文件不是可读取的 DOCX，可能已加密或属于旧版 Word。请解除密码后另存为 DOCX。');
  const parts=zipParts(bytes),main=parts.find(part=>part.name==='word/document.xml');
  if(!main)throw new Error('DOCX 中没有找到合同正文，请检查文件格式。');
  const selected=[main,...parts.filter(part=>/^word\/(?:header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(part.name)).sort((a,b)=>a.name.localeCompare(b.name))];
  if(selected.length>64||selected.reduce((sum,part)=>sum+part.size,0)>8*1024*1024)throw new Error('DOCX 文字附件解压后过大，请拆分合同。');
  const blocks:string[]=[],warnings:string[]=[];let revisions=false;
  for(const part of selected){const extracted=wordText(await inflatePart(bytes,part,xmlLimit));if(part===main&&!extracted.text)throw new Error('DOCX 没有可读取的合同正文，可能是图片扫描件。请先 OCR 或补充正文。');revisions||=extracted.revisions;if(extracted.text)blocks.push(part===main?extracted.text:`【${part.name.includes('header')?'页眉':part.name.includes('footer')?'页脚':part.name.includes('comments')?'批注':part.name.includes('endnotes')?'尾注':'脚注'}】\n${extracted.text}`);}
  if(revisions)warnings.push('合同含有修订记录；删除修订已以文字标识保留，请确认最终生效版本。');
  if(parts.some(part=>/^word\/(?:media|embeddings)\//.test(part.name)))warnings.push('图片、扫描附件和嵌入对象没有可提取的文字，请补充其正文后再判断相关条款。');
  return {text:checkedText(blocks.join('\n\n'),textLimit),warnings};
}

interface TextPdfPage {getTextContent():Promise<{items:Array<{str?:string;hasEOL?:boolean}|unknown>}>;cleanup():void;}
export interface ContractTextPdf {numPages:number;getPage(page:number):Promise<TextPdfPage>;}
export async function collectContractPdfText(document:ContractTextPdf,{textLimit=CONTRACT_TEXT_LIMIT}:Pick<ContractImportOptions,'textLimit'>={}):Promise<{text:string;pages:number;warnings:string[]}> {
  if(!Number.isInteger(document.numPages)||document.numPages<1||document.numPages>200)throw new Error('PDF 最多支持 200 页，请拆分后分别审核。');
  const blocks:string[]=[],sparse:number[]=[];let characters=0;
  for(let number=1;number<=document.numPages;number++){
    const page=await document.getPage(number);
    try{
      const content=await page.getTextContent();const text=content.items.map(item=>{if(!item||typeof item!=='object'||!('str' in item)||typeof item.str!=='string')return '';return item.str+('hasEOL' in item&&item.hasEOL?'\n':' ');}).join('').replace(/[ \t]+\n/g,'\n').trim();
      if(!text)throw new Error(`PDF 第 ${number} 页没有可提取的文字，可能是扫描件或空白页。请先 OCR 或移除空白页后重试；本次不会审核不完整合同。`);
      checkedText(text,textLimit);if(text.replace(/\s/g,'').length<20)sparse.push(number);
      const block=`【第 ${number} 页】\n${text}`;characters+=block.length+(blocks.length?2:0);
      if(characters>textLimit)throw new Error(textLimitMessage(textLimit));
      blocks.push(block);
    }finally{page.cleanup();}
  }
  const warnings=['PDF 仅提取可复制的文字层，图片内容、手写签名和批注不参与初审。'];
  if(sparse.length)warnings.push(`第 ${sparse.join('、')} 页可提取文字较少，请核对是否有扫描图片或遗漏内容。`);
  return {text:checkedText(blocks.join('\n\n'),textLimit),pages:document.numPages,warnings};
}

async function extractPdf(bytes:Uint8Array,textLimit:number):Promise<{text:string;pages:number;warnings:string[]}> {
  if(!new TextDecoder().decode(bytes.subarray(0,1024)).includes('%PDF-'))throw new Error('文件不是有效的 PDF，请检查格式。');
  if(typeof window==='undefined')throw new Error('请在浏览器中导入 PDF。');
  const [pdf,worker,assets]=await Promise.all([import('pdfjs-dist'),import('pdfjs-dist/build/pdf.worker.min.mjs?url'),import('./contract-pdf-assets')]);
  pdf.GlobalWorkerOptions.workerSrc=worker.default;
  const task=pdf.getDocument({data:bytes,disableFontFace:true,useWorkerFetch:false,BinaryDataFactory:assets.ContractPdfBinaryDataFactory,useWasm:false,disableAutoFetch:true,disableStream:true,stopAtErrors:true,enableXfa:false});
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{
    const result=await Promise.race([
      task.promise.then(document=>collectContractPdfText(document,{textLimit})),
      new Promise<never>((_,reject)=>{timeout=setTimeout(()=>{reject(new Error('PDF 读取超时，请拆分或转换为 TXT 后重试。'));void task.destroy().catch(()=>{});},45_000);}),
    ]);
    return result;
  }catch(error){
    if(error instanceof Error&&(/Password/i.test(error.name)||/password|encrypted/i.test(error.message)))throw new Error('PDF 需要密码，请先解除密码保护后重新导入。');
    if(error instanceof Error&&(/InvalidPDF|MissingPDF|UnknownError|FormatError/.test(error.name)))throw new Error('PDF 无法可靠读取，可能损坏或文字编码不受支持，请转换为 TXT 后重试。');
    throw error;
  }finally{if(timeout)clearTimeout(timeout);await task.destroy().catch(()=>{});}
}

export async function importContractFile(file:File,{textLimit=CONTRACT_TEXT_LIMIT,docxXmlLimit=XML_LIMIT}:ContractImportOptions={}):Promise<ImportedContract> {
  if(!file.size)throw new Error('文件为空，请选择包含合同正文的文件。');
  if(file.size>CONTRACT_FILE_LIMIT)throw new Error('合同文件不能超过 10 MB，请压缩或拆分后重试。');
  const extension=file.name.split('.').pop()?.toLowerCase();
  if(!['txt','docx','pdf'].includes(extension||''))throw new Error('支持 TXT、DOCX 和可复制文字的 PDF；旧版 DOC 请另存为 DOCX。');
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(extension==='txt'){const result=decodeText(bytes);return {text:checkedText(result.text,textLimit),warnings:result.warnings,fileName:file.name,format:'txt'};}
  if(extension==='docx'){const result=await extractDocx(bytes,textLimit,docxXmlLimit);return {...result,fileName:file.name,format:'docx'};}
  const result=await extractPdf(bytes,textLimit);return {...result,fileName:file.name,format:'pdf'};
}
