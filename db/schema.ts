import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** One isolated, versioned JSON workspace per platform-authenticated user. */
export const workbenchWorkspaces = sqliteTable('workbench_workspaces', {
  userId: text('user_id').primaryKey(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** User-owned connection settings. The credential is AES-GCM ciphertext only. */
export const workbenchApiConnections = sqliteTable('workbench_api_connections', {
  userId:text('user_id').notNull(),
  kind:text('kind').notNull(),
  enabled:integer('enabled').notNull().default(1),
  baseUrl:text('base_url').notNull(),
  modelName:text('model_name').notNull(),
  secretCiphertext:text('secret_ciphertext').notNull(),
  version:integer('version').notNull().default(1),
  updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.kind]})]);

/** Dense embeddings live outside the bounded workspace JSON. Candidates are private until reviewed. */
export const workbenchTalkVectors=sqliteTable('workbench_talk_vectors',{
  userId:text('user_id').notNull(),trackId:text('track_id').notNull(),contentHash:text('content_hash').notNull(),title:text('title').notNull(),vectorJson:text('vector_json').notNull(),model:text('model').notNull(),status:text('status').notNull(),metadataJson:text('metadata_json').notNull(),updatedAt:text('updated_at').notNull(),
},table=>[primaryKey({columns:[table.userId,table.trackId,table.contentHash,table.model]})]);

/** Immutable submissions and CAS state live independently of account workspace capacity. */
export const workbenchApprovalRequests=sqliteTable('workbench_approval_requests',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),projectId:text('project_id').notNull(),kind:text('kind').notNull(),status:text('status').notNull(),version:integer('version').notNull(),currentApproverEmail:text('current_approver_email'),activeKey:text('active_key'),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
},table=>[uniqueIndex('workbench_approval_active_key').on(table.activeKey),index('workbench_approval_owner_created').on(table.ownerId,table.createdAt,table.id),index('workbench_approval_inbox').on(table.currentApproverEmail,table.status,table.createdAt,table.id)]);

export const workbenchApprovalParticipants=sqliteTable('workbench_approval_participants',{
  requestId:text('request_id').notNull().references(()=>workbenchApprovalRequests.id,{onDelete:'cascade'}),email:text('email').notNull(),
},table=>[primaryKey({columns:[table.requestId,table.email]}),index('workbench_approval_participant_email').on(table.email,table.requestId)]);

export const workbenchApprovalTemplates=sqliteTable('workbench_approval_templates',{
  id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),version:integer('version').notNull(),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
},table=>[index('workbench_approval_template_owner').on(table.ownerId,table.updatedAt)]);

/** Immutable real manual-project changes; scoped to the authenticated workspace owner. */
export const workbenchSalesEvents=sqliteTable('workbench_sales_events',{
  userId:text('user_id').notNull(),id:text('id').notNull(),projectId:text('project_id').notNull(),kind:text('kind').notNull(),ownerId:text('owner_id').notNull(),occurredAt:text('occurred_at').notNull(),dataJson:text('data_json').notNull(),
},table=>[primaryKey({columns:[table.userId,table.id]}),index('workbench_sales_event_day').on(table.userId,table.occurredAt,table.id)]);

export const workbenchSalesCoverage=sqliteTable('workbench_sales_coverage',{
  userId:text('user_id').primaryKey(),startedAt:text('started_at').notNull(),
});

/** Date-scoped report snapshots and CAS leases live outside the bounded workspace JSON. */
export const workbenchSalesReports=sqliteTable('workbench_sales_reports',{
  userId:text('user_id').notNull(),reportDate:text('report_date').notNull(),status:text('status').notNull(),version:integer('version').notNull(),leaseToken:text('lease_token'),leaseUntil:text('lease_until'),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
},table=>[primaryKey({columns:[table.userId,table.reportDate]}),index('workbench_sales_report_updated').on(table.userId,table.updatedAt)]);
