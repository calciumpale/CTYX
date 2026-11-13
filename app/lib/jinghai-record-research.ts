import type { JinghaiCredentials } from './company-research.ts';

const detailEndpoint = 'https://www.kqdaas.com/DataService/api/v3/company/detail';
const penaltyEndpoint = 'https://www.kqdaas.com/DataService/api/v3/company/punishment';
const source = {
  title: '鲸海数据 · 行政处罚信息',
  url: 'https://www.kqdaas.com/market?apiId=10022',
  provider: 'jinghai',
} as const;

export interface JinghaiPenaltyRecord {
  id: string;
  kind: 'administrative-penalty';
  subject: string;
  creditCode?: string;
  decisionNo?: string;
  decisionDate?: string;
  publicationDate?: string;
  authority?: string;
  excerpt: string;
}

export interface JinghaiPenaltyResearch {
  status: 'records' | 'empty' | 'unverified' | 'unavailable';
  records: JinghaiPenaltyRecord[];
  source: typeof source;
}

const nameKey = (value: string) => value.trim().replace(/（/g, '(').replace(/）/g, ')');
const creditCodePattern = /^[0-9A-HJ-NPQRTUWXY]{18}$/;
const plainObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const clean = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const noRecords = (status: Exclude<JinghaiPenaltyResearch['status'], 'records'>): JinghaiPenaltyResearch =>
  ({ status, records: [], source });
const definiteOutcome = /^(?:本局决定(?:对当事人)?[：:]?\s*|决定[：:]?\s*|对当事人[：:]?\s*)?(?:予以(?:行政)?警告|给予(?:行政)?警告|警告[，。；;：:\s]*$|处以(?:行政)?罚款|罚款\s*(?:人民币|[：:\d一二两三四五六七八九十百千万])|没收违法所得|责令(?:停产停业|停业整顿|关闭)|吊销(?:许可证|营业执照)|撤销(?:许可证|资质))/;
const uncertainOutcome = /(?:拟|不予|免予|免于|撤销|变更|撤回|中止|终止|尚未|未作出|可能|如有|是否|告知书).{0,14}(?:处罚|罚款|警告|没收|停产停业|关闭)|(?:处罚|罚款|警告|没收).{0,14}(?:已被?|予以|决定)?(?:撤销|撤回|中止|终止)|供应商|经销商|加盟商|关联企业|其他(?:企业|公司|餐厅|商户)|(?:子公司|分公司|分店|门店).{0,20}(?:处罚|罚款|警告|没收|停产停业|关闭)/;

function parseRow(raw: unknown, name: string, creditCode: string): Omit<JinghaiPenaltyRecord, 'id'> | undefined {
  const row = plainObject(raw);
  const subject = row?.行政相对人名称 ?? row?.当事人名称 ?? row?.companyName;
  const rowCreditValue = row?.统一社会信用代码 ?? row?.creditNumber;
  const rowCredit = typeof rowCreditValue === 'string' ? rowCreditValue.trim().toUpperCase() : '';
  if (typeof subject !== 'string' || nameKey(subject) !== name ||
      rowCreditValue != null && (!creditCodePattern.test(rowCredit) || !!creditCode && rowCredit !== creditCode)) return undefined;
  const outcome = row?.行政处罚内容;
  if (typeof outcome !== 'string' || outcome.length > 1200) return undefined;
  const excerpt = clean(outcome, 1200);
  const decisionNo = clean(row?.行政处罚决定书文号, 160);
  const decisionDate = clean(row?.处罚决定日期, 40);
  const publicationDate = clean(row?.公示日期, 40);
  const authority = clean(row?.处罚机关, 120);
  if (!definiteOutcome.test(excerpt) || uncertainOutcome.test(excerpt) || (!decisionNo && !(authority && decisionDate))) return undefined;
  return { kind: 'administrative-penalty', subject: subject.trim(), excerpt,
    ...(rowCredit ? { creditCode: rowCredit } : {}),
    ...(decisionNo ? { decisionNo } : {}),
    ...(decisionDate ? { decisionDate } : {}),
    ...(publicationDate ? { publicationDate } : {}),
    ...(authority ? { authority } : {}),
  };
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 256 * 1024;
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid Jinghai response size');
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let size = 0;
  let json = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        cancel();
        throw new Error('Invalid Jinghai response size');
      }
      json += decoder.decode(value, { stream: true });
    }
    return JSON.parse(json + decoder.decode());
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** A single exact-subject lookup against Jinghai API 10022. Only the public identifier leaves the workspace. */
export async function searchJinghaiCompanyPenalties(
  company: { name: string; creditCode?: string },
  credentials: JinghaiCredentials,
  request: typeof fetch = fetch,
): Promise<JinghaiPenaltyResearch> {
  const name = nameKey(company.name);
  const creditCode = company.creditCode?.trim().toUpperCase() ?? '';
  if (!name || name.length > 200 || /^\.{1,2}$/.test(name) || /[\/\\\u0000-\u001f\u007f]/.test(company.name) ||
      (creditCode && !creditCodePattern.test(creditCode)) ||
      credentials.endpoint !== detailEndpoint || !credentials.appId.trim() || !credentials.apiKey.trim()) {
    return noRecords('unavailable');
  }
  const url = new URL(`${penaltyEndpoint}/${encodeURIComponent(creditCode || name)}`);
  url.search = new URLSearchParams({ queryType: creditCode ? '2' : '1', pageIndex: '1', pageSize: '10' }).toString();
  const signal = AbortSignal.timeout(5000);
  try {
    const response = await request(url.href, {
      method: 'GET', redirect: 'manual', signal,
      headers: { 'X-Jinghai-App-Id': credentials.appId, 'X-Jinghai-Api-Key': credentials.apiKey, Accept: 'application/json' },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return noRecords(response.status === 404 ? 'unverified' : 'unavailable');
    }
    const payload = plainObject(await boundedJson(response, signal));
    const codes = [payload?.errcode, payload?.status, payload?.code].filter(value => value !== undefined && value !== null).map(String);
    if (codes.length && codes.every(code => code === '404')) return noRecords('unverified');
    if (payload?.success === false || codes.some(code => code !== '200') || (!codes.length && payload?.success !== true)) {
      return noRecords('unavailable');
    }
    const data = plainObject(payload?.data);
    if (!Array.isArray(data?.records)) return noRecords('unverified');
    const total = data.totalRecords ?? data.total ?? plainObject(data.page)?.total;
    if (!data.records.length) return noRecords(total === 0 || total === '0' ? 'empty' : 'unverified');
    const seen = new Set<string>();
    const records = data.records.slice(0, 10).flatMap(value => {
      const record = parseRow(value, name, creditCode);
      if (!record) return [];
      const key = record.decisionNo || `${record.authority}:${record.decisionDate}:${record.excerpt}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...record, id: `record-jinghai-${seen.size}` }];
    });
    return records.length ? { status: 'records', records, source } : noRecords('unverified');
  } catch {
    return noRecords('unavailable');
  }
}
