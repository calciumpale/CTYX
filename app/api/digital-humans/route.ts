import {assertSameOrigin} from '../../lib/connection-config.ts';
import {readDigitalHumanBody} from '../../lib/digital-human-config.ts';
import {digitalHumanFailure, digitalHumanIdentity, digitalHumanRuntime} from '../../lib/digital-human-runtime.ts';
import {digitalHumanPrivateHeaders} from '../../lib/digital-human-upload.ts';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const {owner, member} = digitalHumanIdentity(request);
    return Response.json(await digitalHumanRuntime().service.snapshot(owner, member), {headers: digitalHumanPrivateHeaders});
  } catch (error) { return digitalHumanFailure(error); }
}
export async function POST(request: Request) {
  try {
    const {owner, member} = digitalHumanIdentity(request); assertSameOrigin(request);
    const input = await readDigitalHumanBody(request);
    return Response.json(await digitalHumanRuntime().service.execute(owner, member, input), {headers: digitalHumanPrivateHeaders});
  } catch (error) { return digitalHumanFailure(error); }
}
