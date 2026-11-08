import test from 'node:test';
import assert from 'node:assert/strict';
import {isKnowledgeLibraryDepartment,knowledgeDepartmentForSalesId,canReadKnowledgeDepartment} from '../app/lib/knowledge-department-scope.ts';

test('stable authenticated sales identifiers resolve to their own department only',()=>{
  assert.deepEqual(['sales-1','sales-yy','sales-yl','sales-ch','sales-wl'].map(knowledgeDepartmentForSalesId),['zs','yy','yl','ch','wl']);
  assert.equal(knowledgeDepartmentForSalesId('zs'),null);
  assert.equal(knowledgeDepartmentForSalesId('arbitrary-client-value'),null);
  assert.equal(knowledgeDepartmentForSalesId(undefined),null);
});

test('shared and own department are readable, unassigned and foreign departments are excluded',()=>{
  for(const department of ['zs','yy','yl','ch','wl'] as const){
    assert.equal(canReadKnowledgeDepartment('shared',department),true);
    assert.equal(canReadKnowledgeDepartment(department,department),true);
    assert.equal(canReadKnowledgeDepartment('unassigned',department),false);
    assert.equal(canReadKnowledgeDepartment(department,null),false);
  }
  assert.equal(canReadKnowledgeDepartment('yy','zs'),false);
  assert.equal(canReadKnowledgeDepartment('shared',null),true);
  assert.equal(canReadKnowledgeDepartment(undefined,'zs'),false);
  assert.equal(isKnowledgeLibraryDepartment('unassigned'),true);
  assert.equal(isKnowledgeLibraryDepartment('shared'),true);
  assert.equal(isKnowledgeLibraryDepartment('other'),false);
});
