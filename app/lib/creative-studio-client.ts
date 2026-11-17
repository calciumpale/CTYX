import type { PublicMaterialTask } from './marketing-material-types.ts';
import type { StudioDocument, StudioImage } from './creative-studio-types.ts';

export class StudioRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function studioRequest<T>(query = '', body?: object, path = '/api/creative-studio', options?: Pick<RequestInit, 'signal' | 'priority'>): Promise<T> {
  const response = await fetch(path + query, body ? {
    ...options, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { ...options, cache: 'no-store' });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof data.message === 'string' ? data.message : data.error;
    throw new StudioRequestError(typeof message === 'string' ? message : '请求暂时未完成，请稍后重试。', response.status);
  }
  return data as T;
}

export function studioImageOptions(tasks: PublicMaterialTask[]): StudioImage[] {
  return tasks.filter(task => task.status === 'completed' && task.input.kind === 'image')
    .flatMap(task => task.files.filter(file => file.type.startsWith('image/')).map(({ url, name }) => ({
      url, name: `${task.input.prompt.slice(0, 32)} · ${name}`,
    })));
}

export async function studioCoverRequestId(projectId: string, input: object, previousTaskId?: string): Promise<string> {
  const digest = async (value: unknown) => {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
  };
  const prefix = `studio-cover-${projectId}-${await digest(input)}`;
  return previousTaskId ? `${prefix}-${await digest(previousTaskId)}` : prefix;
}

export function downloadStudioCopy(document: StudioDocument) {
  const { title, caption, script, coverPrompt, shots } = document.copy;
  const fields = [title, caption && `发布文案\n${caption}`, script && `口播脚本\n${script}`,
    coverPrompt && `封面构思\n${coverPrompt}`, shots.length && ['分镜', ...shots.map((shot, index) =>
      `${index + 1}. ${shot.seconds} 秒\n画面：${shot.visual}\n口播：${shot.voiceover}`,
    )].join('\n\n')];
  const blob = new Blob([fields.filter(Boolean).join('\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = `${document.title.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 70) || '营销稿'}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
