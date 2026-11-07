import { DomainError } from './domain.ts';
import { assertMemberOrigin, memberResponseHeaders, outerOwnerId } from './member-auth.ts';
import { assertMemberApi, readMemberDisplayName, requireMemberRole } from './member-policy.ts';
import { readMeetingBody } from './meeting-import-validation.ts';
import { readEffectiveModel } from './connection-store.ts';
import type { EffectiveModel } from './connection-config.ts';
import { requestModelText } from './model-client.ts';
import type { ModelMessage } from './model-client.ts';
import { normalizeScheduleDraft, scheduleDate, scheduleDay, scheduleId, scheduleStatus, scheduleVersion } from './schedule-domain.ts';
import { createScheduleStore } from './schedule-store.ts';
import type { ScheduleActor } from './schedule-store.ts';
import { proposeSchedule } from './schedule-assistant.ts';

interface ScheduleDependencies {
  db: D1Database;
  now?: () => string;
  loadWorkspace?: (ownerId: string, origin: string) => Promise<unknown>;
  readModel?: (ownerId: string, origin: string) => Promise<EffectiveModel | null>;
  generateText?: (model: EffectiveModel, messages: ModelMessage[]) => Promise<string>;
}
const json = (value: unknown) => Response.json(value, {headers: memberResponseHeaders});
export function scheduleFailure(error: unknown): Response {
  return Response.json({error: error instanceof DomainError ? error.message : '日程服务暂时不可用，请稍后刷新重试'}, {status: error instanceof DomainError ? error.status : 503, headers: memberResponseHeaders});
}
export function scheduleIdentity(request: Request): ScheduleActor {
  const ownerId = outerOwnerId(request), role = requireMemberRole(request);
  assertMemberApi(role, '/api/schedules', request.method);
  const accountId = request.headers.get('x-ctai-member-account-id')!;
  if (accountId.length > 128) throw new DomainError('登录身份无效，请重新登录', 401);
  return {ownerId, accountId, role, displayName: readMemberDisplayName(request)};
}
function exact(input: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => !(key in input))) throw new DomainError('日程操作字段不完整或包含不支持的字段', 400);
}
export function createScheduleService(deps: ScheduleDependencies) {
  const store = createScheduleStore(deps.db), now = deps.now ?? (() => new Date().toISOString());
  async function handle(request: Request): Promise<Response> {
    try {
      const actor = scheduleIdentity(request), url = new URL(request.url);
      if (url.search.length > 2000) throw new DomainError('日程查询参数过长', 400);
      if (request.method === 'GET') {
        const query = url.searchParams;
        if ([...query.keys()].some(key => !['id', 'from', 'to', 'scope', 'unscheduled', 'cursor'].includes(key) || query.getAll(key).length !== 1)) throw new DomainError('日程查询参数无效', 400);
        const scope = query.get('scope') ?? 'mine';
        if (!['mine', 'team'].includes(scope)) throw new DomainError('日程查看范围无效', 400);
        if (query.has('unscheduled')) {
          if (['id', 'from', 'to'].some(key => query.has(key))) throw new DomainError('按分类读取未安排日程不能同时指定编号或日期范围', 400);
          const kind = query.get('unscheduled');
          if (kind !== 'task' && kind !== 'visit') throw new DomainError('未安排日程分类无效', 400);
          return json(await store.unscheduled(actor, kind, scope as 'mine' | 'team', query.get('cursor') ?? undefined));
        }
        if (query.has('cursor')) throw new DomainError('分页游标仅用于按分类读取未安排日程', 400);
        if (query.has('id')) {
          if (query.has('from') || query.has('to')) throw new DomainError('按编号读取日程不能同时指定日期范围', 400);
          return json({item: await store.get(actor, scheduleId(query.get('id')), scope as 'mine' | 'team')});
        }
        return json(await store.list(actor, query.get('from') ?? '', query.get('to') ?? '', scope as 'mine' | 'team'));
      }
      assertMemberOrigin(request);
      if (url.search) throw new DomainError('保存日程不接受查询参数', 400);
      const input = await readMeetingBody(request, 16384);
      if (typeof input.action !== 'string') throw new DomainError('日程操作无效', 400);
      // Also recheck current membership for read-only suggestions before exposing any context to a model.
      await store.authenticate(actor);
      if (input.action === 'suggest') {
        exact(input, ['action', 'query', 'anchorDate']);
        if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.query)) throw new DomainError('请填写4000字以内的日程安排需求', 400);
        if (typeof input.anchorDate !== 'string') throw new DomainError('日程建议日期无效', 400);
        const anchor = scheduleDate(input.anchorDate);
        await deps.loadWorkspace?.(actor.ownerId, url.origin);
        let model: EffectiveModel | null;
        try { model = await (deps.readModel?.(actor.ownerId, url.origin) ?? Promise.resolve(null)); }
        catch { throw new DomainError('模型配置暂时不可用，请联系管理员在“服务连接”中检查配置', 503); }
        if (!model) throw new DomainError('请先联系管理员在“服务连接”中配置并启用大模型，再使用日程助手', 503);
        // Conflict context is deliberately limited to this member's nearby calendar, not colleagues' private notes.
        const from = scheduleDay(new Date(Date.parse(anchor) - 7 * 86400000).toISOString());
        const to = scheduleDay(new Date(Date.parse(anchor) + 55 * 86400000).toISOString());
        const [page, projects] = await Promise.all([store.list(actor, from, to, 'mine'), store.projects(actor)]);
        const items = [...page.items, ...page.unscheduled].filter(item => item.status === 'pending');
        const generator = deps.generateText ?? requestModelText;
        const suggestion = await proposeSchedule({query: input.query, anchorDate: input.anchorDate, items, projects: projects.map(project => ({...project, name: project.name.slice(0, 160)})), model,
          generateText: async (effective, messages) => {
            try { return await generator(effective, messages); }
            catch { throw new DomainError('日程建议暂时未生成，请稍后重试；尚未保存任何日程', 502); }
          }});
        if (page.truncated) suggestion.warnings.push('附近日程较多，本次只使用了部分记录；确认前请在日历核对时间。');
        return json(suggestion);
      }
      if (input.action === 'create') {
        exact(input, ['action', 'requestId', 'draft']);
        const draft = normalizeScheduleDraft(input.draft), requestId = scheduleId(input.requestId);
        await deps.loadWorkspace?.(actor.ownerId, url.origin);
        return json({item: await store.create(actor, requestId, draft, now()), message: '日程已保存'});
      }
      if (input.action === 'update') {
        exact(input, ['action', 'id', 'version', 'draft']);
        const draft = normalizeScheduleDraft(input.draft), id = scheduleId(input.id), version = scheduleVersion(input.version);
        await deps.loadWorkspace?.(actor.ownerId, url.origin);
        return json({item: await store.update(actor, id, version, draft, now()), message: '日程已更新'});
      }
      if (input.action === 'status') {
        exact(input, ['action', 'id', 'version', 'status']);
        return json({item: await store.status(actor, scheduleId(input.id), scheduleVersion(input.version), scheduleStatus(input.status), now()), message: '日程状态已更新'});
      }
      if (input.action === 'delete' || input.action === 'restore') {
        exact(input, ['action', 'id', 'version']);
        return json({item: await store[input.action](actor, scheduleId(input.id), scheduleVersion(input.version), now()), message: input.action === 'delete' ? '日程已删除，可撤销本次删除' : '日程已恢复'});
      }
      throw new DomainError('不支持的日程操作', 400);
    } catch (error) { return scheduleFailure(error); }
  }
  return {handle};
}
export async function runtimeScheduleService() {
  const {env} = await import('cloudflare:workers');
  const db = (env as {DB?: D1Database}).DB;
  if (!db) throw new DomainError('日程数据库尚未连接，请稍后重试', 503);
  return createScheduleService({db, readModel: readEffectiveModel, loadWorkspace: async (ownerId, origin) => (await import('./server.ts')).loadWorkspace(ownerId, origin)});
}
