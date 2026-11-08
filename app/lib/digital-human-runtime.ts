import {env} from 'cloudflare:workers';
import {DomainError} from './domain.ts';
import {ZegoProviderError} from './digital-human-provider.ts';
import {requireUserId} from './server.ts';
import {requireMemberRole} from './member-policy.ts';
import {createDigitalHumanStore} from './digital-human-store.ts';
import {createDigitalHumanService} from './digital-human-service.ts';
import {digitalHumanPrivateHeaders} from './digital-human-upload.ts';
import type {DigitalHumanEnvironment} from './digital-human-types.ts';

export function digitalHumanRuntime() {
  const environment = env as DigitalHumanEnvironment;
  const store = createDigitalHumanStore(environment);
  return {store, bucket: environment.BUCKET, service: createDigitalHumanService({store, bucket: environment.BUCKET})};
}
export function digitalHumanIdentity(request: Request) {
  const owner = requireUserId(request);
  if (requireMemberRole(request) === 'admin') throw new DomainError('管理员仅维护 ZEGO 服务连接', 403);
  return {owner, member: request.headers.get('x-ctai-member-account-id')!};
}
export function digitalHumanFailure(error: unknown): Response {
  const message = error instanceof DomainError || error instanceof ZegoProviderError ? error.message : '数字人服务暂时不可用，请稍后重试';
  return Response.json({error: message, message}, {status: error instanceof DomainError ? error.status : error instanceof ZegoProviderError ? 502 : 503, headers: digitalHumanPrivateHeaders});
}
