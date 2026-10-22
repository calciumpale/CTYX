import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** One isolated, versioned JSON workspace per platform-authenticated user. */
export const workbenchWorkspaces = sqliteTable('workbench_workspaces', {
  userId: text('user_id').primaryKey(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
