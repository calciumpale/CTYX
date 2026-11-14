import { AGENTS, type ApiResult, type TraceStep } from './types.ts';

export const CHAT_PROGRESS_CONTENT_TYPE = 'application/x-ndjson';
export type ChatProgressStep = Pick<TraceStep, 'id' | 'title' | 'detail' | 'duration' | 'agent'> & {
  status: TraceStep['status'] | 'running';
};
type ChatProgressFailure = { status: number; error: string; outcomeUnknown?: boolean };
type ChatProgressEvent =
  | { type: 'step'; step: ChatProgressStep }
  | { type: 'complete'; result: ApiResult }
  | ({ type: 'error' } & ChatProgressFailure);

export class ChatProgressError extends Error {
  readonly status: number;
  readonly outcomeUnknown: boolean;

  constructor(message: string, status: number, outcomeUnknown = false) {
    super(message);
    this.name = 'ChatProgressError';
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}

const uncertain = '暂时无法确认本次回复是否已保存，请先刷新查看记录。';
const failed = '暂时无法处理本次问题，请稍后重试。';
const MAX_FRAME_LENGTH = 8 * 1024 * 1024;
const stepStatuses = new Set(['running', 'success', 'warning', 'error', 'skipped']);
const agentIds = new Set<string>(AGENTS.map(agent => agent.id));

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isApiResult(value: unknown): value is ApiResult {
  return record(value) && record(value.state) && Number.isSafeInteger(value.state.revision);
}

function isProgressStep(value: unknown): value is ChatProgressStep {
  return record(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && typeof value.detail === 'string' &&
    typeof value.duration === 'number' && Number.isFinite(value.duration) && value.duration >= 0 &&
    typeof value.status === 'string' && stepStatuses.has(value.status) &&
    (value.agent === undefined || typeof value.agent === 'string' && agentIds.has(value.agent));
}

export function acceptsChatProgress(accept: string | null): boolean {
  return (accept ?? '').split(',').some(value => {
    const [mediaType, ...parameters] = value.trim().toLowerCase().split(';');
    if (mediaType.trim() !== CHAT_PROGRESS_CONTENT_TYPE) return false;
    const rawQuality = parameters.find(parameter => /^q\s*=/.test(parameter.trim()));
    if (!rawQuality) return true;
    const quality = Number(rawQuality.split('=')[1]);
    return quality > 0 && quality <= 1;
  });
}

export function upsertChatProgressStep(steps: ChatProgressStep[], step: ChatProgressStep): ChatProgressStep[] {
  const index = steps.findIndex(item => item.id === step.id);
  if (index === -1) return [...steps, step];
  const next = [...steps];
  next[index] = step;
  return next;
}

export function createChatProgressStream(
  execute: (onStep: (step: ChatProgressStep) => void) => Promise<ApiResult>,
  describeError: (error: unknown) => ChatProgressFailure,
  keepAlive: (work: Promise<void>) => void,
): ReadableStream<Uint8Array> {
  let disconnected = false;
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const emit = (event: ChatProgressEvent) => {
        if (disconnected) return;
        const bytes = encoder.encode(JSON.stringify(event) + '\n');
        try { controller.enqueue(bytes); }
        catch { disconnected = true; }
      };
      const work = (async () => {
        try {
          const result = await execute(({ id, title, detail, duration, status, agent }) =>
            emit({ type: 'step', step: { id, title, detail, duration, status, agent } }));
          emit({ type: 'complete', result });
        } catch (error) {
          emit({ type: 'error', ...describeError(error) });
        } finally {
          if (!disconnected) controller.close();
        }
      })();
      keepAlive(work);
    },
    cancel() { disconnected = true; },
  });
}

function decodeFrame(line: string, onStep?: (step: ChatProgressStep) => void): ApiResult | undefined {
  if (!line.trim()) return undefined;
  if (line.length > MAX_FRAME_LENGTH) throw new ChatProgressError(uncertain, 0, true);
  const value: unknown = JSON.parse(line);
  if (record(value)) {
    if (value.type === 'step' && isProgressStep(value.step)) {
      const { id, title, detail, duration, status, agent } = value.step;
      onStep?.({ id, title, detail, duration, status, ...(agent ? { agent } : {}) });
      return undefined;
    }
    if (value.type === 'complete' && isApiResult(value.result)) return value.result;
    if (value.type === 'error' && typeof value.status === 'number' && Number.isInteger(value.status) &&
      value.status >= 400 && value.status <= 599 && typeof value.error === 'string' && value.error.trim()) {
      throw new ChatProgressError(value.error, value.status, value.outcomeUnknown === true);
    }
  }
  throw new ChatProgressError(uncertain, 0, true);
}

async function readJsonResult(response: Response): Promise<ApiResult> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const outcomeUnknown = response.status >= 500;
    const message = record(value) && typeof value.error === 'string' && value.error.trim() ? value.error :
      outcomeUnknown ? uncertain : failed;
    throw new ChatProgressError(message, response.status, outcomeUnknown);
  }
  if (isApiResult(value)) return value;
  throw new ChatProgressError(uncertain, 0, true);
}

export async function readChatProgress(response: Response, onStep?: (step: ChatProgressStep) => void): Promise<ApiResult> {
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || mediaType !== CHAT_PROGRESS_CONTENT_TYPE) return readJsonResult(response);
  if (!response.body) throw new ChatProgressError(uncertain, 0, true);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop()!;
      for (const line of lines) {
        const result = decodeFrame(line, onStep);
        if (result) return result;
      }
      if (pending.length > MAX_FRAME_LENGTH) throw new ChatProgressError(uncertain, 0, true);
    }
    const result = decodeFrame(pending + decoder.decode(), onStep);
    if (result) return result;
    throw new ChatProgressError(uncertain, 0, true);
  } catch (error) {
    if (error instanceof ChatProgressError) throw error;
    throw new ChatProgressError(uncertain, 0, true);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
