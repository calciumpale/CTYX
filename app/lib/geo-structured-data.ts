import type { GeoDocument, GeoPublication } from './geo-types.ts';

export function buildGeoStructuredData({ article, brief }: GeoDocument, publication?: GeoPublication) {
  const headline = article.title.trim();
  const articleBody = article.markdown.trim();
  if (!headline || !articleBody) return null;

  const citation = [...new Set(brief.sources.map(source => source.url.trim()).filter(Boolean))];
  const mainEntity = article.faq.filter(item => item.question.trim() && item.answer.trim()).map(item => ({
    '@type': 'Question', name: item.question.trim(),
    acceptedAnswer: { '@type': 'Answer', text: item.answer.trim() },
  }));
  const page = publication ? { url: publication.url } : {};
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article', ...page, headline, articleBody,
        ...(article.summary.trim() ? { description: article.summary.trim() } : {}),
        ...(citation.length ? { citation } : {}),
      },
      ...(mainEntity.length ? [{ '@type': 'FAQPage', ...page, mainEntity }] : []),
    ],
  };
}
