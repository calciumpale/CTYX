import type { MemberRole } from './member-types.ts';
import type { View } from './types.ts';

interface WorkspacePage {
  title: string;
  roles: readonly MemberRole[];
  navigation?: Partial<Record<MemberRole, number>>;
}

// One registry owns page names, frontend access, and navigation order.
// Server-side permissions remain authoritative for every API request.
const pages: Record<View, WorkspacePage> = {
  home: { title:'概览', roles:['sales','manager','admin'], navigation:{sales:0,manager:0} },
  deals: { title:'项目', roles:['sales','manager'], navigation:{sales:1,manager:1} },
  meetings: { title:'会议', roles:['sales','manager','admin'], navigation:{sales:2,manager:2} },
  prospecting: { title:'抖音获客', roles:['sales','manager'], navigation:{sales:3,manager:3} },
  knowledge: { title:'知识库', roles:['sales','manager','admin'], navigation:{sales:4,manager:5,admin:2} },
  training: { title:'培训', roles:['sales','manager'], navigation:{sales:5,manager:6} },
  approvals: { title:'审批', roles:['sales','manager'], navigation:{manager:4} },
  reports: { title:'销售日报', roles:['manager'] },
  contracts: { title:'合同初审', roles:['sales','manager'] },
  talktracks: { title:'成单话术', roles:['sales','manager','admin'] },
  studio: { title:'搭建中心', roles:['sales','manager','admin'], navigation:{admin:4} },
  runs: { title:'任务记录', roles:['sales','manager','admin'], navigation:{admin:5} },
  settings: { title:'服务连接', roles:['admin'], navigation:{admin:3} },
  members: { title:'人员', roles:['admin'], navigation:{admin:0} },
  rules: { title:'业务规则', roles:['admin'], navigation:{admin:1} },
};

export function canOpenWorkspaceView(role: MemberRole, view: string): view is View {
  return Object.hasOwn(pages, view) && pages[view as View].roles.includes(role);
}

export function workspaceTitle(view: View, role: MemberRole): string {
  if (view === 'home') return role === 'sales' ? '今日工作' : role === 'manager' ? '团队概览' : '管理';
  return pages[view].title;
}

export function workspaceNavigation(role: MemberRole): Array<{id:View;label:string}> {
  return (Object.keys(pages) as View[])
    .filter(id => pages[id].navigation?.[role] !== undefined)
    .sort((left,right) => pages[left].navigation![role]! - pages[right].navigation![role]!)
    .map(id => ({id,label:workspaceTitle(id,role)}));
}

export interface WorkspaceRoute {
  view: View;
  dealId?: string;
  contractId?: string;
  approvalId?: string;
  focus?: string;
  meetingEmbed?: boolean;
}

function identifier(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

export function readWorkspaceRoute(search: string, role: MemberRole): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const view = params.get('view') || 'home';
  if (!canOpenWorkspaceView(role,view)) return {view:'home'};
  const route: WorkspaceRoute = {view};
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
  for (const key of ['view','deal','contract','approval','focus','embed']) params.delete(key);
  if (route.view !== 'home') params.set('view',route.view);
  if (route.dealId) params.set('deal',route.dealId);
  if (route.contractId) params.set('contract',route.contractId);
  if (route.approvalId) params.set('approval',route.approvalId);
  if (route.focus) params.set('focus',route.focus);
  if (route.meetingEmbed) params.set('embed','tencent');
  return params.size ? '?' + params.toString() : '';
}
