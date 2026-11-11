import { redactKnowledgeText } from './knowledge-agent.ts';
import type { PropertyQuery } from './property-query.ts';
import type { PropertyRow } from './property-records.ts';

const blockLabel = /^(?:区块|项目名称|所属项目|园区名称|所在区域|区域|商圈)$/;
const addressLabel = /^(?:地址|详细地址|商铺地址|房源地址|位置|地理位置|坐落|门牌号)$/;
const unitLabel = /^(?:铺号|铺位号|商铺编号|房号|房源编号|单元号)$/;

function publicField(row: PropertyRow, labels: RegExp): string {
  const value = row.fields.find(field => labels.test(field.label.trim()))?.value.trim() ?? '';
  if (/\p{Cc}|https?:\/\/|www\.|内部|保密|仅供|不得外传/iu.test(value) || redactKnowledgeText(value) !== value) return '';
  return value;
}

/** Build a short customer reply from public fields of a single matched row. */
export function formatCustomerPropertyReply(
  matches: PropertyRow[],
  query: PropertyQuery,
  complete: boolean,
  maxChars: number,
): {answer:string; rows:PropertyRow[]} {
  const row = matches[query.page - 1];
  if (!row) return {answer:'', rows:[]};
  const area = row.area;
  const size = area && !area.approximate
    ? `面积${area.min}${area.max !== area.min ? `–${area.max}` : ''}${area.unit === 'sqm' ? '㎡' : '（单位未标）'}`
    : '';
  const block = publicField(row, blockLabel);
  const address = publicField(row, addressLabel);
  const unit = publicField(row, unitLabel);
  const location = address || unit;
  const fullLocation = block && location && !location.includes(block) ? block + location : location || block;
  const scope = {vacant:'空置表', rented:'在租表', any:'房源表'}[query.status];
  const count = complete ? `匹配${matches.length}条` : `已查到${matches.length}条`;
  const prefix = `${scope}${count}${matches.length > 1 ? '，如' : '，'}`;
  const suffix = '。现况待核实。';
  const details = [
    [fullLocation, size],
    [location, size],
    [block, size],
  ];
  for (const [place, areaText] of details) {
    if (!place) continue;
    const answer = prefix + [place, areaText].filter(Boolean).join('，') + suffix;
    if (answer.length <= maxChars) return {answer, rows:[row]};
  }
  return {answer:'', rows:[]};
}
