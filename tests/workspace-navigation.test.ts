import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenWorkspaceView, readWorkspaceRoute, workspaceSearch, workspaceNavigation, workspaceSection, workspaceProjectNavigation, workspaceManagementNavigation } from '../app/lib/workspace-navigation.ts';

test('business navigation has the four requested sections without changing role access', () => {
  const expected=[{id:'prospecting',label:'抖音获客'},{id:'deals',label:'项目跟进'},{id:'training',label:'培训提升'},{id:'knowledge',label:'知识库'}];
  assert.deepEqual(workspaceNavigation('sales'), expected);
  assert.deepEqual(workspaceNavigation('manager'), expected);
  assert.deepEqual(workspaceNavigation('admin'), [{id:'knowledge',label:'知识库'}]);
  assert.equal(canOpenWorkspaceView('sales','settings'), false);
  assert.equal(canOpenWorkspaceView('admin','deals'), false);
  assert.equal(canOpenWorkspaceView('manager','reports'), true);
  assert.equal(canOpenWorkspaceView('sales','contracts'), true);
  assert.equal(canOpenWorkspaceView('admin','meetings'), true);
});

test('direct page links and contextual links round-trip without losing their context', () => {
  for (const view of ['deals','meetings','prospecting','knowledge','training','approvals','reports','studio','runs','settings','members','rules'] as const) {
    const role = ['settings','members','rules'].includes(view) ? 'admin' : 'manager';
    assert.equal(readWorkspaceRoute(workspaceSearch('', {view}),role).view,view);
  }
  const route={view:'approvals' as const,dealId:'deal-12',contractId:'contract-5',approvalId:'approval-3'};
  assert.deepEqual(readWorkspaceRoute(workspaceSearch('',route),'manager'),route);
  assert.deepEqual(readWorkspaceRoute('?view=meetings&embed=tencent&deal=deal-4','sales'),{view:'meetings',dealId:'deal-4',meetingEmbed:true});
  assert.deepEqual(readWorkspaceRoute('?view=knowledge&focus=skill-review','manager'),{view:'knowledge',focus:'skill-review'});
});

test('unknown or forbidden views cannot bypass role access and old context is cleared on navigation', () => {
  assert.deepEqual(readWorkspaceRoute('?view=settings','sales'),{view:'home'});
  assert.deepEqual(readWorkspaceRoute('?view=made-up','admin'),{view:'home'});
  assert.deepEqual(readWorkspaceRoute('?view=deals&deal=%3Cscript%3E','sales'),{view:'deals'});
  const next=workspaceSearch('?view=meetings&embed=tencent&deal=old&approval=old&contract=old&focus=old',{view:'settings'});
  assert.equal(next,'?view=settings');
  assert.equal(workspaceSearch('?view=deals&intent=followup',{view:'knowledge'}),'?view=knowledge');
});


test('followup and intake entry links preserve valid intent only inside projects', () => {
  for (const intent of ['create','followup'] as const) {
    const route={view:'deals' as const,intent};
    assert.deepEqual(readWorkspaceRoute(workspaceSearch('',route),'sales'),route);
  }
  assert.deepEqual(readWorkspaceRoute('?view=deals&intent=delete','sales'),{view:'deals'});
  assert.deepEqual(readWorkspaceRoute('?view=meetings&intent=followup','manager'),{view:'meetings'});
});


test('project pages share one section while administration stays permission scoped', () => {
  for (const view of ['home','deals','meetings','approvals','contracts','reports'] as const) {
    assert.equal(workspaceSection(view,'manager'),'deals');
  }
  assert.equal(workspaceSection('talktracks','sales'),'knowledge');
  assert.equal(workspaceSection('home','admin'),undefined);
  assert.equal(workspaceSection('deals','admin'),undefined);
  assert.equal(workspaceSection('settings','sales'),undefined);
  assert.deepEqual(workspaceProjectNavigation('sales').map(item=>item.id),['home','deals','meetings','approvals','contracts']);
  assert.deepEqual(workspaceProjectNavigation('admin'),[]);
  assert.deepEqual(workspaceManagementNavigation('sales'),[]);
  assert.deepEqual(workspaceManagementNavigation('manager'),[]);
  assert.deepEqual(workspaceManagementNavigation('admin').map(item=>item.id),['home','members','rules','settings','studio','runs','meetings']);
});
