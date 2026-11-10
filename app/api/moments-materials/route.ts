import { assertSameOrigin } from '../../lib/connection-config.ts';
import { materialFailure, materialHeaders, materialIdentity } from '../marketing-materials/route.ts';
import { readMaterialBody } from '../../lib/marketing-material.ts';
import { momentRuntime } from '../../lib/moments-runtime.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { owner, member } = materialIdentity(request);
    const data = await momentRuntime(new URL(request.url).origin).snapshot(owner, member);
    return Response.json(data, { headers: materialHeaders });
  } catch (error) { return materialFailure(error); }
}

export async function POST(request: Request) {
  try {
    const { owner, member } = materialIdentity(request);
    assertSameOrigin(request);
    const data = await momentRuntime(new URL(request.url).origin).execute(owner, member, await readMaterialBody(request));
    return Response.json(data, { headers: materialHeaders });
  } catch (error) { return materialFailure(error); }
}
