import { DomainError } from './domain.ts';
import { validateSearch, searchPublicWeb } from './web-prospect-search.ts';
import type { WebProspectStore } from './web-prospect-store.ts';
import type { WebProspectTask, WebProspectLead } from './web-prospect-types.ts';
export interface WebProspectActor {
    ownerId: string;
    memberId: string;
    role: 'sales' | 'manager';
    salesId?: string;
}
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map(x => x.toString(16).padStart(2, '0')).join('');
export function createWebProspectService(store: WebProspectStore, request: typeof fetch = fetch) {
    return { async execute(actor: WebProspectActor, body: Record<string, unknown>) {
            const { ownerId: owner, memberId: member } = actor;
            if (body.action === 'search') {
                const input = validateSearch(body);
                if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId))
                    throw new DomainError('请求标识无效');
                const payloadHash = await hash(JSON.stringify(input));
                const previous = await store.identity(owner, member, body.requestId);
                if (previous) {
                    if (previous.payloadHash !== payloadHash)
                        throw new DomainError('相同请求标识对应不同搜索条件', 409);
                    return store.snapshot(owner, member);
                }
                await store.expire(owner, member);
                const now = new Date().toISOString();
                const task: WebProspectTask = { ...input, id: crypto.randomUUID(), ownerId: owner, memberId: member, requestId: body.requestId, payloadHash, status: 'running', errors: [], createdAt: now, updatedAt: now, resultCount: 0 };
                if (!await store.insert(task)) {
                    const prior = await store.identity(owner, member, body.requestId);
                    if (prior?.payloadHash === payloadHash)
                        return store.snapshot(owner, member);
                    throw new DomainError('已有搜索运行中，或距上次搜索不足30秒', 429);
                }
                const result = await searchPublicWeb(input, request);
                const leads: WebProspectLead[] = await Promise.all(result.sources.map(async (source) => ({ ...source, id: 'web-' + await hash(`${owner}\n${member}\n${source.sourceUrl}`), taskId: task.id, ownerId: owner, memberId: member, version: 1, status: 'new' })));
                await store.finish({ ...task, status: result.status, errors: result.errors, updatedAt: new Date().toISOString(), resultCount: leads.length }, leads);
                return store.snapshot(owner, member);
            }
            if (typeof body.leadId !== 'string' || !Number.isSafeInteger(body.version) || (body.version as number) < 1)
                throw new DomainError('线索标识或版本无效');
            if (body.action === 'review') {
                if (!['new', 'qualified', 'ignored'].includes(String(body.status)))
                    throw new DomainError('审核状态无效');
                await store.review(owner, member, body.leadId, body.version as number, body.status as WebProspectLead['status']);
                return store.snapshot(owner, member);
            }
            if (body.action === 'convert') {
                const lead = await store.getLead(owner, member, body.leadId);
                if (lead.projectId)
                    return store.snapshot(owner, member);
                if (lead.version !== body.version || lead.status !== 'qualified')
                    throw new DomainError('请先审核为有效线索并刷新版本', 409);
                const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 100 && !/[\u0000-\u001f\u007f]/.test(v);
                if (!text(body.companyName) || !text(body.projectName))
                    throw new DomainError('请明确填写企业名称和项目名称');
                const salesId = actor.role === 'sales' ? actor.salesId : body.salesId;
                if (typeof salesId !== 'string' || !salesId || actor.role === 'sales' && body.salesId !== undefined && body.salesId !== actor.salesId)
                    throw new DomainError('销售归属无效', 403);
                await store.convert(lead, (body.companyName as string).trim(), (body.projectName as string).trim(), salesId);
                return store.snapshot(owner, member);
            }
            throw new DomainError('操作无效');
        } };
}
