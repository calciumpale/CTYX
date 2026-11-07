/** XLSX ZIP preflight. Nothing is extracted to disk or retained after verification. */
const INPUT_LIMIT = 10 * 1024 * 1024;
const ENTRY_LIMIT = 16 * 1024 * 1024;
const TOTAL_LIMIT = 32 * 1024 * 1024;
const ENTRY_COUNT_LIMIT = 2048;
const INPUT_CHUNK = 1024;
interface ExcelPart { name: string; local: number; data: number; end: number; compressed: number; size: number; method: number; crc: number; }
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function updateCrc(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc;
}
function invalid(message: string): never { throw new Error(`Excel ${message}`); }
function bounded(at: number, length: number, end: number): boolean { return Number.isSafeInteger(at) && Number.isSafeInteger(length) && at >= 0 && length >= 0 && at <= end - length; }
function decodeName(bytes: Uint8Array): string {
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return invalid('文件名编码无法可靠识别，请重新另存为 XLSX。'); }
  const segments = name.replace(/\/$/, '').split('/');
  if (!name || /^[\/]|^[A-Za-z]:/.test(name) || /[\\\u0000-\u001f\u007f]/.test(name) || segments.some(segment => !segment || segment === '.' || segment === '..')) invalid('压缩条目路径或文件名异常，请重新另存为 XLSX。');
  return name;
}
function checkFlags(flags: number) {
  if (flags & 0x2041) invalid('文件已加密，请先解除密码保护后重试。');
  // Ordinary DEFLATE option bits, streaming descriptors and UTF-8 names only.
  if (flags & ~0x080e) invalid('压缩条目包含不支持的标记，请重新另存为 XLSX。');
}
function partsFor(bytes: Uint8Array): ExcelPart[] {
  if (bytes.length > INPUT_LIMIT) invalid('文件不能超过 10 MB，请拆分后重试。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true), u32 = (at: number) => view.getUint32(at, true);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at--) {
    if (u32(at) === 0x06054b50 && at + 22 + u16(at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) invalid('文件损坏，无法读取 XLSX 压缩目录。');
  const count = u16(end + 10), directorySize = u32(end + 12), directory = u32(end + 16);
  if (count === 0xffff || directorySize === 0xffffffff || directory === 0xffffffff || (end >= 20 && u32(end - 20) === 0x07064b50)) invalid('暂不支持 ZIP64 文件，请另存为普通 XLSX。');
  if (u16(end + 4) || u16(end + 6) || count !== u16(end + 8)) invalid('暂不支持分卷压缩文件，请另存为普通 XLSX。');
  if (count > ENTRY_COUNT_LIMIT) invalid('压缩条目数量超过 2048 个上限，请拆分工作簿。');
  if (!bounded(directory, directorySize, end) || directory + directorySize !== end) invalid('压缩目录边界或长度损坏。');
  const directoryEnd = directory + directorySize, parts: ExcelPart[] = [], names = new Set<string>();
  let at = directory, declaredTotal = 0;
  const checkExtra = (start: number, length: number, name: string, rawName: Uint8Array) => {
    const extraEnd = start + length;
    for (let position = start; position < extraEnd;) {
      if (!bounded(position, 4, extraEnd)) invalid('压缩条目扩展目录损坏。');
      const kind = u16(position), size = u16(position + 2); position += 4;
      if (!bounded(position, size, extraEnd)) invalid('压缩条目扩展目录长度损坏。');
      if (kind === 1) invalid('暂不支持 ZIP64 文件，请另存为普通 XLSX。');
      // Do not let a Unicode-path extension alias a different central-directory name.
      if (kind === 0x7075 && (size < 5 || bytes[position] !== 1 || u32(position + 1) !== ((updateCrc(0xffffffff, rawName) ^ 0xffffffff) >>> 0) || decodeName(bytes.subarray(position + 5, position + size)) !== name)) invalid('压缩条目文件名与扩展目录不一致。');
      position += size;
    }
  };
  for (let index = 0; index < count; index++) {
    if (!bounded(at, 46, directoryEnd) || u32(at) !== 0x02014b50) invalid('压缩目录条目损坏。');
    const flags = u16(at + 8), method = u16(at + 10), crc = u32(at + 16), compressed = u32(at + 20), size = u32(at + 24);
    const nameSize = u16(at + 28), extraSize = u16(at + 30), commentSize = u16(at + 32), disk = u16(at + 34), local = u32(at + 42);
    checkFlags(flags);
    if ([compressed, size, local].includes(0xffffffff) || disk === 0xffff) invalid('暂不支持 ZIP64 文件，请另存为普通 XLSX。');
    if (disk) invalid('暂不支持分卷压缩文件，请另存为普通 XLSX。');
    if (method !== 0 && method !== 8) invalid('使用了不支持的压缩格式，请重新另存为 XLSX。');
    if (!bounded(at + 46, nameSize + extraSize + commentSize, directoryEnd)) invalid('压缩目录文件名或条目边界损坏。');
    const rawName = bytes.subarray(at + 46, at + 46 + nameSize), name = decodeName(rawName), key = name.normalize('NFC').toLowerCase();
    if (names.has(key)) invalid('存在重复文件条目，请重新另存为 XLSX。');
    names.add(key); checkExtra(at + 46 + nameSize, extraSize, name, rawName);
    if ((u32(at + 38) >>> 16 & 0xf000) === 0xa000) invalid('压缩条目包含不支持的链接路径。');
    declaredTotal += size;
    if (size > ENTRY_LIMIT) invalid('单条内容解压后超过 16 MB 上限，请拆分工作簿。');
    if (declaredTotal > TOTAL_LIMIT) invalid('内容解压后总量超过 32 MB 上限，请拆分工作簿。');
    if (!bounded(local, 30, directory) || u32(local) !== 0x04034b50) invalid('压缩内容的本地条目边界损坏。');
    const localFlags = u16(local + 6), localMethod = u16(local + 8), localCrc = u32(local + 14), localCompressed = u32(local + 18), localSize = u32(local + 22);
    const localNameSize = u16(local + 26), localExtraSize = u16(local + 28);
    checkFlags(localFlags);
    if (localCompressed === 0xffffffff || localSize === 0xffffffff) invalid('暂不支持 ZIP64 文件，请另存为普通 XLSX。');
    if (localFlags !== flags || localMethod !== method || localNameSize !== nameSize || !bounded(local + 30, localNameSize + localExtraSize, directory)) invalid('压缩条目本地头与目录不一致或边界损坏。');
    for (let byte = 0; byte < nameSize; byte++) if (bytes[local + 30 + byte] !== rawName[byte]) invalid('压缩条目文件名与目录不一致。');
    checkExtra(local + 30 + localNameSize, localExtraSize, name, rawName);
    if (flags & 8) {
      if ((localCrc !== 0 && localCrc !== crc) || (localCompressed !== 0 && localCompressed !== compressed) || (localSize !== 0 && localSize !== size)) invalid('压缩条目本地大小或校验声明与目录不一致。');
    } else if (localCrc !== crc || localCompressed !== compressed || localSize !== size) invalid('压缩条目本地大小或校验声明与目录不一致。');
    const data = local + 30 + localNameSize + localExtraSize;
    if (!bounded(data, compressed, directory)) invalid('压缩条目内容边界损坏。');
    let partEnd = data + compressed;
    if (flags & 8) {
      const matches = (position: number) => bounded(position, 12, directory) && u32(position) === crc && u32(position + 4) === compressed && u32(position + 8) === size;
      if (bounded(partEnd, 16, directory) && u32(partEnd) === 0x08074b50 && matches(partEnd + 4)) partEnd += 16;
      else if (matches(partEnd)) partEnd += 12;
      else invalid('压缩条目数据描述与大小或校验声明不一致。');
    }
    if ((method === 0 && compressed !== size) || (method === 8 && compressed < 2) || (name.endsWith('/') && size !== 0)) invalid('压缩条目大小声明损坏。');
    parts.push({ name, local, data, end: partEnd, compressed, size, method, crc });
    at += 46 + nameSize + extraSize + commentSize;
  }
  if (at !== directoryEnd) invalid('压缩目录长度与条目数量不一致。');
  // Reject hidden/unindexed local entries, overlapping payloads and ambiguous prefixes.
  let next = 0;
  for (const part of [...parts].sort((a, b) => a.local - b.local)) {
    if (part.local !== next) invalid('压缩条目边界重叠或包含未登记内容，文件损坏。');
    next = part.end;
  }
  if (next !== directory) invalid('压缩内容与目录边界不一致，文件损坏。');
  if (!parts.some(part => part.name === 'xl/workbook.xml') || !parts.some(part => /^xl\/worksheets\/[^/]+\.xml$/.test(part.name))) invalid('文件格式异常，缺少工作簿或工作表，请另存为 XLSX。');
  return parts;
}

/** Validate every entry, including non-text attachments, with bounded streaming output. */
export async function validateExcelArchive(bytes: Uint8Array): Promise<{ entries: string[] }> {
  const parts = partsFor(bytes);
  const { Inflate } = await import('fflate');
  let total = 0;
  for (const part of parts) {
    let actual = 0, crc = 0xffffffff;
    const accept = (chunk: Uint8Array) => {
      actual += chunk.length; total += chunk.length;
      if (actual > ENTRY_LIMIT || total > TOTAL_LIMIT || actual > part.size) invalid('内容实际解压大小异常或超过上限，已停止读取。');
      crc = updateCrc(crc, chunk);
    };
    const input = bytes.subarray(part.data, part.data + part.compressed);
    if (part.method === 0) {
      for (let at = 0; at < input.length; at += INPUT_CHUNK) accept(input.subarray(at, at + INPUT_CHUNK));
    } else {
      try {
        const inflater = new Inflate(accept);
        // Small compressed pushes bound even the transient expansion of forged ZIP sizes.
        for (let at = 0; at < input.length; at += INPUT_CHUNK) inflater.push(input.subarray(at, at + INPUT_CHUNK), at + INPUT_CHUNK >= input.length);
      } catch (cause) {
        if (cause instanceof Error && cause.message.startsWith('Excel ')) throw cause;
        invalid('压缩内容损坏，无法可靠解压，请重新另存为 XLSX。');
      }
    }
    if (actual !== part.size || ((crc ^ 0xffffffff) >>> 0) !== part.crc) invalid('内容大小或 CRC 校验失败，文件可能已损坏。');
  }
  return { entries: parts.map(part => part.name) };
}
