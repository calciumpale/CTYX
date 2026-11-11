import { redactKnowledgeText } from './knowledge-agent.ts';
import type { PropertyQuery } from './property-query.ts';
import type { PropertyRow } from './property-records.ts';

const blockLabel = /^(?:区块|项目名称|所属项目|园区名称|所在区域|区域|商圈)$/;
const addressLabel = /^(?:地址|详细地址|商铺地址|房源地址|位置|地理位置|坐落|门牌号)$/;
const unitLabel = /^(?:铺号|铺位号|商铺编号|房号|房源编号|单元号)$/;

function publicField(row: PropertyRow, labels: RegExp): string {
  const value = row.fields.find(field => labels.test(field.label.trim()))?.value.trim() ?? '';
  if (/[\p{Cc}\p{Zl}\p{Zp}]|https?:\/\/|www\.|内部|保密|仅供|不得外传/iu.test(value) || redactKnowledgeText(value) !== value) return '';
  return value;
}

function formatPublicRow(row: PropertyRow, budget: number): string | undefined {
  const area = row.area;
  const size = area && !area.approximate
    ? `面积${area.min}${area.max !== area.min ? `–${area.max}` : ''}${area.unit === 'sqm' ? '㎡' : '（单位未标）'}`
    : '';
  const block = publicField(row, blockLabel);
  const address = publicField(row, addressLabel);
  const unit = publicField(row, unitLabel);
  const location = address || unit;
  const fullLocation = block && location && !location.includes(block) ? block + location : location || block;
  const usage = publicField(row, /^建议业态$/);
  const details = [
    [fullLocation, size, usage ? `建议业态${usage}` : ''],
    [fullLocation, size],
    [location, size],
    [block, size],
  ];
  for (const fields of details) {
    if (!fields[0]) continue;
    const line = fields.filter(Boolean).join('，');
    if (line.length <= budget) return line;
  }
}

/** Paginate complete public rows into a single paragraph for the private message composer. */
export function formatCustomerPropertyReply(
  matches: PropertyRow[],
  query: PropertyQuery,
  complete: boolean,
  maxChars: number,
): {answer:string; rows:PropertyRow[]} {
  const scope = {vacant:'空置表', rented:'在租表', any:'房源表'}[query.status];
  const count = complete ? `匹配${matches.length}条` : `已查到${matches.length}条`;
  const header = `${scope}${count}。`;
  const separator = '。';
  const footer = `${separator}现况待核实。`;
  const next = '还有匹配，回复“下一页”查看。';
  const bodyBudget = maxChars - header.length - footer.length - (matches.length > 1 ? next.length : 0);
  const pages: {rows:PropertyRow[]; lines:string[]; length:number}[] = [];
  let page = {rows:[] as PropertyRow[], lines:[] as string[], length:0};
  for (const row of matches) {
    const line = formatPublicRow(row, bodyBudget);
    if (!line) continue;
    if (page.lines.length && (page.lines.length >= query.pageSize || page.length + separator.length + line.length > bodyBudget)) {
      pages.push(page);
      page = {rows:[], lines:[], length:0};
    }
    page.length += line.length + (page.lines.length ? separator.length : 0);
    page.rows.push(row);
    page.lines.push(line);
  }
  if (page.lines.length) pages.push(page);
  const selected = pages[query.page - 1];
  if (!selected) return {answer:'', rows:[]};
  return {
    answer: header + selected.lines.join(separator) + footer + (query.page < pages.length ? next : ''),
    rows: selected.rows,
  };
}
