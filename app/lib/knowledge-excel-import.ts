import type { CellObject, WorkSheet } from 'xlsx';
import { KNOWLEDGE_TEXT_LIMIT } from './knowledge-library-types.ts';
import { validateExcelArchive } from './knowledge-excel-archive.ts';

export type ExcelFormat = 'xlsx' | 'xls';
const MAX_SHEETS = 50, MAX_ROWS = 20_000, MAX_CELLS = 100_000;
const cfbSignature = [0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1];
const checkCharacters = (value: string) => {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFD\uFFFE\uFFFF]/.test(value)) throw new Error('Excel 含有无法可靠识别的文字或编码，请重新另存文件后导入。');
  return value.replace(/\r\n?/g,'\n');
};

/** Extract values only. Never evaluate formulas, follow links, or execute embedded content. */
export async function extractKnowledgeExcel(bytes: Uint8Array, format: ExcelFormat): Promise<{text:string;warnings:string[]}> {
  if (format === 'xlsx') await validateExcelArchive(bytes);
  else if (!cfbSignature.every((value,index) => bytes[index] === value)) throw new Error('文件不是有效的 XLS Excel 工作簿，请另存为 XLSX 后重试。');
  const [xlsx,codepage] = await Promise.all([import('xlsx'),import('xlsx/dist/cpexcel.full.mjs')]);
  xlsx.set_cptable(codepage);
  const options = {type:'array' as const,cellHTML:false,bookVBA:false,WTF:true};
  let book: ReturnType<typeof xlsx.read>;
  try {
    const metadata = xlsx.read(bytes,{...options,bookSheets:true});
    if (!metadata.SheetNames.length || metadata.SheetNames.length > MAX_SHEETS) throw new Error('Excel 最多支持 50 个工作表，请拆分后导入。');
    book = xlsx.read(bytes,{...options,cellFormula:true,cellText:true,cellDates:false,dateNF:'yyyy-mm-dd',sheetRows:MAX_ROWS+1});
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : '';
    if (/50 个工作表/.test(message)) throw cause;
    if (/encrypt|password|protected|FilePass/i.test(message)) throw new Error('Excel 文件已加密或需要密码，请先解除密码保护后导入。');
    throw new Error('Excel 无法完整读取，可能已损坏、加密或格式不受支持，请重新另存为 XLSX 后重试。');
  }
  const blocks:string[] = [], warnings:string[] = ['仅提取单元格文字；图片、图表、批注、嵌入对象与宏不参与解析。'];
  let characters=0,populated=0,formulas=false,missing=false,merged=false,hidden=false,errors=false,hiddenValues=false;
  const append = (text:string) => {
    characters += text.length + (blocks.length ? 1 : 0);
    if (characters > KNOWLEDGE_TEXT_LIMIT) throw new Error('Excel 文字超过 80,000 字符，请拆分工作表后分别导入。');
    blocks.push(text);
  };
  for (let index=0;index<book.SheetNames.length;index++) {
    const originalName=book.SheetNames[index],name=checkCharacters(originalName).replace(/\n/g,' ↵ '),sheet=book.Sheets[originalName] as WorkSheet | undefined;
    if (!sheet) throw new Error(`Excel 工作表“${name}”无法完整读取，请重新另存文件。`);
    for (const range of [sheet['!ref'],sheet['!fullref']]) {
      if (range && xlsx.utils.decode_range(range).e.r >= MAX_ROWS) throw new Error('Excel 工作表行数超过 20,000 行，请拆分后导入；本次未导入部分内容。');
    }
    const cells=Object.entries(sheet).filter(([address])=>/^[A-Z]+[1-9]\d*$/.test(address)).map(([address,value])=>({address,cell:value as CellObject,position:xlsx.utils.decode_cell(address)})).sort((a,b)=>a.position.r-b.position.r||a.position.c-b.position.c);
    populated += cells.length;
    if (populated>MAX_CELLS) throw new Error('Excel 非空单元格超过 100,000 个，请拆分工作簿后导入。');
    const rows=new Map<number,string[]>();
    for (const {address,cell,position} of cells) {
      if (position.r>=MAX_ROWS || position.c>=16_384) throw new Error('Excel 单元格范围过大，请整理有效区域或拆分后导入。');
      if (cell.v==null && !cell.f) continue;
      const displayValue=()=>{
        const formatted=cell.w || xlsx.utils.format_cell(cell);
        if (!formatted.trim() && cell.v!=null && String(cell.v).trim()) { hiddenValues=true; return String(cell.v); }
        return formatted;
      };
      let value:string;
      if (cell.f) {
        formulas=true;
        if (cell.v==null || cell.t==='z') { missing=true; value=`=${cell.f}（无缓存结果，未计算）`; }
        else value=`${displayValue()}（公式：=${cell.f}；保存结果）`;
      } else if (cell.t==='b') value=cell.v?'TRUE':'FALSE';
      else value=displayValue();
      if (cell.t==='e') errors=true;
      value=checkCharacters(value).replace(/\n/g,' ↵ ');
      if (!value.trim()) continue;
      const row=position.r+1;
      rows.set(row,[...(rows.get(row)||[]),`${address}=${value}`]);
    }
    if (!rows.size) { warnings.push(`工作表“${name}”没有可读取的单元格内容。`); continue; }
    const isHidden=Boolean(book.Workbook?.Sheets?.[index]?.Hidden); hidden ||= isHidden;
    append(`${blocks.length?'\n':''}## 工作表：${name}${isHidden?'（隐藏）':''}`);
    if (sheet['!merges']?.length) {
      merged=true;
      append(`合并单元格：${sheet['!merges'].map(range=>xlsx.utils.encode_range(range)).join('、')}（内容保留在原单元格，不填充空格）`);
    }
    for (const [number,values] of rows) append(`第${number}行：${values.join('；')}`);
  }
  if (!blocks.length) throw new Error('Excel 没有可读取的单元格内容，请检查空工作表或图片扫描内容。');
  if (formulas) warnings.push('公式未重新计算，仅保留文件保存时的结果与公式；导入前请在 Excel 中重新计算并保存。');
  if (missing) warnings.push('部分公式没有缓存结果，已明确标识，未用零值代替。');
  if (merged) warnings.push('合并单元格已标出范围，原值仅在原位置保留，请核对多层表头。');
  if (hidden) warnings.push('隐藏工作表的内容已一并解析，并在工作表标题中标识。');
  if (hiddenValues) warnings.push('部分单元格的显示格式隐藏了真实值，已回退原始值，请核对。');
  if (errors) warnings.push('部分单元格含有 Excel 错误值，已按原值保留，请核对。');
  return {text:blocks.join('\n'),warnings};
}
