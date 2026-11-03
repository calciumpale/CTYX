import {handleMeetingBridge} from '../../../lib/meeting-import-service.ts';
export const dynamic='force-dynamic';
export async function POST(request:Request){return handleMeetingBridge(request,'media');}
