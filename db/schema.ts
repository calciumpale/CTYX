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

/** Account-scoped recognition preferences, with compare-and-swap updates. */
export const workbenchSpeechSettings=sqliteTable('workbench_speech_settings',{
  userId:text('user_id').primaryKey(),version:integer('version').notNull(),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
});

/** Long speaker-segment results remain outside the bounded workspace document. */
export const workbenchRecordingTranscriptions=sqliteTable('workbench_recording_transcriptions',{
  userId:text('user_id').notNull(),recordingId:text('recording_id').notNull(),dealId:text('deal_id').notNull(),version:integer('version').notNull(),remoteId:text('remote_id'),leaseUntil:text('lease_until'),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
},table=>[primaryKey({columns:[table.userId,table.recordingId]}),index('workbench_recording_transcription_project').on(table.userId,table.dealId)]);

/** Three app-level member accounts share their original private Sites owner's workspace. */
export const workbenchMemberAccounts=sqliteTable('workbench_member_accounts',{
  accountId:text('account_id').primaryKey(),ownerId:text('owner_id').notNull(),username:text('username').notNull(),displayName:text('display_name').notNull(),role:text('role').notNull(),salesId:text('sales_id'),enabled:integer('enabled').notNull().default(1),passwordSalt:text('password_salt').notNull(),passwordHash:text('password_hash').notNull(),passwordIterations:integer('password_iterations').notNull(),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),
},table=>[uniqueIndex('workbench_member_owner_username').on(table.ownerId,table.username)]);

/** Opaque cookie tokens are hashed; raw session tokens never enter the database. */
export const workbenchMemberSessions=sqliteTable('workbench_member_sessions',{
  tokenHash:text('token_hash').primaryKey(),ownerId:text('owner_id').notNull(),accountId:text('account_id').notNull(),expiresAt:integer('expires_at').notNull(),createdAt:text('created_at').notNull(),
},table=>[index('workbench_member_session_owner').on(table.ownerId,table.accountId),index('workbench_member_session_expiry').on(table.expiresAt)]);

export const workbenchMemberLoginLimits=sqliteTable('workbench_member_login_limits',{
  ownerId:text('owner_id').primaryKey(),attempts:integer('attempts').notNull(),windowStart:integer('window_start').notNull(),
});

/** Versioned operational business rules, independent from the workspace JSON. */
export const workbenchBusinessSettings=sqliteTable('workbench_business_settings',{
  userId:text('user_id').primaryKey(),version:integer('version').notNull(),updatedAt:text('updated_at').notNull(),dataJson:text('data_json').notNull(),
});

/** Each meeting device is pinned to one enabled business member, never a browser-selected tenant. */
export const workbenchMeetingDevices=sqliteTable('workbench_meeting_devices',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),memberId:text('member_id').notNull(),label:text('label').notNull(),tokenHash:text('token_hash').notNull(),enabled:integer('enabled').notNull().default(1),authorized:integer('authorized').notNull().default(0),lastSeenAt:text('last_seen_at'),createdAt:text('created_at').notNull(),
},table=>[uniqueIndex('workbench_meeting_device_token').on(table.tokenHash),index('workbench_meeting_device_member').on(table.ownerId,table.memberId,table.enabled)]);
export const workbenchMeetingJobs=sqliteTable('workbench_meeting_jobs',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),memberId:text('member_id').notNull(),deviceId:text('device_id').notNull(),kind:text('kind').notNull(),dealId:text('deal_id'),status:text('status').notNull(),inputJson:text('input_json').notNull(),resultJson:text('result_json'),error:text('error'),activeKey:text('active_key'),leaseHash:text('lease_hash'),leaseUntil:text('lease_until'),attempts:integer('attempts').notNull().default(0),createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),mediaJson:text('media_json'),
},table=>[uniqueIndex('workbench_meeting_job_active').on(table.activeKey),index('workbench_meeting_job_queue').on(table.deviceId,table.status,table.createdAt),index('workbench_meeting_job_member').on(table.ownerId,table.memberId,table.createdAt)]);
export const workbenchMeetingImports=sqliteTable('workbench_meeting_imports',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),memberId:text('member_id').notNull(),dealId:text('deal_id').notNull(),sourceKey:text('source_key').notNull(),sourceHash:text('source_hash').notNull(),dataJson:text('data_json').notNull(),linked:integer('linked').notNull().default(0),createdAt:text('created_at').notNull(),
},table=>[uniqueIndex('workbench_meeting_import_source').on(table.ownerId,table.dealId,table.sourceKey,table.sourceHash),index('workbench_meeting_import_project').on(table.ownerId,table.dealId,table.createdAt)]);
