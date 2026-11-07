import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenWorkspaceView, readWorkspaceRoute, workspaceSearch, workspaceNavigation, workspaceSection, workspaceManagementNavigation } from '../app/lib/workspace-navigation.ts';

test('business navigation presents the six requested sections without widening access', () => {
  const expected=[{id:'prospecting',label:'社交平台获客'},{id:'deals',label:'项目跟进'},{id:'schedule',label:'提醒及日程'},{id:'contracts',label:'合同及审批'},{id:'training',label:'培训提升'},{id:'knowledge',label:'知识库'}];
  for(const role of ['sales','manager'] as const){
    assert.deepEqual(workspaceNavigation(role).map(({id,label})=>({id,label})),expected);
    assert.ok(workspaceNavigation(role).every(item=>(item.mobileLabel??item.label).length<=4));
  }
  assert.deepEqual(workspaceNavigation('admin').map(({id,label})=>({id,label})),[{id:'knowledge',label:'知识库'}]);
  assert.equal(canOpenWorkspaceView('sales','settings'),false);
  assert.equal(canOpenWorkspaceView('admin','deals'),false);
  assert.equal(canOpenWorkspaceView('manager','reports'),true);
  assert.equal(canOpenWorkspaceView('sales','contracts'),true);
});

test('project, contract and acquisition context survive direct-link round trips', () => {
  for(const view of ['deals','schedule','prospecting','knowledge','training','approvals','contracts','reports','studio','runs','settings','members','rules'] as const){
    const role=['settings','members','rules'].includes(view)?'admin':'manager';
    assert.equal(readWorkspaceRoute(workspaceSearch('',{view}),role).view,view);
  }
  for(const view of ['contracts','approvals'] as const){
    const route={view,dealId:'deal-12',contractId:'contract-5',...(view==='approvals'?{approvalId:'approval-3'}:{})};
    assert.deepEqual(readWorkspaceRoute(workspaceSearch('',route),'manager'),route);
  }
  for(const prospectingSection of ['create','screen','handoff'] as const){
    const route={view:'prospecting' as const,prospectingSection};
    assert.deepEqual(readWorkspaceRoute(workspaceSearch('',route),'sales'),route);
  }
  assert.deepEqual(readWorkspaceRoute('?view=prospecting&section=made-up','sales'),{view:'prospecting'});
  assert.deepEqual(readWorkspaceRoute('?view=knowledge&focus=skill-review','manager'),{view:'knowledge',focus:'skill-review'});
});

test('removed business landing and meeting pages resolve to their current homes', () => {
  for(const role of ['sales','manager'] as const){
    assert.deepEqual(readWorkspaceRoute('',role),{view:'deals'});
    assert.deepEqual(readWorkspaceRoute('?view=home',role),{view:'deals'});
    assert.deepEqual(readWorkspaceRoute('?view=meetings&deal=old',role),{view:'schedule'});
  }
  assert.deepEqual(readWorkspaceRoute('?view=meetings','admin'),{view:'settings'});
  assert.deepEqual(readWorkspaceRoute('?view=meetings&embed=tencent&deal=deal-4','sales'),{view:'meetings',dealId:'deal-4',meetingEmbed:true});
  assert.deepEqual(readWorkspaceRoute('','admin'),{view:'home'});
});

test('forbidden contexts fail closed and changing sections clears unrelated parameters', () => {
  assert.deepEqual(readWorkspaceRoute('?view=settings','sales'),{view:'deals'});
  assert.deepEqual(readWorkspaceRoute('?view=schedule','admin'),{view:'home'});
  assert.deepEqual(readWorkspaceRoute('?view=made-up','admin'),{view:'home'});
  assert.deepEqual(readWorkspaceRoute('?view=deals&deal=%3Cscript%3E','sales'),{view:'deals'});
  assert.equal(workspaceSearch('?view=prospecting&section=handoff&deal=old&intent=create',{view:'knowledge'}),'?view=knowledge');
  assert.equal(workspaceSearch('?view=approvals&approval=old&contract=old&deal=old',{view:'prospecting',prospectingSection:'screen'}),'?view=prospecting&section=screen');
});

test('sections group approval with contracts and reports with reminder calendar', () => {
  assert.equal(workspaceSection('deals','sales'),'deals');
  assert.equal(workspaceSection('contracts','sales'),'contracts');
  assert.equal(workspaceSection('approvals','manager'),'contracts');
  assert.equal(workspaceSection('reports','manager'),'schedule');
  assert.equal(workspaceSection('schedule','sales'),'schedule');
  assert.equal(workspaceSection('talktracks','sales'),'knowledge');
  assert.equal(workspaceSection('deals','admin'),undefined);
  assert.equal(workspaceSection('settings','sales'),undefined);
  assert.deepEqual(workspaceManagementNavigation('sales'),[]);
  assert.deepEqual(workspaceManagementNavigation('admin').map(item=>item.id),['home','members','rules','settings','studio','runs']);
});

test('legacy project intake links remain valid without creating a separate records section', () => {
  for(const intent of ['create','followup'] as const){
    const route={view:'deals' as const,intent};
    assert.deepEqual(readWorkspaceRoute(workspaceSearch('',route),'sales'),route);
  }
  assert.deepEqual(readWorkspaceRoute('?view=deals&intent=delete','sales'),{view:'deals'});
});
