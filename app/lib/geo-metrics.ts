import type { GeoAnswer, GeoPhase, GeoWorkflow } from './geo-types.ts';

function totals(answers: GeoAnswer[], rankKnown: (answer: GeoAnswer, index: number) => boolean = knownRank, citationsKnown: (answer: GeoAnswer, index: number) => boolean = knownCitations) {
  const samples = answers.length;
  const mentions = answers.filter(answer => answer.brandMentions > 0).length;
  const rankSamples = answers.filter(rankKnown);
  const citedSamples = answers.filter(citationsKnown);
  const firstRecommendations = rankSamples.filter(answer => answer.brandRank === 1).length;
  const citations = citedSamples.filter(answer => answer.citations.some(citation => citation.brandSource)).length;
  const firstRecommendationSamples = rankSamples.length;
  const citationSamples = citedSamples.length;
  const rate = (count: number, denominator: number) => denominator ? Math.round(1000 * count / denominator) / 10 : null;
  return { samples, mentions, firstRecommendations, citations, firstRecommendationSamples, citationSamples,
    mentionRate: rate(mentions, samples), firstRecommendationRate: rate(firstRecommendations, firstRecommendationSamples), citationRate: rate(citations, citationSamples) };
}

const knownRank = (answer: GeoAnswer) => answer.method !== 'apimart' || answer.brandMentions === 0 || answer.brandRank !== null;
const knownCitations = (answer: GeoAnswer) => answer.method !== 'apimart' || answer.provenance?.annotations === 'provider';

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

export function geoComparableSampleKey(answer: GeoAnswer): string {
  const source = answer.method === 'apimart' ? answer.provenance : undefined;
  return JSON.stringify([geoSampleKey(answer), answer.method ?? 'manual', source?.provider, source?.model, source?.webSearch]);
}

export function compareGeoMetrics(workflow: GeoWorkflow, brand?: string) {
  const answers = brand === undefined ? workflow.answers : workflow.answers.filter(answer => answer.brand === brand);
  const baseline = new Map(answers.filter(answer => answer.phase === 'baseline').map(answer => [geoComparableSampleKey(answer), answer]));
  const retest = answers.filter(answer => answer.phase === 'retest' && baseline.has(geoComparableSampleKey(answer)));
  const beforeAnswers = retest.map(answer => baseline.get(geoComparableSampleKey(answer))!);
  const pairRanksKnown = (_: GeoAnswer, index: number) => knownRank(beforeAnswers[index]) && knownRank(retest[index]);
  const pairCitationsKnown = (_: GeoAnswer, index: number) => knownCitations(beforeAnswers[index]) && knownCitations(retest[index]);
  const before = totals(beforeAnswers, pairRanksKnown, pairCitationsKnown);
  const after = totals(retest, pairRanksKnown, pairCitationsKnown);
  const delta = (initial: number | null, final: number | null) => initial === null || final === null ? null : Math.round((final - initial) * 10) / 10;
  return { samples: retest.length, baseline: before, retest: after, mentionDelta: delta(before.mentionRate, after.mentionRate),
    firstRecommendationDelta: delta(before.firstRecommendationRate, after.firstRecommendationRate), citationDelta: delta(before.citationRate, after.citationRate) };
}
