import {DomainError} from '../../lib/domain.ts';
import {requireUserId} from '../../lib/server.ts';
import {requireMemberRole} from '../../lib/member-policy.ts';
import {assertSameOrigin} from '../../lib/connection-config.ts';
import {readDigitalHumanBody} from '../../lib/digital-human-config.ts';
import {digitalHumanFailure, digitalHumanRuntime} from '../../lib/digital-human-runtime.ts';
import {digitalHumanPrivateHeaders} from '../../lib/digital-human-upload.ts';
import {ZegoProviderError} from '../../lib/digital-human-provider.ts';

export const dynamic = 'force-dynamic';
function administrator(request: Request) {
  const owner = requireUserId(request);
  if (requireMemberRole(request) !== 'admin') throw new DomainError('仅管理员可维护 ZEGO 服务连接', 403);
  return owner;
}
export async function GET(request: Request) {
  try { return Response.json({connection: await digitalHumanRuntime().store.connection(administrator(request))}, {headers: digitalHumanPrivateHeaders}); }
  catch (error) { return digitalHumanFailure(error); }
}
export async function POST(request: Request) {
  try {
    const owner = administrator(request); assertSameOrigin(request);
    const input = await readDigitalHumanBody(request);
    const connection = await digitalHumanRuntime().store.configure(owner, input);
    return Response.json({connection, message: input.action === 'test' ? '形象列表读取通过；此测试不会验证直播、AgentId 或 TTS 服务权限' : 'ZEGO 连接已保存'}, {headers: digitalHumanPrivateHeaders});
  } catch (error) { return digitalHumanFailure(error instanceof ZegoProviderError ? new DomainError(error.message, 502) : error); }
}
