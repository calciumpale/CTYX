import type { MemberRole } from './member-types.ts';
import type { View } from './types.ts';

interface WorkspacePage {
  title: string;
  roles: readonly MemberRole[];
  section?: WorkspaceSection;
}

export type WorkspaceSection = 'prospecting' | 'deals' | 'schedule' | 'training' | 'knowledge';

// One registry owns page names, frontend access, and navigation order.
// Server-side permissions remain authoritative for every API request.
const pages: Record<View, WorkspacePage> = {
  home: { title:'概览', roles:['sales','manager','admin'], section:'deals' },
  deals: { title:'项目跟进', roles:['sales','manager'], section:'deals' },
  schedule: { title:'智能日程', roles:['sales','manager'], section:'schedule' },
  meetings: { title:'会议', roles:['sales','manager','admin'], section:'deals' },
  prospecting: { title:'抖音获客', roles:['sales','manager'], section:'prospecting' },
  knowledge: { title:'知识库', roles:['sales','manager','admin'], section:'knowledge' },
  training: { title:'培训提升', roles:['sales','manager'], section:'training' },
  approvals: { title:'审批', roles:['sales','manager'], section:'deals' },
  reports: { title:'销售日报', roles:['manager'], section:'deals' },
  contracts: { title:'AI 合同初审', roles:['sales','manager'], section:'deals' },
  talktracks: { title:'成单话术', roles:['sales','manager','admin'], section:'knowledge' },
  studio: { title:'AI 搭建中心', roles:['sales','manager','admin'] },
  runs: { title:'AI 任务记录', roles:['sales','manager','admin'] },
  settings: { title:'服务连接', roles:['admin'] },
  members: { title:'人员权限', roles:['admin'] },
  rules: { title:'业务规则', roles:['admin'] },
};

export function canOpenWorkspaceView(role: MemberRole, view: string): view is View {
  return Object.hasOwn(pages, view) && pages[view as View].roles.includes(role);
}

export function workspaceTitle(view: View, role: MemberRole): string {
  if (view === 'home') return role === 'sales' ? '今日工作' : role === 'manager' ? '团队概览' : '系统管理';
  return pages[view].title;
}

export function workspaceNavigation(role: MemberRole): Array<{id:View;label:string}> {
  return (['prospecting','deals','schedule','training','knowledge'] as const)
    .filter(id => canOpenWorkspaceView(role,id))
    .map(id => ({id,label:id === 'schedule' ? '日程' : workspaceTitle(id,role)}));
}

export function workspaceSection(view: View, role: MemberRole): WorkspaceSection | undefined {
  if (!canOpenWorkspaceView(role,view) || (role === 'admin' && pages[view].section === 'deals')) return undefined;
  return pages[view].section;
}

export function workspaceProjectNavigation(role: MemberRole): Array<{id:View;label:string}> {
  if (role === 'admin') return [];
  return (['home','deals','meetings','approvals','contracts','reports'] as const)
    .filter(id => canOpenWorkspaceView(role,id))
    .map(id => ({id,label:id === 'deals' ? '项目列表' : workspaceTitle(id,role)}));
}

export function workspaceManagementNavigation(role: MemberRole): Array<{id:View;label:string}> {
  if (role !== 'admin') return [];
  return (['home','members','rules','settings','studio','runs','meetings'] as const)
    .map(id => ({id,label:workspaceTitle(id,role)}));
}

export interface WorkspaceRoute {
  view: View;
  dealId?: string;
  contractId?: string;
  approvalId?: string;
  focus?: string;
  meetingEmbed?: boolean;
  intent?: 'create' | 'followup';
}

function identifier(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

export function readWorkspaceRoute(search: string, role: MemberRole): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const view = params.get('view') || 'home';
  if (!canOpenWorkspaceView(role,view)) return {view:'home'};
  const route: WorkspaceRoute = {view};
  const intent = params.get('intent');
  if (view === 'deals' && (intent === 'create' || intent === 'followup')) route.intent = intent;
  const dealId = identifier(params.get('deal'));
  const contractId = identifier(params.get('contract'));
  const approvalId = identifier(params.get('approval'));
  const focus = identifier(params.get('focus'));
  if (['deals','meetings','contracts','approvals'].includes(view) && dealId) route.dealId = dealId;
  if (view === 'approvals' && contractId) route.contractId = contractId;
  if (view === 'approvals' && approvalId) route.approvalId = approvalId;
  if ((view === 'knowledge' || view === 'talktracks') && focus) route.focus = focus;
  if (view === 'meetings' && params.get('embed') === 'tencent') route.meetingEmbed = true;
  return route;
}

export function workspaceSearch(search: string, route: WorkspaceRoute): string {
  const params = new URLSearchParams(search);
  for (const key of ['view','deal','contract','approval','focus','embed','intent']) params.delete(key);
  if (route.view !== 'home') params.set('view',route.view);
  if (route.dealId) params.set('deal',route.dealId);
  if (route.contractId) params.set('contract',route.contractId);
  if (route.approvalId) params.set('approval',route.approvalId);
  if (route.focus) params.set('focus',route.focus);
  if (route.meetingEmbed) params.set('embed','tencent');
  if (route.view === 'deals' && route.intent) params.set('intent',route.intent);
  return params.size ? '?' + params.toString() : '';
}
