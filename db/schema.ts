import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
