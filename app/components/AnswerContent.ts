import { createElement } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const components: Components = {
  a({ href, title, children }) {
    return href
      ? createElement('a', { href, title, target: '_blank', rel: 'noopener noreferrer' }, children)
      : createElement('span', null, children);
  },
  img({ alt }) {
    return createElement('span', { className: 'answer-image-alt' }, alt || '图片');
  },
  pre({ children }) {
    return createElement('pre', { tabIndex: 0 }, children);
  },
  table({ children }) {
    return createElement('div', {
      className: 'answer-table-scroll',
      role: 'region',
      'aria-label': '表格内容，可横向滚动',
      tabIndex: 0,
    }, createElement('table', null, children));
  },
};

export function AnswerContent({ text, className = '', compact = false }: {
  text: string;
  className?: string;
  compact?: boolean;
}) {
  return createElement('div', {
    className: ['answer-content', compact && 'answer-content-compact', className].filter(Boolean).join(' '),
  }, createElement('div', { className: 'answer-prose' },
    createElement(Markdown, { remarkPlugins: [remarkGfm], components }, text),
  ));
}
