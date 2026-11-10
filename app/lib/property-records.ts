/** Lossless row parsing for existing, parsed knowledge documents. No model inference is used here. */
export type PropertyStatus = 'vacant' | 'rented' | 'unknown';

export type PropertySource = {
  documentId: string;
  title: string;
  fileName: string;
  libraryId: string;
  libraryName: string;
  text: string;
  updatedAt?: string;
};

export type PropertyField = { label: string; value: string };
export type PropertyArea = {
  min: number;
  max: number;
  label: string;
  raw: string;
  approximate: boolean;
  unit: 'sqm' | 'unspecified';
};
export type PropertyRow = {
  id: string;
  source: Omit<PropertySource, 'text'>;
  section: string;
  rowLabel: string;
  raw: string;
  format: 'excel' | 'markdown' | 'csv' | 'tsv';
  fields: PropertyField[];
  status: PropertyStatus;
  sourceStatus: PropertyStatus;
  sectionStatus: PropertyStatus;
  statusConflict: boolean;
  area?: PropertyArea;
  location?: string;
  usage?: string;
};

type StatusInfo = { status: PropertyStatus; conflict: boolean };
type ParsedRecord = { cells: string[]; raw: string; startLine: number; endLine: number };
type Column = { key: string; label: string };
type ExcelEncoding = 'legacy' | 'json-v1' | 'unsupported';

const AREA_LABEL = /^(?:(?:建筑|套内|使用|经营|租赁|计租|出租|可租|商铺|房源|占地|实用|实际|总)面积|面积)(?:m2|平方米|平米|平)?$/;
const LOCATION_LABEL = /^(?:地址|详细地址|商铺地址|房源地址|位置|地理位置|坐落|坐落位置|区域|所在区域|行政区|区县|区块|商圈|项目|项目名称|所属项目|园区|园区名称|街道|路段|楼栋|楼层)$/;
const ID_LABEL = /^(?:房号|房源编号|房源名称|商铺|商铺编号|商铺名称|铺号|铺位|铺位号|铺位编号|单元|单元号|门牌号|物业编号|编号)$/;
const USAGE_LABEL = /^(?:业态|建议业态|适用业态|经营业态|招商业态|可经营业态|规划业态|推荐业态|用途|适用用途|经营范围)$/;
const STATUS_LABEL = /^(?:状态|租赁状态|出租状态|房源状态|商铺状态|使用状态|租用情况|租赁情况)$/;

function normalized(value: string): string {
  return value.normalize('NFKC').trim();
}

function labelKey(value: string): string {
  return normalized(value).toLowerCase().replace(/[\s()[\]【】{}:：·_/\\%-]/g, '');
}

function isPropertyLabel(value: string): boolean {
  const key = labelKey(value);
  return AREA_LABEL.test(key) || LOCATION_LABEL.test(key) || ID_LABEL.test(key) || USAGE_LABEL.test(key) || STATUS_LABEL.test(key);
}

function isHeader(cells: string[]): boolean {
  const populated = cells.filter(value => value.trim());
  const keys = populated.map(labelKey);
  return populated.length >= 2
    && populated.filter(isPropertyLabel).length >= 2
    && keys.some(key => AREA_LABEL.test(key) || LOCATION_LABEL.test(key) || ID_LABEL.test(key));
}

function uncertainMetadata(value: string): boolean {
  const text = normalized(value).replace(/\s/g, '');
  if (!/房源|商铺|空铺|铺位|物业|房屋|租赁|空置|在租|待租|可租|履约/.test(text)) return false;
  return /(?:非|不是|并非|不属于|不属|不为|没有|无|不|未)(?:空置|空铺|待租|可租|招租|在租|已租|已出租|出租中|租赁中|履约)/.test(text)
    || /待确认|待核实|待核对|待核验|尚未确认|未确认|未经确认|未核实|未经核实|状态未知|状态不明|状态不确定|疑似|可能|是否|待定/.test(text);
}

function metadataStatus(value: string): PropertyStatus {
  if (uncertainMetadata(value)) return 'unknown';
  const text = normalized(value).replace(/空置率/g, '');
  if (!/(?:房源|商铺|空铺|铺位|物业|房屋|租赁台账|租赁清单)/.test(text)
    && !/^(?:工作表[:：])?(?:空置|空铺|待租|可租|未出租|在租|已租|已出租|履约)(?:表|清单)?$/.test(text)) return 'unknown';
  const vacant = /空置|空铺|未出租|待出租|待租|可租|招租/.test(text);
  const rented = /已出租|已租|在租|出租中|租赁中|履约/.test(text);
  return vacant === rented ? 'unknown' : vacant ? 'vacant' : 'rented';
}

function combineStatuses(statuses: PropertyStatus[]): StatusInfo {
  const known = new Set(statuses.filter(status => status !== 'unknown'));
  return { status: known.size === 1 ? [...known][0] : 'unknown', conflict: known.size > 1 };
}

function explicitStatus(value: string): StatusInfo {
  const text = normalized(value).replace(/[\s()【】[\]，,、/|;；]/g, '');
  const tokens = text.match(/未出租|待出租|已出租|空置|空闲|待租|未租|可租|在租|已租|出租中|租赁中|履约中/g) ?? [];
  // Partial matches such as “不在租” or “是否空置” are not a confirmed status.
  const rest = text.replace(/未出租|待出租|已出租|空置|空闲|待租|未租|可租|在租|已租|出租中|租赁中|履约中/g, '').replace(/房源|商铺/g, '');
  if (rest) return { status: 'unknown', conflict: false };
  return combineStatuses(tokens.map(token => /^(?:在租|已租|已出租|出租中|租赁中|履约中)$/.test(token) ? 'rented' : 'vacant'));
}

function parseArea(fields: PropertyField[]): PropertyArea | undefined {
  const candidates = fields.filter(field => AREA_LABEL.test(labelKey(field.label)));
  // Different area concepts cannot be substituted for each other silently.
  if (candidates.length !== 1) return undefined;
  const field = candidates[0];
  let value = normalized(field.value);
  if (!value || /无缓存|无保存结果|未计算|^[=]/.test(value)) return undefined;
  value = value.replace(/\(公式[:：][\s\S]*$/, '').trim();
  const label = normalized(field.label).toLowerCase();
  const sqm = /平方米|平米|m2|平/.test(value.toLowerCase()) || /平方米|平米|m2|平/.test(label);
  const approximate = /约|大约|左右|约为|大概|近/.test(value);
  value = value.replace(/^(?:大约|约为|大概|约|近)\s*/, '').replace(/\s*左右$/, '');
  if (/亩|公顷|平方公里|km2|英尺|平方尺|ft2/i.test(value + label)) return undefined;
  let scale = 1;
  if (/万(?:平方米|平米|m2|平)/i.test(value) || /万(?:平方米|平米|m2|平)/i.test(label)) scale = 10_000;
  value = value.replace(/万?(?:平方米|平米|m2|平)/gi, '').trim();
  const number = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
  const match = value.match(new RegExp(`^(${number})\\s*(?:[-~～—–至到]\\s*(${number}))?$`));
  if (!match) return undefined;
  const min = Number(match[1].replaceAll(',', '')) * scale;
  const max = Number((match[2] ?? match[1]).replaceAll(',', '')) * scale;
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return undefined;
  return { min, max, label: field.label, raw: field.value, approximate, unit: sqm ? 'sqm' : 'unspecified' };
}

function joinedFields(fields: PropertyField[], pattern: RegExp): string | undefined {
  const values = fields.filter(field => pattern.test(labelKey(field.label))).map(field => field.value.trim()).filter(Boolean);
  return values.length ? [...new Set(values)].join(' · ') : undefined;
}

function makeRow(source: PropertySource, section: string, rowLabel: string, raw: string, format: PropertyRow['format'], fields: PropertyField[], ordinal: number): PropertyRow | undefined {
  if (!fields.some(field => field.value.trim() && (AREA_LABEL.test(labelKey(field.label)) || LOCATION_LABEL.test(labelKey(field.label)) || ID_LABEL.test(labelKey(field.label))))) return undefined;
  const first = fields.find(field => field.value.trim())?.value.trim() ?? '';
  if (/^(?:合计|总计|汇总|小计|平均|平均值|总面积|空置面积合计)(?:[:：].*)?$/.test(first)) return undefined;
  const sourceNames = [source.title, source.fileName, source.libraryName];
  const sourceUncertain = sourceNames.some(uncertainMetadata);
  const sourceInfo = combineStatuses(sourceNames.map(metadataStatus));
  const sectionStatus = metadataStatus(section);
  const sectionUncertain = uncertainMetadata(section);
  const statusFields = fields.filter(field => STATUS_LABEL.test(labelKey(field.label)) && field.value.trim());
  const rowInfos = statusFields.map(field => explicitStatus(field.value));
  const combined = combineStatuses([sourceInfo.status, sectionStatus, ...rowInfos.map(info => info.status)]);
  const statusConflict = sourceInfo.conflict || combined.conflict || rowInfos.some(info => info.conflict);
  const uncertainExplicitStatus = rowInfos.some(info => info.status === 'unknown');
  const metadata: Omit<PropertySource, 'text'> = {
    documentId: source.documentId,
    title: source.title,
    fileName: source.fileName,
    libraryId: source.libraryId,
    libraryName: source.libraryName,
    ...(source.updatedAt ? { updatedAt: source.updatedAt } : {}),
  };
  return {
    id: `${source.documentId}:${format}:${ordinal}:${rowLabel}`,
    source: metadata,
    section,
    rowLabel,
    raw,
    format,
    fields,
    status: statusConflict || uncertainExplicitStatus || sourceUncertain || sectionUncertain ? 'unknown' : combined.status,
    sourceStatus: sourceUncertain ? 'unknown' : sourceInfo.status,
    sectionStatus,
    statusConflict,
    area: parseArea(fields),
    location: joinedFields(fields, LOCATION_LABEL),
    usage: joinedFields(fields, USAGE_LABEL),
  };
}

function heading(line: string): string | undefined {
  return line.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
}

function parseExcel(source: PropertySource): PropertyRow[] {
  const rows: PropertyRow[] = [];
  let section = '';
  let columns: Column[] = [];
  let table = 0;
  let seenSection = false;
  let globalEncoding: ExcelEncoding = 'legacy';
  let encoding: ExcelEncoding = 'legacy';
  for (const line of source.text.split(/\r?\n/)) {
    const nextSection = heading(line);
    if (nextSection !== undefined) { section = nextSection; columns = []; table++; seenSection = true; encoding = globalEncoding; continue; }
    const serialization = line.match(/^单元格转义[:：]\s*(.+?)\s*$/);
    if (serialization) {
      encoding = serialization[1] === 'JSON-v1' ? 'json-v1' : 'unsupported';
      if (!seenSection) globalEncoding = encoding;
      columns = [];
      continue;
    }
    const rowMatch = line.match(/^第(\d+)行[:：](.*)$/);
    if (!rowMatch || encoding === 'unsupported') continue;
    const rowNumber = rowMatch[1];
    const cells = new Map<string, string>();
    let valid = true;
    for (const cell of rowMatch[2].split(/；(?=[A-Z]{1,3}\d+=)/)) {
      const match = cell.match(/^([A-Z]{1,3})(\d+)=([\s\S]*)$/);
      if (!match || match[2] !== rowNumber || cells.has(match[1])) { valid = false; break; }
      let value = match[3];
      if (encoding === 'json-v1') {
        try { value = JSON.parse('"' + value + '"') as string; }
        catch { valid = false; break; }
      }
      cells.set(match[1], value);
    }
    if (!valid || !cells.size) continue;
    if (isHeader([...cells.values()])) {
      columns = [...cells.entries()].filter(([, value]) => value.trim()).map(([key, label]) => ({ key, label }));
      table++;
      continue;
    }
    if (!columns.length) continue;
    const fields = columns.map(column => ({ label: column.label, value: cells.get(column.key) ?? '' }));
    for (const [key, value] of cells) if (!columns.some(column => column.key === key)) fields.push({ label: `列${key}`, value });
    const row = makeRow(source, section, `第${rowNumber}行`, line, 'excel', fields, table);
    if (row) rows.push(row);
  }
  return rows;
}

function markdownCells(line: string): string[] | undefined {
  let input = line.trim();
  if (!input.includes('|')) return undefined;
  if (input.startsWith('|')) input = input.slice(1);
  if (input.endsWith('|') && !input.endsWith('\\|')) input = input.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '\\' && input[i + 1] === '|') { cell += '|'; i++; }
    else if (input[i] === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += input[i];
  }
  cells.push(cell.trim());
  return cells;
}

function parseMarkdown(source: PropertySource): PropertyRow[] {
  const lines = source.text.split(/\r?\n/);
  const rows: PropertyRow[] = [];
  let section = '';
  let headers: string[] = [];
  let table = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { fenced = !fenced; headers = []; continue; }
    if (fenced) continue;
    const nextSection = heading(lines[i]);
    if (nextSection !== undefined) { section = nextSection; headers = []; continue; }
    const cells = markdownCells(lines[i]);
    if (!cells) { headers = []; continue; }
    const separator = markdownCells(lines[i + 1] ?? '');
    if (isHeader(cells) && separator?.length === cells.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
      headers = cells; table++; i++; continue;
    }
    if (!headers.length || cells.length > headers.length || cells.every(cell => /^:?-{3,}:?$/.test(cell))) continue;
    if (isHeader(cells)) { headers = cells; table++; continue; }
    const fields = headers.map((label, index) => ({ label, value: cells[index] ?? '' })).filter(field => field.label.trim());
    const row = makeRow(source, section, `第${i + 1}行`, lines[i], 'markdown', fields, table);
    if (row) rows.push(row);
  }
  return rows;
}

/** CSV scanner retains record boundaries even when a quoted field spans several physical lines. */
function delimitedRecords(text: string, delimiter: string): ParsedRecord[] | undefined {
  const records: ParsedRecord[] = [];
  let cells: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  let start = 0;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i <= text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') { quoted = false; closedQuote = true; }
      else if (char === undefined) return undefined;
      else { value += char; if (char === '\n' || (char === '\r' && text[i + 1] !== '\n')) line++; }
      continue;
    }
    if (char === '"') {
      if (value.trim() || closedQuote) return undefined;
      value = ''; quoted = true; continue;
    }
    if (char === delimiter || char === '\n' || char === '\r' || char === undefined) {
      cells.push(value); value = ''; closedQuote = false;
      if (char === delimiter) continue;
      if (cells.some(cell => cell.trim())) records.push({ cells, raw: text.slice(start, i), startLine, endLine: line });
      cells = [];
      if (char === '\r' && text[i + 1] === '\n') i++;
      line++; startLine = line; start = i + 1;
      continue;
    }
    if (closedQuote && !/\s/.test(char)) return undefined;
    if (!closedQuote) value += char;
  }
  return records;
}

function parseDelimited(source: PropertySource, delimiter: ',' | '\t'): PropertyRow[] {
  const records = delimitedRecords(source.text.replace(/^\uFEFF/, ''), delimiter);
  if (!records) return [];
  const rows: PropertyRow[] = [];
  let headers: string[] = [];
  let section = '';
  let table = 0;
  for (const record of records) {
    if (record.cells.length === 1) {
      const nextSection = heading(record.cells[0]);
      if (nextSection !== undefined) { section = nextSection; headers = []; }
      continue;
    }
    if (isHeader(record.cells)) { headers = record.cells; table++; continue; }
    if (!headers.length || record.cells.length > headers.length) continue;
    const fields = headers.map((label, index) => ({ label: label.trim(), value: record.cells[index] ?? '' })).filter(field => field.label);
    const rowLabel = record.startLine === record.endLine ? `第${record.startLine}行` : `第${record.startLine}–${record.endLine}行`;
    const row = makeRow(source, section, rowLabel, record.raw, delimiter === ',' ? 'csv' : 'tsv', fields, table);
    if (row) rows.push(row);
  }
  return rows;
}

/** Parse full source documents, rather than independently retrieved chunks that may lack their header. */
export function parsePropertySources(sources: PropertySource[]): PropertyRow[] {
  return sources.flatMap(source => {
    if (source.text.length > 1_000_000) throw new RangeError('房源原文超过 1,000,000 字符，无法安全完整解析。');
    if (/^第\d+行[:：][A-Z]{1,3}\d+=/m.test(source.text)) return parseExcel(source);
    const markdown = parseMarkdown(source);
    if (markdown.length) return markdown;
    const csv = parseDelimited(source, ',');
    return csv.length ? csv : parseDelimited(source, '\t');
  });
}
