import {prospectingService} from '../../lib/prospecting-runtime.ts';
export const dynamic='force-dynamic';
export async function GET(request:Request){return prospectingService().handle(request);}
export async function POST(request:Request){return prospectingService().handle(request);}
