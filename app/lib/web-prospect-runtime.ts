import { env } from 'cloudflare:workers';
import { DomainError } from './domain.ts';
import { requireUserId } from './server.ts';
import { requireMemberRole, readMemberSalesScope } from './member-policy.ts';
import { createWebProspectStore,verifyWebProspectMember } from './web-prospect-store.ts';
import { createWebProspectService } from './web-prospect-service.ts';
import type { WebProspectActor } from './web-prospect-service.ts';
export async function webProspectRuntime(request: Request) { const db = (env as {
    DB?: D1Database;
}).DB; if (!db)
    throw new DomainError('公开搜索存储尚未连接', 503); const ownerId = requireUserId(request), role = requireMemberRole(request), memberId = request.headers.get('x-ctai-member-account-id')!; if (role === 'admin')
    throw new DomainError('当前账号无业务搜索权限', 403); const scope=readMemberSalesScope(request);const row=await verifyWebProspectMember(db,ownerId,memberId,role,scope?.salesId); const actor: WebProspectActor = { ownerId, memberId, role, ...(row.sales_id ? { salesId: row.sales_id } : {}) }; const store = createWebProspectStore(db); const owners = role === 'manager' ? (await db.prepare("SELECT sales_id,display_name FROM workbench_member_accounts WHERE owner_id=? AND enabled=1 AND role='sales' AND sales_id IS NOT NULL").bind(ownerId).all<{
    sales_id: string;
    display_name: string;
}>()).results.map(r => ({ salesId: r.sales_id, displayName: r.display_name })) : []; return { store, service: createWebProspectService(store), actor, owners }; }
