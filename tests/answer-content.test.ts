import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AnswerContent } from '../app/components/AnswerContent.ts';

function render(text: string, props: { className?: string; compact?: boolean } = {}) {
  return renderToStaticMarkup(createElement(AnswerContent, { text, ...props }));
}

test('renders saved Markdown answers as headings, emphasis and nested lists', () => {
  const html = render(`## 客户需求分析

这次沟通的**核心目标**是明确预算与决策流程。

### 建议跟进动作

1. 确认采购时间
   - 向业务负责人核实
   - 记录内部审批节点
2. 发送方案摘要

> 具体价格需要经理确认。`);

  assert.match(html, /<h2>客户需求分析<\/h2>/);
  assert.match(html, /<h3>建议跟进动作<\/h3>/);
  assert.match(html, /<strong>核心目标<\/strong>/);
  assert.match(html, /<ol>\s*<li>确认采购时间\s*<ul>\s*<li>向业务负责人核实<\/li>\s*<li>记录内部审批节点<\/li>\s*<\/ul>\s*<\/li>\s*<li>发送方案摘要<\/li>\s*<\/ol>/);
  assert.match(html, /<blockquote>\s*<p>具体价格需要经理确认。<\/p>\s*<\/blockquote>/);
  assert.doesNotMatch(html, /## 客户需求分析|\*\*核心目标\*\*/);
});

test('puts GFM tables in a labeled keyboard-focusable scrolling region', () => {
  const html = render(`| 客户 | 下一步 |
| --- | --- |
| 澄光咖啡 | 确认预算 |
| 原野科技 | 补充方案 |`);

  assert.match(html, /<div(?=[^>]*class="answer-table-scroll")(?=[^>]*tabindex="0")(?=[^>]*role="region")(?=[^>]*aria-label="[^"]+")[^>]*><table>/);
  assert.match(html, /<thead><tr><th>客户<\/th><th>下一步<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>澄光咖啡<\/td><td>确认预算<\/td>/);
  assert.match(html, /<\/table><\/div>/);
});

test('keeps inline and fenced code literal instead of parsing their Markdown', () => {
  const html = render('使用 `**原样保留**` 字段。\n\n```ts\nconst sample = "## 标题";\n  if (a < 2) return "**粗体**";\n```');

  assert.match(html, /<code>\*\*原样保留\*\*<\/code>/);
  assert.match(html, /<pre[^>]*><code class="language-ts">const sample = &quot;## 标题&quot;;\n  if \(a &lt; 2\) return &quot;\*\*粗体\*\*&quot;;\n<\/code><\/pre>/);
  assert.doesNotMatch(html, /<strong>|<h2>/);
});

test('opens allowed links safely and keeps unsafe URLs inert', () => {
  const html = render('[官网](https://example.com/path?q=1) · [邮件](mailto:team@example.com) · [危险](javascript:alert%281%29) · [数据](data:text/html,test)');

  assert.match(html, /<a(?=[^>]*href="https:\/\/example.com\/path\?q=1")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>官网<\/a>/);
  assert.match(html, /<a(?=[^>]*href="mailto:team@example.com")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>邮件<\/a>/);
  assert.doesNotMatch(html, /href="(?:javascript:|data:)/i);
  assert.match(html, /危险/);
  assert.match(html, /数据/);
});

test('does not execute raw HTML or request Markdown images', () => {
  const html = render('<script>alert("xss")</script>\n\n<img src="https://tracking.example/pixel" onerror="alert(1)">\n\n![客户需求示意图](https://tracking.example/image.png)');

  assert.doesNotMatch(html, /<script|<img|<iframe|<link/i);
  assert.doesNotMatch(html, /<\w+[^>]*\sonerror=/i);
  assert.match(html, /客户需求示意图/);
});

test('preserves plain-text wording and single newlines in both answer sizes', () => {
  const text = '已确认预算 30 万元。\n下一步：周三联系客户。\n保留 R&D 和 1 < 2。';
  for (const compact of [false, true]) {
    const html = render(text, { className: 'assistant-answer', compact });
    assert.match(html, /class="answer-content(?: answer-content-compact)? assistant-answer"/);
    assert.match(html, /<div class="answer-prose"><p>已确认预算 30 万元。\n下一步：周三联系客户。\n保留 R&amp;D 和 1 &lt; 2。<\/p><\/div>/);
  }
});
