import test from 'node:test';import assert from 'node:assert/strict';
import {canReadLegacyKnowledge} from '../app/lib/knowledge-content-scope.ts';
import {KNOWLEDGE_DEPARTMENTS} from '../app/lib/knowledge-department-scope.ts';
test('initial shared knowledge works for all five; sales ownership and explicit metadata isolate learned material',()=>{
 for(const {id} of KNOWLEDGE_DEPARTMENTS){assert.equal(canReadLegacyKnowledge({id:'initial'}, {},id),true);assert.equal(canReadLegacyKnowledge({id:'shared',departmentId:'shared'}, {},id),true);}
 assert.equal(canReadLegacyKnowledge({id:'learned',employeeId:'sales-yy'}, {},'zs'),false);
 assert.equal(canReadLegacyKnowledge({id:'learned',employeeId:'sales-yy'}, {},'yy'),true);
 assert.equal(canReadLegacyKnowledge({id:'knowledge-skill-1'}, {'skill-1':'sales-yy'},'zs'),false);
 assert.equal(canReadLegacyKnowledge({id:'learned',departmentId:'yy'}, {},'zs'),false);
 assert.equal(canReadLegacyKnowledge({id:'learned',departmentId:'unassigned'}, {},'zs'),false);
 assert.equal(canReadLegacyKnowledge({id:'learned',employeeId:'unknown-sales'}, {},'zs'),false);
});
