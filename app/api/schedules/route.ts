import { runtimeScheduleService, scheduleFailure } from '../../lib/schedule-service.ts';
export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  try { return await (await runtimeScheduleService()).handle(request); }
  catch (error) { return scheduleFailure(error); }
}
export const GET = handle;
export const POST = handle;
