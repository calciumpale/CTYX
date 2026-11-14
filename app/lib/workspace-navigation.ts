import type { MemberRole } from './member-types.ts';
import type { View } from './types.ts';

interface WorkspacePage {
  title: string;
  roles: readonly MemberRole[];
  section?: WorkspaceSection;
}

export type WorkspaceSection = 'reminders' | 'prospecting' | 'geo' | 'materials' | 'deals' | 'schedule' | 'contracts' | 'training' | 'knowledge';
export type ProspectingSection = 'create' | 'screen' | 'handoff' | 'web';

// One registry owns page names, frontend access, and navigation order.
// Server-side permissions remain authoritative for every API request.
const pages: Record<View, WorkspacePage> = {
  home: { title:'概览', roles:['sales','manager','admin'], section:'deals' },
  deals: { title:'项目跟进', roles:['sales','manager'], section:'deals' },
  reminders: { title:'提醒', roles:['sales','manager'], section:'reminders' },
  schedule: { title:'日程', roles:['sales','manager'], section:'schedule' },
  meetings: { title:'会议', roles:['sales','manager','admin'], section:'deals' },
  prospecting: { title:'AI获客', roles:['sales','manager'], section:'prospecting' },
  geo: { title:'GEO', roles:['sales','manager'], section:'geo' },
  materials: { title:'AI营销素材', roles:['sales','manager'], section:'materials' },
  knowledge: { title:'知识库', roles:['sales','manager','admin'], section:'knowledge' },
  training: { title:'AI带练', roles:['sales','manager'], section:'training' },
  approvals: { title:'合同', roles:['sales','manager'], section:'contracts' },
  reports: { title:'销售日报', roles:['manager'], section:'schedule' },
  contracts: { title:'合同', roles:['sales','manager'], section:'contracts' },
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
  if (view === 'home') return role === 'admin' ? '系统管理' : '项目跟进';
  return pages[view].title;
}

export function workspaceNavigation(role: MemberRole): Array<{id:View;label:string;mobileLabel?:string}> {
  const mobile: Partial<Record<View,string>>={prospecting:'获客',materials:'素材',deals:'项目',training:'带练'};
  return (['reminders','prospecting','geo','materials','deals','schedule','contracts','training','knowledge'] as const)
    .filter(id => canOpenWorkspaceView(role,id))
    .map(id => ({id,label:workspaceTitle(id,role),...(mobile[id]?{mobileLabel:mobile[id]}:{})}));
}

export function workspaceSection(view: View, role: MemberRole): WorkspaceSection | undefined {
  if (!canOpenWorkspaceView(role,view) || (role === 'admin' && pages[view].section === 'deals')) return undefined;
  return pages[view].section;
}

export function workspaceManagementNavigation(role: MemberRole): Array<{id:View;label:string}> {
  if (role !== 'admin') return [];
  return (['home','members','rules','settings','studio','runs'] as const)
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
  prospectingSection?: ProspectingSection;
}

function identifier(value: string | null): string | undefined {
  return value && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

export function readWorkspaceRoute(search: string, role: MemberRole): WorkspaceRoute {
  const params = new URLSearchParams(search);
  const fallback=role==='admin'?'home':'deals';
  let view = params.get('view') || fallback;
  if (!canOpenWorkspaceView(role,view)) return {view:fallback};
  if(view==='home'&&role!=='admin')view='deals';
  if(view==='meetings'&&params.get('embed')!=='tencent')return {view:role==='admin'?'settings':'schedule'};
  const route: WorkspaceRoute = {view:view as View};
  const section=params.get('section');
  if(view==='prospecting'&&(section==='create'||section==='screen'||section==='handoff'||section==='web'))route.prospectingSection=section;
  const intent = params.get('intent');
  if (view === 'deals' && (intent === 'create' || intent === 'followup')) route.intent = intent;
  const dealId = identifier(params.get('deal'));
  const contractId = identifier(params.get('contract'));
  const approvalId = identifier(params.get('approval'));
  const focus = identifier(params.get('focus'));
  if (['deals','meetings','contracts','approvals'].includes(view) && dealId) route.dealId = dealId;
  if ((view === 'contracts'||view==='approvals') && contractId) route.contractId = contractId;
  if (view === 'approvals' && approvalId) route.approvalId = approvalId;
  if ((view === 'knowledge' || view === 'talktracks') && focus) route.focus = focus;
  if (view === 'meetings' && params.get('embed') === 'tencent') route.meetingEmbed = true;
  return route;
}

export function workspaceSearch(search: string, route: WorkspaceRoute): string {
  const params = new URLSearchParams(search);
  for (const key of ['view','deal','contract','approval','focus','embed','intent','section']) params.delete(key);
  if (route.view !== 'home') params.set('view',route.view);
  if (route.dealId) params.set('deal',route.dealId);
  if (route.contractId) params.set('contract',route.contractId);
  if (route.approvalId) params.set('approval',route.approvalId);
  if (route.focus) params.set('focus',route.focus);
  if (route.meetingEmbed) params.set('embed','tencent');
  if (route.view === 'deals' && route.intent) params.set('intent',route.intent);
  if (route.view === 'prospecting' && route.prospectingSection) params.set('section',route.prospectingSection);
  return params.size ? '?' + params.toString() : '';
}
