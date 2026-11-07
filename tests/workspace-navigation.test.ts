import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenWorkspaceView, readWorkspaceRoute, workspaceSearch, workspaceNavigation } from '../app/lib/workspace-navigation.ts';

test('each role keeps its existing pages and has stable primary navigation', () => {
  assert.deepEqual(workspaceNavigation('sales').map(item => item.id), ['home','deals','meetings','prospecting','knowledge','training']);
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
});
