import type { GeoAnswer, GeoPhase, GeoWorkflow } from './geo-types.ts';

function totals(answers: GeoAnswer[]) {
  const samples = answers.length;
  const mentions = answers.filter(answer => answer.brandMentions > 0).length;
  const firstRecommendations = answers.filter(answer => answer.brandRank === 1).length;
  const citations = answers.filter(answer => answer.citations.some(citation => citation.brandSource)).length;
  const rate = (count: number) => samples ? Math.round(1000 * count / samples) / 10 : null;
  return { samples, mentions, firstRecommendations, citations, mentionRate: rate(mentions), firstRecommendationRate: rate(firstRecommendations), citationRate: rate(citations) };
}

function grouped(answers: GeoAnswer[], attribute: 'engine' | 'intent') {
  const groups = new Map<string, GeoAnswer[]>();
  for (const answer of answers) {
    const group = groups.get(answer[attribute]) ?? [];
    group.push(answer);
    groups.set(answer[attribute], group);
  }
  return Object.fromEntries([...groups].map(([label, samples]) => [label, totals(samples)]));
}

export function computeGeoMetrics(workflow: GeoWorkflow, phase: GeoPhase, brand?: string) {
  const answers = workflow.answers.filter(answer => answer.phase === phase && (brand === undefined || answer.brand === brand));
  return { ...totals(answers), byEngine: grouped(answers, 'engine'), byIntent: grouped(answers, 'intent') };
}

export function geoSampleKey(answer: Pick<GeoAnswer, 'brand' | 'questionId' | 'prompt' | 'intent' | 'dimension' | 'engine' | 'sample'>): string {
  return JSON.stringify([answer.brand, answer.questionId, answer.prompt, answer.intent, answer.dimension, answer.engine, answer.sample]);
}

export function compareGeoMetrics(workflow: GeoWorkflow, brand?: string) {
  const answers = brand === undefined ? workflow.answers : workflow.answers.filter(answer => answer.brand === brand);
  const baseline = new Map(answers.filter(answer => answer.phase === 'baseline').map(answer => [geoSampleKey(answer), answer]));
  const retest = answers.filter(answer => answer.phase === 'retest' && baseline.has(geoSampleKey(answer)));
  const before = totals(retest.map(answer => baseline.get(geoSampleKey(answer))!));
  const after = totals(retest);
  const delta = (initial: number | null, final: number | null) => initial === null || final === null ? null : Math.round((final - initial) * 10) / 10;
  return { samples: retest.length, baseline: before, retest: after, mentionDelta: delta(before.mentionRate, after.mentionRate),
    firstRecommendationDelta: delta(before.firstRecommendationRate, after.firstRecommendationRate), citationDelta: delta(before.citationRate, after.citationRate) };
}
