import { extractKnowledgeExcel, type ExcelFormat } from './knowledge-excel-import.ts';

self.onmessage = async (event: MessageEvent<{bytes:Uint8Array;format:ExcelFormat}>) => {
  try { self.postMessage({result:await extractKnowledgeExcel(event.data.bytes,event.data.format)}); }
  catch (cause) { self.postMessage({error:cause instanceof Error?cause.message:'Excel 解析失败，请重新另存后重试。'}); }
};
