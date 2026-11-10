import { env } from 'cloudflare:workers';
import { DomainError } from './domain.ts';
import { momentGeneration } from './moments-generation.ts';
import { createMomentService } from './moments-service.ts';
import { createMomentStore } from './moments-store.ts';

export function momentRuntime(origin: string) {
  const db = (env as Cloudflare.Env).DB;
  if (!db) throw new DomainError('朋友圈存储暂时不可用', 503);
  return createMomentService(createMomentStore(db), momentGeneration(origin));
}
