import { DomainError } from './domain.ts';
import type { WebSearchInput, WebPlatform, WebProspectSource, WebProspectTask } from './web-prospect-types.ts';
export const WEB_HOSTS: Partial<Record<WebPlatform, string[]>> = { tieba: ['tieba.baidu.com'], xiaohongshu: ['xiaohongshu.com', 'xhslink.com'], zhihu: ['zhihu.com'], weibo: ['weibo.com', 'weibo.cn'] };
const natural = (v: unknown, max: number) => typeof v === 'string' && v.trim().length <= max && !/[\u0000-\u001f\u007f:：|(){}<>\\/"“”]/.test(v) && !/(?:\b(?:OR|AND|NOT)\b|[+*-]|https?)/i.test(v);
export function validateSearch(raw: Record<string, unknown>): WebSearchInput { if (!Array.isArray(raw.keywords) || !raw.keywords.length || raw.keywords.length > 5 || raw.keywords.some(v => !natural(v, 40) || !v.trim()))
    throw new DomainError('关键词需为1–5个自然语言短语，每个最多40字，不支持网址或搜索操作符'); const region = raw.region ?? ''; if (!natural(region, 60))
    throw new DomainError('地区最多60字，不支持搜索操作符'); const platform = raw.platform ?? 'all'; if (!['all', 'tieba', 'xiaohongshu', 'zhihu', 'weibo', 'other'].includes(String(platform)))
    throw new DomainError('平台无效'); if (platform === 'tieba' && !(region as string).trim())
    throw new DomainError('搜索贴吧请填写地区'); return { keywords: [...new Set((raw.keywords as string[]).map(v => v.trim()))], region: (region as string).trim(), platform: platform as WebPlatform }; }
export function canonicalSource(value: string): string | null { try {
    const u = new URL(value);
    u.hostname = u.hostname.toLowerCase().replace(/\.+$/, '');
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.port || !u.hostname.includes('.') || /^(?:localhost|\d+(?:\.\d+){3})$/.test(u.hostname) || u.hostname.includes(':'))
        return null;
    u.hash = '';
    for (const key of [...u.searchParams.keys()])
        if (/^(utm_|fbclid|gclid)/i.test(key))
            u.searchParams.delete(key);
    u.searchParams.sort();
    return u.href;
}
catch {
    return null;
} }
const matchHost = (host: string, root: string) => host === root || host.endsWith('.' + root);
export function sourcePlatform(url: string): WebPlatform { const host = new URL(url).hostname; return (Object.entries(WEB_HOSTS).find(([, hosts]) => hosts.some(h => matchHost(host, h)))?.[0] ?? 'other') as WebPlatform; }
const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&#(x[0-9a-f]+|\d+);/gi, (_, v) => { const n = v[0].toLowerCase() === 'x' ? parseInt(v.slice(1), 16) : Number(v); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''; }).replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e]!);
const plain = (s: string, max: number) => decode(s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const field = (item: string, name: string) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(item)?.[1] ?? '';
/** Validate the complete bounded RSS envelope before accounting it as a successful query. */
function validateRssDocument(xml:string):void {
    const invalid=():never=>{throw new Error('搜索源格式无效');};
    if(xml.length>262144 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|<!DOCTYPE|<!ENTITY/i.test(xml))invalid();
    const tokens=/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][A-Za-z0-9_.:-]*(?:\s+[A-Za-z_][A-Za-z0-9_.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/gy;
    const stack:string[]=[];
    let offset=0,root=false,channels=0;
    const validEntities=(value:string)=>! /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value);
    while(offset<xml.length){
        tokens.lastIndex=offset;
        const match=tokens.exec(xml);
        if(!match)invalid();
        const token=match![0];offset=tokens.lastIndex;
        if(token.startsWith('<!--')){if(token.slice(4,-3).includes('--'))invalid();continue;}
        if(token.startsWith('<?')){if(/^<\?xml\b/i.test(token)&&root)invalid();continue;}
        if(token.startsWith('<![CDATA[')){if(!stack.length)invalid();continue;}
        if(!token.startsWith('<')){if((!stack.length&&token.trim())||!validEntities(token)||token.includes(']]>'))invalid();continue;}
        if(!validEntities(token))invalid();
        const attributes=new Set<string>();
        for(const attribute of token.matchAll(/\s+([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"[^"]*"|'[^']*')/g)){if(attributes.has(attribute[1]))invalid();attributes.add(attribute[1]);}
        const name=/^<\/?([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(token)![1];
        if(token.startsWith('</')){if(!/^<\/[A-Za-z_][A-Za-z0-9_.:-]*\s*>$/.test(token)||stack.pop()!==name)invalid();continue;}
        if(!stack.length){if(root||name!=='rss')invalid();root=true;}
        if(name==='channel'){if(stack.length!==1||stack[0]!=='rss'||++channels!==1)invalid();}
        if(!/\/>$/.test(token)){stack.push(name);if(stack.length>64)invalid();}
    }
    if(stack.length||!root||channels!==1)invalid();
}
export function parseRss(xml: string, input: WebSearchInput, query: string): WebProspectSource[] { validateRssDocument(xml); const sources: WebProspectSource[] = []; const seen = new Set<string>(); for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const item = match[1], url = canonicalSource(decode(field(item, 'link')).trim());
    if (!url || seen.has(url))
        continue;
    const platform = sourcePlatform(url);
    if (input.platform !== 'all' && input.platform !== platform)
        continue;
    const title = plain(field(item, 'title'), 300), excerpt = plain(field(item, 'description'), 1500);
    if (!title && !excerpt)
        continue;
    const regionMatch = !!input.region && `${title} ${excerpt}`.normalize('NFKC').includes(input.region.normalize('NFKC'));
    const date = Date.parse(plain(field(item, 'pubDate'), 100));
    sources.push({ sourceUrl: url, title, excerpt, platform, query, region: input.region, regionMatch: regionMatch ? 'confirmed' : 'unverified', regionEvidence: regionMatch ? `${title} ${excerpt}`.slice(0, 1800) : '', retrievedAt: new Date().toISOString(), ...(Number.isFinite(date) ? { publishedAt: new Date(date).toISOString() } : {}) });
    seen.add(url);
    if (sources.length === 50)
        break;
} return sources; }
async function readBounded(response: Response, signal: AbortSignal): Promise<string> { if (!response.ok || response.status >= 300)
    throw new Error('搜索源不可用'); const reader = response.body?.getReader(); if (!reader)
    throw new Error('搜索源为空'); let size = 0; const chunks: Uint8Array[] = []; try {
    while (true) {
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done)
            break;
        size += value.byteLength;
        if (size > 262144)
            throw new Error('搜索源响应超限');
        chunks.push(value);
    }
}
catch (e) {
    await reader.cancel().catch(() => { });
    throw e;
} const buffer = new Uint8Array(size); let i = 0; for (const chunk of chunks) {
    buffer.set(chunk, i);
    i += chunk.length;
} return new TextDecoder().decode(buffer); }
export async function searchPublicWeb(input: WebSearchInput, request: typeof fetch = fetch): Promise<{
    status: WebProspectTask['status'];
    sources: WebProspectSource[];
    errors: string[];
}> { const errors: string[] = [], sources: WebProspectSource[] = []; let successes = 0, cursor = 0; const overall = AbortSignal.timeout(25000); await Promise.all(Array.from({ length: Math.min(2, input.keywords.length) }, async () => { while (cursor < input.keywords.length) {
    const keyword = input.keywords[cursor++];
    try {
        overall.throwIfAborted();
        const query = [`"${keyword}"`, input.region ? `"${input.region}"` : '', ...(WEB_HOSTS[input.platform]?.length ? [`site:${WEB_HOSTS[input.platform]![0]}`] : [])].filter(Boolean).join(' ');
        const url = new URL('https://www.bing.com/search');
        url.searchParams.set('format', 'rss');
        url.searchParams.set('q', query);
        const signal = AbortSignal.any([overall, AbortSignal.timeout(8000)]);
        const timeout = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('搜索超时')), { once: true }));
        const result = await Promise.race([(async () => { let response = await request(url, { signal, redirect: 'manual', headers: { Accept: 'application/rss+xml' } }); if ([301, 302, 307, 308].includes(response.status)) {
                const destination = new URL(response.headers.get('location') ?? '', url);
                if (destination.origin !== 'https://cn.bing.com' || destination.pathname !== '/search' || destination.username || destination.password)
                    throw new Error('搜索源重定向无效');
                await response.body?.cancel();
                const regional = new URL(url);
                regional.hostname = 'cn.bing.com';
                response = await request(regional, { signal, redirect: 'manual', headers: { Accept: 'application/rss+xml' } });
            } return parseRss(await readBounded(response, signal), input, query); })(), timeout]);
        sources.push(...result);
        successes++;
    }
    catch {
        errors.push(`关键词「${keyword}」搜索失败或超时，请稍后重试`);
    }
} })); const unique = [...new Map(sources.map(s => [s.sourceUrl, s])).values()].slice(0, 50); return { status: errors.length ? successes ? 'partial' : 'failed' : 'completed', sources: unique, errors }; }
