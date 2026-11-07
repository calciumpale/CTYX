import { importContractFile } from './contract-import.ts';
import { KNOWLEDGE_FILE_LIMIT, KNOWLEDGE_TEXT_LIMIT } from './knowledge-library-types.ts';

const documentWording = (message: string) => message.replaceAll('合同', '文档').replaceAll('初审', '读取').replaceAll('审核', '导入').replaceAll('相关条款', '相关内容').replaceAll('最终生效版本', '正确版本');

/** Parse locally in the browser; only the extracted text needs to reach the worker. */
export async function importKnowledgeFile(file: File): Promise<{ text: string; fileName: string; warnings: string[] }> {
  if (!file.size) throw new Error('文件为空，请选择包含正文的文档。');
  if (file.size > KNOWLEDGE_FILE_LIMIT) throw new Error('知识文件不能超过 10 MB，请压缩或拆分后重试。');
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (!extension || !['txt', 'md', 'markdown', 'csv', 'docx', 'pdf', 'xlsx', 'xls'].includes(extension)) throw new Error('支持 Excel（XLSX / XLS）、PDF、DOCX、TXT、Markdown 和 CSV；旧版 DOC 请另存为 DOCX。');
  if (extension === 'xlsx' || extension === 'xls') {
    const { importKnowledgeExcel } = await import('./knowledge-excel.ts');
    const result = await importKnowledgeExcel(file, extension);
    return { ...result, fileName: file.name };
  }
  // Reuse the existing bounded decoding, ZIP/CRC validation and PDF worker.
  const input = ['md', 'markdown', 'csv'].includes(extension) ? new File([file], `${file.name}.txt`, { type: 'text/plain' }) : file;
  try {
    const result = await importContractFile(input, { textLimit: KNOWLEDGE_TEXT_LIMIT, docxXmlLimit: 8 * 1024 * 1024 });
    return { text: result.text, fileName: file.name, warnings: result.warnings.map(documentWording) };
  } catch (error) {
    throw new Error(documentWording(error instanceof Error ? error.message : '文件无法读取，请检查文档格式。'));
  }
}
