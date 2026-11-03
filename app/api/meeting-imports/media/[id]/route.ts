import {handleMeetingMedia} from '../../../../lib/meeting-import-service.ts';
export const dynamic='force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){return handleMeetingMedia(request,(await context.params).id);}
export const HEAD=GET;
