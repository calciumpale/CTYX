import {prospectingService} from '../../../lib/prospecting-runtime.ts';
export const dynamic='force-dynamic';
export async function POST(request:Request){return prospectingService().bridge(request,'poll');}
