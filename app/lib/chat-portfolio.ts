import { redactKnowledgeText } from './knowledge-agent.ts';
import { projectUrgency } from './project-deadline.ts';
import { STAGES, type Deal, type Role } from './types.ts';

const MAX_PROJECTS = 12;
const MAX_PROJECT_BYTES = 12_000;
const encoder = new TextEncoder();
const priorities = { high: 0, medium: 1, low: 2 };
const urgencies = { overdue: 0, urgent: 1, upcoming: 2, none: 3 };
type PortfolioStage = (typeof STAGES)[number] | '未归类';
const stageOf = (stage: string): PortfolioStage => STAGES.find(value => value === stage) ?? '未归类';
const scopeLabel = { owned: '名下未归档项目', workspace: '当前工作空间未归档项目', named: '本轮提及的未归档项目' };
const counts = /(?:项目|线索|商机|方案|合同|回款|示例).{0,12}[\d０-９零〇一二两三四五六七八九十百千万亿]+\s*[个件家笔项]|[\d０-９零〇一二两三四五六七八九十百千万亿]+\s*[个件家笔项].{0,10}(?:项目|线索|商机|方案|合同|回款|示例)/;
const wholeScope = /(?:全部|所有|整体|总体|全量|全盘|整个团队|全团队|全公司|团队整体|整个工作空间).{0,12}(?:项目|商机|漏斗|各阶段|跟进|数量)|(?:项目|商机|漏斗|各阶段).{0,10}(?:整体|全量|全盘|总体)/;
const numberDigits: Record<string, number> = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
const numberUnits: Record<string, number> = { 十:10, 百:100, 千:1000 };
const brief = (value: string, max: number) => {
  const text = redactKnowledgeText(value).trim();
  return text.length <= max ? text : text.slice(0, max).replace(/[\uD800-\uDBFF]$/, '') + '…';
};
const dateOrder = (value: string | undefined) => {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};
const requestedStages = (query: string) => STAGES.filter(stage =>
  new RegExp(`${stage}(?:阶段|中的项目)|(?:处于|进入)${stage}`).test(query),
);

function namePosition(query: string, value: string | undefined): number {
  const name = value?.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  if (!name) return -1;
  // A Latin or numeric prefix is not a match inside a longer name.
  for (let at = query.indexOf(name); at >= 0; at = query.indexOf(name, at + name.length)) {
    if (/^[a-z0-9]/i.test(name) && /[a-z0-9]/i.test(query[at - 1] ?? '')) continue;
    if (/[a-z0-9]$/i.test(name) && /[a-z0-9]/i.test(query[at + name.length] ?? '')) continue;
    return at;
  }
  return -1;
}

function namedProjects(visible: Deal[], question: string) {
  const query = question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
  const matches = visible.map(project => ({ project, projectAt: namePosition(query, project.projectName), nameAt: namePosition(query, project.name) }));
  const exactProjectCompanies = new Set(matches.filter(item => item.projectAt >= 0).map(item => item.project.name));
  return matches.flatMap(({ project, projectAt, nameAt }) => {
    const mention = projectAt >= 0 ? projectAt : exactProjectCompanies.has(project.name) ? -1 : nameAt;
    return mention >= 0 ? [{project, mention}] : [];
  });
}

function projectSummary(project: Deal) {
  return {
    name: brief(project.name, 120),
    ...(project.projectName && project.projectName !== project.name ? { projectName: brief(project.projectName, 120) } : {}),
    stage: stageOf(project.stage),
    dataOrigin: project.dataOrigin ?? 'sample',
    ...(project.dataOrigin === 'research' ? { hasRecordedBusiness: Number.isFinite(Date.parse(project.businessRecordedAt ?? '')) } : {}),
    outcome: project.outcome ?? 'open',
    priority: project.priority,
    health: Number.isFinite(project.health) && project.health > 0 ? project.health : null,
    ...(dateOrder(project.deadline) < Number.MAX_SAFE_INTEGER ? { deadline: project.deadline } : {}),
    ...(dateOrder(project.lastContact) < Number.MAX_SAFE_INTEGER ? { lastContact: project.lastContact } : {}),
    ...(project.owner ? { owner: brief(project.owner, 40) } : {}),
    ...(project.nextAction ? { nextAction: brief(project.nextAction, 120) } : {}),
    ...(project.summary ? { summary: brief(project.summary, 140) } : {}),
    needs: project.needs.slice(0, 2).map(value => brief(value, 75)),
    risks: project.risks.slice(0, 2).map(value => brief(value, 75)),
  };
}

export interface ChatPortfolio {
  scope: 'owned' | 'workspace' | 'named';
  total: number;
  stages: { stage: PortfolioStage; count: number }[];
  origins: { manual: number; research: number; sample: number };
  outcomes: { open: number; won: number; lost: number };
  projects: ReturnType<typeof projectSummary>[];
}

/** The caller supplies only authorized, non-archived projects. Counts cover the complete selected scope. */
export function buildChatPortfolio(visible: Deal[], role: Role, query: string, retrievalQuery: string, now: string): ChatPortfolio {
  const currentMentions = namedProjects(visible, query);
  const includeAll = isWholePortfolioQuery(query);
  const named = currentMentions.length || query === retrievalQuery || includeAll ? currentMentions : namedProjects(visible, retrievalQuery);
  const scope = named.length && !includeAll ? 'named' : role === 'sales' ? 'owned' : 'workspace';
  const mentions = new Map(named.map(item => [item.project.id, item.mention]));
  const selected = scope === 'named' ? named : visible.map(project => ({ project, mention: mentions.get(project.id) ?? -1 }));
  const totals = new Map<PortfolioStage, number>(STAGES.map(stage => [stage, 0]));
  const origins = { manual: 0, research: 0, sample: 0 };
  const outcomes = { open: 0, won: 0, lost: 0 };
  const clock = Date.parse(now);
  const askedStages = new Set(requestedStages(query));
  const ranked = selected.map(({ project, mention }) => {
    const stage = stageOf(project.stage);
    totals.set(stage, (totals.get(stage) ?? 0) + 1);
    origins[project.dataOrigin === 'manual' || project.dataOrigin === 'research' ? project.dataOrigin : 'sample']++;
    outcomes[project.outcome === 'won' || project.outcome === 'lost' ? project.outcome : 'open']++;
    return {
      project, mention,
      matchesStage: stage !== '未归类' && askedStages.has(stage),
      active: project.outcome !== 'won' && project.outcome !== 'lost',
      urgency: urgencies[projectUrgency(project, clock)],
      priority: priorities[project.priority] ?? priorities.medium,
      deadline: dateOrder(project.deadline),
    };
  });
  ranked.sort((a, b) => (a.mention < 0 ? Number.MAX_SAFE_INTEGER : a.mention) - (b.mention < 0 ? Number.MAX_SAFE_INTEGER : b.mention) ||
    Number(b.matchesStage) - Number(a.matchesStage) || Number(b.active) - Number(a.active) ||
    a.urgency - b.urgency || a.priority - b.priority || a.deadline - b.deadline ||
    b.project.health - a.project.health || a.project.id.localeCompare(b.project.id));
  const projects: ChatPortfolio['projects'] = [];
  let remaining = MAX_PROJECT_BYTES;
  for (const item of ranked.slice(0, MAX_PROJECTS)) {
    const summary = projectSummary(item.project);
    const bytes = encoder.encode(JSON.stringify(summary)).length + 1;
    if (bytes > remaining) break;
    projects.push(summary);
    remaining -= bytes;
  }
  const stages = [...totals].map(([stage, count]) => ({ stage, count }));
  return { scope, total: selected.length, stages, origins, outcomes, projects };
}

function portfolioCountFacts(portfolio: ChatPortfolio) {
  const group = (label: string, count: number) => ({ label, count, suffix: '' });
  return [
    group(scopeLabel[portfolio.scope], portfolio.total),
    ...portfolio.stages.map(({ stage, count }) => ({ label: `${stage}阶段`, count, suffix: '项目' })),
    group('手工录入项目', portfolio.origins.manual), group('公开来源项目', portfolio.origins.research), group('合成示例项目', portfolio.origins.sample),
    group('未结束项目', portfolio.outcomes.open), group('已成单项目', portfolio.outcomes.won), group('已关闭未成交项目', portfolio.outcomes.lost),
  ];
}

export function portfolioCountStatements(portfolio: ChatPortfolio): string[] {
  return portfolioCountFacts(portfolio).map(({label,count,suffix}, index) => `${label}${index===0?'共':''}${count}个${suffix}。`);
}

export function portfolioCountFallback(portfolio: ChatPortfolio, query: string): string {
  const [total, ...counts] = portfolioCountStatements(portfolio);
  const stages = requestedStages(query);
  const distribution = /各阶段|阶段分布|漏斗分布|分阶段|按(?:销售)?阶段/.test(query);
  const primary = distribution ? [total, ...counts.slice(0, portfolio.stages.length)]
    : stages.length ? [total, ...counts.slice(0, portfolio.stages.length).filter((_, index) => stages.some(stage => stage === portfolio.stages[index].stage))]
      : [total];
  return [...primary, `以上统计按当前权限内的未归档项目计，分别包含手工录入项目${portfolio.origins.manual}个、公开来源项目${portfolio.origins.research}个和合成示例项目${portfolio.origins.sample}个，不代表实际成交或采购意向。`].join('\n');
}

function readCount(value: string): number | undefined {
  if (/^\d+$/.test(value)) return Number(value);
  if (/^[零〇一二两三四五六七八九]+$/.test(value)) return Number([...value].map(digit => numberDigits[digit]).join(''));
  if (!/^(?:[一二两三四五六七八九]千)?(?:[零〇])?(?:[一二两三四五六七八九]百)?(?:[零〇])?(?:(?:[一二两三四五六七八九])?十)?[一二两三四五六七八九]?$/.test(value)) return undefined;
  const parts = [...value.matchAll(/([一二两三四五六七八九]?)(千|百|十|$)/g)].filter(match=>match[0]);
  return parts.length ? parts.reduce((sum, [, digit, unit]) => sum + (numberDigits[digit] ?? 1) * (numberUnits[unit] ?? 1), 0) : undefined;
}

export function verifiedPortfolioCount(text: string, portfolio: ChatPortfolio): boolean {
  const line = text.normalize('NFKC').replace(/\*\*/g, '').replace(/\s+/g, '').replace(/[。！!?？;；]$/, '');
  for (const { label, count, suffix } of portfolioCountFacts(portfolio)) {
    const match = new RegExp(`^${label}(?:共有|一共有|一共|共计|合计|总计|共|有|为|:)?([0-9零〇一二两三四五六七八九十百千]+)(?:个|项|条)${suffix ? '(?:项目)?' : ''}$`).exec(line);
    if (match && readCount(match[1]) === count) return true;
  }
  return false;
}

export function isPortfolioCount(text: string): boolean {
  return counts.test(text);
}

export function isPortfolioCountQuestion(query: string): boolean {
  return /(?:项目|商机|线索|漏斗|阶段).{0,16}(?:数量|总数|多少|几个|有几|共几|分布|统计)|(?:数量|总数|统计|多少|几个|有几|共几).{0,12}(?:项目|商机|线索|漏斗|阶段)/.test(query);
}

export function isWholePortfolioQuery(query: string): boolean {
  return wholeScope.test(query);
}
