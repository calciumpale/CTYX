import type { ExcelFormat } from './knowledge-excel-import.ts';

export async function importKnowledgeExcel(file:File,format:ExcelFormat):Promise<{text:string;warnings:string[]}> {
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(typeof Worker==='undefined')return (await import('./knowledge-excel-import.ts')).extractKnowledgeExcel(bytes,format);
  // Isolate workbook parsing so a damaged workbook cannot lock the upload dialog.
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./knowledge-excel-worker.ts',import.meta.url),{type:'module'});
    const finish=()=>{clearTimeout(timer);worker.terminate();};
    const timer=setTimeout(()=>{finish();reject(new Error('Excel 解析超时，请拆分工作表后重试。'));},45_000);
    worker.onmessage=(event:MessageEvent<{result?:{text:string;warnings:string[]};error?:string}>)=>{finish();if(event.data.result)resolve(event.data.result);else reject(new Error(event.data.error||'Excel 解析失败，请检查文件。'));};
    worker.onerror=()=>{finish();reject(new Error('Excel 解析器未能完成读取，请刷新后重试或将工作表另存为 CSV。'));};
    worker.postMessage({bytes,format},[bytes.buffer]);
  });
}
