import { DomainError } from './domain.ts';
import type { createMomentStore } from './moments-store.ts';
import type { momentGeneration } from './moments-generation.ts';
import type { MomentStoredDraft } from './moments-types.ts';
import { momentId, momentVersion, parseMomentPlan, publicMomentDraft } from './moments.ts';

const imagePending = new Set(['submitting', 'queued', 'processing', 'saving']);
const stamp = () => new Date().toISOString();
const later = (value: string, delay: number) => new Date(Date.parse(value) + delay).toISOString();

export function createMomentService(store: ReturnType<typeof createMomentStore>, generation: ReturnType<typeof momentGeneration>, now = stamp) {
  async function snapshot(owner: string, member: string) {
    const [plans, drafts, availability] = await Promise.all([
      store.listPlans(owner, member), store.listDrafts(owner, member), generation.availability(owner),
    ]);
    return { plans, drafts: drafts.map(publicMomentDraft), availability };
  }

  async function advance(draft: MomentStoredDraft): Promise<MomentStoredDraft> {
    const started = now();
    if (!['queued', 'writing', 'image_pending'].includes(draft.status) || draft.nextCheckAt && draft.nextCheckAt > started) return draft;
    const lease = await store.reserveDraft(draft, started);
    if (!lease) return store.getDraft(draft.ownerId, draft.memberId, draft.id);

    if (lease.status === 'writing') {
      let result;
      try { result = await generation.copy(lease.ownerId, lease.input); }
      catch (error) {
        return store.saveDraft(lease, {
          status: 'failed', nextCheckAt: null,
          error: error instanceof DomainError ? error.message : '朋友圈文案生成失败，请稍后重试。',
        }, now());
      }
      const next = await store.saveDraft(lease, {
        status: lease.input.includeImage ? 'image_pending' : 'completed',
        text: result.text, imagePrompt: result.imagePrompt,
        nextCheckAt: lease.input.includeImage ? now() : null,
      }, now());
      // Persist the text and frozen prompt before any paid image submission.
      return lease.input.includeImage ? advance(next) : next;
    }

    if (Date.parse(started) - Date.parse(lease.createdAt) >= 48 * 60 * 60 * 1000) {
      return store.saveDraft(lease, { status: 'partial', nextCheckAt: null, error: '配图未能在有效期内保存，文案已保留。' }, now());
    }
    let image;
    try {
      image = lease.imageTaskId
        ? await generation.refreshImage(lease.ownerId, lease.memberId, lease.imageTaskId)
        : await generation.submitImage(lease.ownerId, lease.memberId, lease.id, lease.imagePrompt ?? '');
    } catch (error) {
      const safeMessage = error instanceof DomainError ? error.message : '配图暂时未能处理。';
      // A stable image request ID means a retry will recover the same provider
      // record if submission already began, even if the response was interrupted.
      const terminal = error instanceof DomainError && [400, 401, 403, 404, 503].includes(error.status) && !lease.imageTaskId;
      return store.saveDraft(lease, {
        status: terminal ? 'partial' : 'image_pending',
        nextCheckAt: terminal ? null : later(now(), 60_000),
        error: terminal ? `${safeMessage} 文案已保留。` : '正在等待配图状态，文案已保留。',
      }, now());
    }
    if (image.status === 'completed' && image.files.length) {
      return store.saveDraft(lease, { status: 'completed', imageTaskId: image.id, files: image.files, error: '', nextCheckAt: null }, now());
    }
    if (imagePending.has(image.status)) {
      return store.saveDraft(lease, { status: 'image_pending', imageTaskId: image.id, error: image.error ? '配图暂时未能保存，稍后继续检查。' : '', nextCheckAt: later(now(), 10_000) }, now());
    }
    const error = image.status === 'submission_unknown'
      ? '配图提交结果未知，请在素材服务核对。文案已保留。'
      : '配图未生成或已过期，文案已保留。';
    return store.saveDraft(lease, { status: 'partial', imageTaskId: image.id, error, nextCheckAt: null }, now());
  }

  async function execute(owner: string, member: string, command: Record<string, unknown>) {
    const time = now();
    let planId: string | undefined;
    let draftId: string | undefined;
    if (command.action === 'save') {
      const input = parseMomentPlan(command.plan);
      const value = command.plan as Record<string, unknown>;
      const identity = value.id === undefined ? undefined : { id: momentId(value.id, '朋友圈计划'), version: momentVersion(value.version) };
      if (input.enabled) {
        const available = await generation.availability(owner);
        if (!available.text || input.includeImage && !available.image) throw new DomainError('请先连接所需的模型服务，再开启每日生成。', 503);
      }
      planId = (await store.savePlan(owner, member, input, identity, time)).id;
    } else if (command.action === 'delete') {
      await store.archivePlan(owner, member, momentId(command.planId, '朋友圈计划'), momentVersion(command.version), time);
    } else if (command.action === 'generate') {
      const draft = await store.queueManual(owner, member, momentId(command.planId, '朋友圈计划'), momentId(command.requestId, '生成标识'), time);
      draftId = draft.id;
      await advance(draft);
    } else if (command.action === 'refresh') {
      draftId = momentId(command.draftId, '朋友圈草稿');
      await advance(await store.getDraft(owner, member, draftId));
    } else {
      throw new DomainError('朋友圈操作无效');
    }
    return { ...await snapshot(owner, member), planId, draftId };
  }

  async function maintenance() {
    const queued = await store.queueDue(now(), 10);
    const candidates = await store.listRunnable(now(), 6);
    const results = await Promise.allSettled(candidates.map(advance));
    const statuses = { queued: 0, writing: 0, image_pending: 0, completed: 0, partial: 0, failed: 0 };
    let errors = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') statuses[result.value.status]++;
      else errors++;
    }
    return { queued: queued.length, processed: candidates.length, statuses, errors, hasMore: queued.length === 10 || (await store.listRunnable(now(), 1)).length > 0 };
  }

  return { snapshot, execute, maintenance };
}
