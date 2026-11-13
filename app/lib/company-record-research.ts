import { searchText } from './company-profile-evidence.ts';
import type { EffectiveModel } from './connection-config.ts';
import type { Deal } from './types.ts';
import { canonicalSource, searchPublicWeb } from './web-prospect-search.ts';

export interface CompanyRecordEvidence {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  scope: 'company' | 'related';
  kind: 'administrative-penalty' | 'business-abnormality' | 'dishonest-enforcement' | 'judicial-enforcement' | 'food-safety';
  retrievedAt: string;
  publishedAt?: string;
}

export interface CompanyRecordResearch {
  status: 'completed' | 'partial' | 'failed';
  sources: CompanyRecordEvidence[];
  provider?: 'deepseek' | 'bing';
  deepseekStatus?: 'empty' | 'failed';
}

type Kind = CompanyRecordEvidence['kind'];
type Passage = Pick<CompanyRecordEvidence, 'excerpt' | 'scope' | 'kind'>;
type SearchModel = Pick<EffectiveModel, 'url' | 'key'>;
type Candidate = { title: string; url: string; excerpts: string[]; retrievedAt: string; publishedAt?: string };

const broadQuestion = /违规|违法|合规|处罚记录|处罚历史/;
const recordTypes: { kind: Kind; keyword: string; question: RegExp; claim: RegExp }[] = [
  {
    kind: 'administrative-penalty', keyword: '行政处罚', question: /行政处罚|罚款|罚没|被罚(?:过|了|吗|没有)|受过处罚/,
    claim: /(?:作出|给予|予以|受(?:到|到过)?|接受|处以|并处|罚以|处之以|导致|分别被|被).{0,14}(?:行政处罚|行政警告|罚款|罚没|没收违法所得)|(?:行政处罚|罚款|罚没)(?:金额|人民币|为|共计|合计|[：:]?\s*[\d一二两三四五六七八九十百千万])|被[^，。；]{0,30}(?:处罚|罚款|罚过|警告|没收违法所得)|[\d一二两三四五六七八九十百]+\s*项行政处罚|^处罚结果[：:]\s*(?:警告|罚款|罚没|没收|责令停业)/,
  },
  {
    kind: 'business-abnormality', keyword: '经营异常名录', question: /经营异常/,
    claim: /(?:列入|载入|纳入|移出|移除).{0,12}经营异常(?:名录|名单)/,
  },
  {
    kind: 'dishonest-enforcement', keyword: '失信被执行人', question: /失信|黑名单/,
    claim: /(?:列为|列入|纳入|公布为|被认定为).{0,12}(?:失信被执行人|严重违法失信(?:名单|名录))|失信被执行人信息[：:]/,
  },
  {
    kind: 'judicial-enforcement', keyword: '被执行人', question: /被执行|执行记录|司法执行|执行案件|限高/,
    claim: /(?:列为|列入|纳入|登记为).{0,12}被执行人|(?:执行案号|被执行人)[：: ]+.{0,8}[\d\p{L}]|被.{0,16}(?:立案执行|限制高消费)|(?:案号|执行案号)为[^。；]{0,24}执\d/u,
  },
  {
    kind: 'food-safety', keyword: '食品安全', question: /食品安全|食安|抽检|餐具/,
    claim: /(?:抽检|抽查).{0,28}不合格|不合格.{0,8}(?:样品|批次)|(?:检查|查明|发现|通报|认定|发生).{0,30}(?:食品安全事故|超(?:过)?保质期|过期(?:食材|食品)|餐具.{0,8}不合格|混有异物|食物中毒|未履行进货查验)|发生.{0,8}(?:食品安全事故|食物中毒)/,
  },
];

const authority = /市场(?:监督)?管理(?:局|所)|市场监管(?:局|所)|市监局|人民法院|行政机关|监管部门|监管机构|执法部门|监督管理部门|消防救援|生态环境局|税务局/;
const tentative = /(?:不予|免予|免于|拟(?:作出|给予|处罚|对|被|处以|罚款)|可能(?:被|受到|构成)|依法可|应当|将(?:被|处以|给予)).{0,36}(?:处罚|罚款|列入|列为)|(?:尚待|有待|仍待|未经|尚未|暂未|没有|无法|不能).{0,8}(?:核实|证实|确认|发现|查到|查见|认定)|(?:未曾|从未|没有|并无|不存在|未发现|未查到|未受到|未被).{0,24}(?:处罚|罚款|失信|列入|被执行|不合格|食品安全(?:事件|事故))|(?:投诉人认为|网传|网友称|网友爆料|据传|投诉称|征求意见稿|处罚告知书|是否|有无|有没有)|(?:不代表|不能认定为).{0,10}(?:行政处罚|违法)|(?:撤销|撤回).{0,16}行政处罚|行政处罚.{0,12}(?:被|已)(?:撤销|撤回)/;
const relatedRole = /^(?:的|所辖|所营|其)?(?:旗下|下属|所属|全资子公司|控股子公司|子公司|分公司|分支机构|分部|(?:\d+|[一二两三四五六七八九十百]+)家(?:直营|加盟)?(?:餐厅|门店|店铺))|^(?:的)?[^，。！？；、：:\s]{0,20}(?:分公司|分店|门店|营业部|办事处|路店|广场店|中心店|大厦店|店)(?=$|[^\p{L}\p{N}]|因|被|使用|受到|经营|的)/u;
const nestedCompany = /^(?:控股|集团|股份|有限责任|[\p{L}\p{N}]{1,12}(?:有限公司|有限责任公司|股份有限公司))/u;
const otherSubject = /有限公司|有限责任公司|股份公司|个体工商户|(?:员工|股东|实际控制人|法定代表人|董事|总经理)[^。！？；，]{0,14}(?:被|受到|列入|列为|罚款)/;
const interveningSubject = /供应商|经销商|合作(?:商|伙伴|方)|客户|承包商|(?:其他|另一|别家)(?:餐厅|门店|企业|公司|商户)|(?:公布|发布|通报|宣布|称|披露|发现|调查|报道)[^。！？；]{0,24}(?:被|受到|列入|列为|处以|罚款)/;
const listingTitle = /招股说明书|申请版本|上市申请稿|招股书|年度报告|年报|社会责任报告|esg报告|发行申请|上市申请/;
const subjectBoundary = /(?:^|[^\p{L}\p{N}]|当事人|行政相对人|关于|有关|对|向|据|称|通报|载明|显示|处罚|检查|认定|公告|公司名称|企业名称|经营者)$/u;
const sourceSubjectField = /(?:行政相对人|当事人|被处罚(?:单位|企业)|企业名称|公司名称|经营者)[：:]\s*$/;
const exactActionTail = /^(?:曾|已|于|在|因|存在|实施|生产|经营|销售|涉及|未|涉嫌|被|受|收到|接受|获|列入|列为|遭|罚款|行政处罚|行政警告|作为被执行人|[：:]|[（(])/;
const relatedTail = /(?:直营店|加盟店|旗下门店|下属门店|分公司|分店|分支机构|家(?:餐厅|店))[^。！？；]{0,48}(?:发生|受(?:到|过)?行政处罚|受到|被|列入|罚款|导致)/;
const directHead = /(?:对|向|处罚|通报|发现|认定|列入|列为|以|名为|公布|检查)\s*$/;
const pronounAction = /^(?:处罚结果[：:]|(?:市场(?:监督)?管理(?:局|所)|市场监管(?:局|所)|监管部门|本局|该局|行政机关|人民法院|法院|执法人员|当事人|该公司|该企业|其|决定|现)(?:[^。！？；]{0,40})(?:当事人|该公司|该企业|责令|给予|处以|罚款|行政处罚|列入|列为))/;
const titleOnlyAuthority = /行政处罚决定书|行政处罚决定|行政处罚公示|处罚信息公示|处罚通报|列入经营异常名录公告/;
const groupRelationship = /^(?:为|是|系)(?:本集团|集团|上市申请人|本公司|我们的?)(?:的)?(?:境内|中国境内)?(?:运营主体|全资子公司|间接全资子公司|主要运营公司)[。！!]$/;
const adjacentRevocation = /^(?:随后|之后|此后|后续)?[，,]?(?:该|这(?:份|项|次)|上述|原)?(?:行政)?处罚(?:决定)?(?:后|其后)?(?:已|被|已被)?(?:撤销|撤回)/;

// Compare common forms in Hong Kong listing materials while preserving the published quotation.
const scriptVariants = [
  '鄉乡 雞鸡 飲饮 團团 體体 國国 華华 東东 門门 營营 運运 業业 監监 處处 罰罚 應应 異异 違违 規规 執执',
  '責责 數数 實实 檢检 發发 現现 關关 於于 為为 據据 採采 過过 質质 標标 準准 導导 兩两 項项 當当 時时',
  '場场 與与 顧顾 戶户 設设 備备 屬属 顯显 書书 稱称 權权 續续 歷历 說说 啟启 務务 繳缴 聯联 該该 獲获',
  '開开 經经 無无 駐驻 遷迁 廣广 漢汉 蘇苏 滬沪 寧宁 瀋沈 陽阳 慶庆 長长 寶宝 龍龙 樂乐 萬万 醫医 藥药',
  '製制 貿贸 電电 機机 臺台 灣湾 內内 氣气 綠绿 豐丰 絲丝 際际 風风 險险 總总 簡简 單单 號号 約约 錄录',
  '變变 檔档 須须 辦办 錯错 環环 衛卫 載载 訂订 個个 夥伙 親亲 園园 資资 傳传 詢询 後后 納纳 終终 審审',
  '結结 劃划 轉转 藍蓝 滷卤 凍冻 鮮鲜 農农 證证 註注 冊册 產产 則则 談谈 會会 屆届 銷销 顏颜 幣币 損损',
  '適适 別别 驗验 劑剂 沒没 遠远 訴诉 聞闻 鑑鉴 話话 計计 許许 層层 對对 臨临 廠厂 廢废 請请 間间',
].join(' ').split(' ');
const simplified = new Map(scriptVariants.map(pair => [pair[0], pair[1]]));
const normalize = (value: string) => [...searchText(value)].map(char => simplified.get(char) ?? char).join('');
const originalText = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

function requestedTypes(query: string) {
  const text = normalize(query);
  const specific = recordTypes.filter(type => type.question.test(text) &&
    (type.kind !== 'judicial-enforcement' || !/失信被执行人/.test(text) || /司法执行|执行记录|执行案件|执行人(?:或|和|及)失信/.test(text)));
  return specific.length ? specific : broadQuestion.test(text) ? recordTypes : recordTypes.slice(0, 1);
}

export function isCompanyPenaltyLookup(query: string): boolean {
  return requestedTypes(query).some(type => type.kind === 'administrative-penalty');
}

function mention(text: string, name: string) {
  let from = 0;
  while (from <= text.length - name.length) {
    const index = text.indexOf(name, from);
    if (index < 0) return undefined;
    const before = text.slice(0, index);
    const after = text.slice(index + name.length);
    if (subjectBoundary.test(before) && !nestedCompany.test(after) && !/^[a-z0-9]/.test(after)) {
      return { before, after, related: relatedRole.test(after) || /(?:子公司|分公司|旗下|下属)\s*$/.test(before) };
    }
    from = index + name.length;
  }
}

function passages(value: string): string[] {
  return (value.match(/[^。！？!?；;\n]+[。！？!?；;]?/g) ?? [])
    .map(originalText).filter(text => text.length > 0 && text.length <= 420 && !/[?？]|https?:\/\/|[<>]/i.test(text));
}

export function companyRecordEvidencePassage(companyName: string, query: string, title: string, text: string): Passage | undefined {
  const name = normalize(companyName).trim();
  if (!name) return undefined;
  const types = requestedTypes(query);
  const normalizedTitle = normalize(title);
  const titleIdentity = mention(normalizedTitle, name);
  const parts = passages(text);
  for (let index = 0; index < parts.length; index++) {
    const excerpt = parts[index];
    const normalized = normalize(excerpt);
    if (tentative.test(normalized) || tentative.test(normalizedTitle)) continue;
    const next = parts[index + 1];
    const nextText = normalize(next ?? '');
    const revoked = adjacentRevocation.test(nextText);
    const nextKind = types.find(type => type.claim.test(nextText) &&
      (type.kind !== 'administrative-penalty' || !adjacentRevocation.test(normalize(parts[index + 2] ?? ''))))?.kind;
    const identity = mention(normalized, name);
    if (identity) {
      const tail = identity.after.replace(/^[\s：:」”"'）)]+/, '');
      const before = identity.before.trim();
      const kind = types.find(type => {
        if (type.kind === 'administrative-penalty' && revoked) return false;
        if (otherSubject.test(tail) && !identity.related && !/^(?:的)?(?:旗下|下属|所属|控股|全资)/.test(tail)) return false;
        const match = type.claim.exec(tail);
        if (match && !interveningSubject.test(tail.slice(0, match.index + match[0].length)) &&
          (identity.related || exactActionTail.test(tail) || directHead.test(before) ||
          !before && /^[，,][^。；]{0,12}(?:受到|被|处以|罚款)/.test(tail))) return true;
        return type.claim.test(normalized) && authority.test(before) && directHead.test(before) &&
          /^(?:[。！!]|[，,](?:罚款|处以|没收|决定)|\s*$)/.test(tail);
      })?.kind;
      if (kind) return { excerpt, scope: identity.related || relatedTail.test(tail) ? 'related' : 'company', kind };
      if (sourceSubjectField.test(before) && /^[。！!；;]*$/.test(tail)) {
        if (next && nextKind && pronounAction.test(nextText) && !otherSubject.test(nextText) && !tentative.test(nextText)) {
          return { excerpt: excerpt + next, scope: identity.related ? 'related' : 'company', kind: nextKind };
        }
      }
      if (listingTitle.test(normalizedTitle) && groupRelationship.test(tail)) {
        if (next && nextKind && relatedTail.test(nextText) && !otherSubject.test(nextText) && !tentative.test(nextText)) {
          return { excerpt: excerpt + next, scope: 'related', kind: nextKind };
        }
      }
    } else if (titleIdentity && !otherSubject.test(normalized)) {
      const kind = types.find(type => type.claim.test(normalized) && (type.kind !== 'administrative-penalty' || !revoked))?.kind;
      if (!kind) continue;
      if (listingTitle.test(normalizedTitle) && relatedTail.test(normalized)) return { excerpt, scope: 'related', kind };
      if (titleOnlyAuthority.test(normalizedTitle) && /^(?:当事人|该公司|该企业|本局决定对当事人)/.test(normalized)) {
        return { excerpt, scope: titleIdentity.related ? 'related' : 'company', kind };
      }
    }
  }
  return undefined;
}

function pickEvidence(candidates: Candidate[], name: string, query: string): CompanyRecordEvidence[] {
  const seen = new Set<string>();
  const sources: CompanyRecordEvidence[] = [];
  for (const source of candidates) {
    const url = source.url.length <= 2048 ? canonicalSource(source.url) : null;
    if (!url || seen.has(url)) continue;
    const host = new URL(url).hostname;
    if (!/^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/i.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion|bing\.com|so\.com)$/.test(host)) continue;
    const title = originalText(source.title).slice(0, 300);
    const passage = source.excerpts.map(excerpt => companyRecordEvidencePassage(name, query, title, excerpt)).find(Boolean);
    if (!title || !passage) continue;
    seen.add(url);
    sources.push({
      ...passage,
      id: `record-web-${sources.length + 1}`,
      title,
      url,
      retrievedAt: source.retrievedAt,
      ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    });
    if (sources.length === 6) break;
  }
  return sources;
}

const deepseekOrigin = 'https://api.deepseek.com';
function officialDeepSeek(model: SearchModel | null | undefined): model is SearchModel {
  if (!model?.key.trim()) return false;
  try {
    const url = new URL(model.url);
    return url.origin === deepseekOrigin && !url.username && !url.password;
  } catch {
    return false;
  }
}

const responseLimit = 256 * 1024;
async function deepseekCandidates(model: SearchModel, query: string, request: typeof fetch): Promise<Candidate[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      reject(new Error('Public search timeout'));
    }, 8000);
  });
  const fetchCandidates = async () => {
    const response = await request(deepseekOrigin + '/v1/tools/search', {
      method: 'POST',
      redirect: 'manual',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${model.key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, count: 8, need_content: false }),
    });
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > responseLimit) {
      void response.body?.cancel().catch(() => {});
      throw new Error('Public search unavailable');
    }
    controller.signal.throwIfAborted();
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > responseLimit) throw new Error('Public search response too large');
        text += decoder.decode(value, { stream: true });
      }
    } catch (error) {
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const payload = JSON.parse(text + decoder.decode()) as { results?: unknown[] } | null;
    if (!Array.isArray(payload?.results)) throw new Error('Public search response invalid');
    const retrievedAt = new Date().toISOString();
    return payload.results.slice(0, 8).flatMap(raw => {
      const item = raw as Record<string, unknown> | null;
      if (typeof item?.title !== 'string' || typeof item.url !== 'string') return [];
      const excerpts = [item.snippet, item.summary].filter((value): value is string => typeof value === 'string' && !!value.trim())
        .map(value => value.slice(0, 1500));
      const date = typeof item.date === 'string' && item.date.length <= 50 ? Date.parse(item.date) : NaN;
      return [{ title: item.title, url: item.url, excerpts, retrievedAt,
        ...(Number.isFinite(date) ? { publishedAt: new Date(date).toISOString() } : {}) }];
    });
  };
  try {
    return await Promise.race([fetchCandidates(), deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Search output is public-page excerpts, not a regulator-database result. Never sends workspace records. */
export async function searchCompanyRecords(
  deal: Pick<Deal, 'name'>, query: string, options: { request?: typeof fetch; model?: SearchModel | null } = {},
): Promise<CompanyRecordResearch> {
  const name = originalText(deal.name.normalize('NFKC'));
  if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(deal.name) || /["“”]|\b(?:OR|AND|NOT)\b/i.test(name)) {
    return { status: 'failed', sources: [] };
  }
  const types = requestedTypes(query);
  const broad = types === recordTypes;
  const keywords = broad
    ? ['行政处罚', '经营异常名录', '被执行人']
    : types.slice(0, 3).map(type => type.keyword);
  const request = options.request ?? fetch;
  const deepseekQueries = (broad ? keywords.slice(0, 1) : keywords)
    .map(keyword => `"${name}" ${keyword}`).filter(term => [...term].length <= 128);
  const model = options.model;
  let deepseekStatus: CompanyRecordResearch['deepseekStatus'];
  if (officialDeepSeek(model) && deepseekQueries.length) {
    const responses = await Promise.allSettled(deepseekQueries.map(term => deepseekCandidates(model, term, request)));
    const successful = responses.flatMap(response => response.status === 'fulfilled' ? [response.value] : []);
    const failed = successful.length < deepseekQueries.length;
    // Interleave providers' topic rankings so one well-covered topic cannot crowd out other topics.
    const candidates = Array.from({ length: 8 }, (_, index) => successful.flatMap(topic => topic[index] ?? [])).flat();
    const sources = pickEvidence(candidates, name, query);
    if (sources.length) {
      const status = failed || deepseekQueries.length < types.length ? 'partial' : 'completed';
      return { status, sources, provider: 'deepseek' };
    }
    deepseekStatus = failed ? 'failed' : 'empty';
  }
  const search = await searchPublicWeb({ keywords, region: name, platform: 'all' }, request);
  const sources = pickEvidence(search.sources.map(source => ({
    title: source.title, url: source.sourceUrl, excerpts: [source.excerpt],
    retrievedAt: source.retrievedAt, publishedAt: source.publishedAt,
  })), name, query);
  const status = search.status === 'completed' && !broad && keywords.length < types.length ? 'partial' :
    search.status === 'completed' || search.status === 'partial' ? search.status : deepseekStatus === 'empty' ? 'partial' : 'failed';
  return { status, sources, provider: 'bing', ...(deepseekStatus ? { deepseekStatus } : {}) };
}
