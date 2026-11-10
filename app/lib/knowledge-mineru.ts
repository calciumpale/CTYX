import { decryptConnectionSecret, encryptConnectionSecret } from './connection-config.ts';
import { DomainError } from './domain.ts';
import { KNOWLEDGE_FILE_LIMIT } from './knowledge-library-types.ts';

interface ImportIdentity { ownerId: string; memberId: string; }
const ticketPurpose = (identity: ImportIdentity) => `knowledge-mineru-task:${identity.memberId}`;
const invalidTicket = () => new DomainError('MinerU 解析任务无效，请重新选择文件。');
const fileTooLarge = () => new DomainError('知识文件不能超过 10 MB，请压缩或拆分后重试。', 413);
const multipartLimit = KNOWLEDGE_FILE_LIMIT + 16 * 1024;

export async function readMineruUpload(request: Request): Promise<File> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new DomainError('请选择需要解析的 PDF 文件。', 415);
  if (Number(request.headers.get('content-length')) > multipartLimit) throw fileTooLarge();
  if (!request.body) throw new DomainError('请选择需要解析的 PDF 文件。');

  let received = 0;
  const limited = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > multipartLimit) throw fileTooLarge();
      controller.enqueue(chunk);
    },
  }));
  let form: FormData;
  try {
    form = await new Response(limited, { headers: { 'Content-Type': contentType } }).formData();
  } catch (error) {
    if (received > multipartLimit) throw fileTooLarge();
    if (error instanceof DomainError) throw error;
    throw new DomainError('无法读取 PDF 文件，请重新选择。');
  }
  const files = form.getAll('file');
  const file = files[0];
  if (files.length !== 1 || !(file instanceof File) || !/\.pdf$/i.test(file.name) || !file.size) {
    throw new DomainError('MinerU 云解析需要一个有效的 PDF 文件。');
  }
  if (file.size > KNOWLEDGE_FILE_LIMIT) throw fileTooLarge();
  const header = new TextDecoder().decode(await file.slice(0, 1024).arrayBuffer());
  if (!header.includes('%PDF-')) throw new DomainError('文件不是有效的 PDF，请检查格式。');
  return file;
}

export async function createMineruTicket(batchId: string, key: string, identity: ImportIdentity, now = Date.now()): Promise<string> {
  const expiresAt = now + 60 * 60_000;
  return encryptConnectionSecret(JSON.stringify({ batchId, expiresAt }), key, identity.ownerId, ticketPurpose(identity));
}

export async function readMineruTicket(ticket: unknown, key: string, identity: ImportIdentity, now = Date.now()): Promise<string> {
  if (typeof ticket !== 'string' || ticket.length > 1024 || !/^v1\.[\w-]+\.[\w-]+$/.test(ticket)) throw invalidTicket();
  let decoded: { batchId?: unknown; expiresAt?: unknown };
  try {
    decoded = JSON.parse(await decryptConnectionSecret(ticket, key, identity.ownerId, ticketPurpose(identity)));
  } catch {
    throw invalidTicket();
  }
  const { batchId, expiresAt } = decoded;
  if (typeof batchId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(batchId) || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) throw invalidTicket();
  if (expiresAt <= now) throw new DomainError('MinerU 解析任务已过期，请重新选择文件。', 410);
  return batchId;
}
