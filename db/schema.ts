import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  id: text('id').notNull(),
  payload: text('payload').notNull(),
}, table => [uniqueIndex('events_id_unique').on(table.id)]);
export const home = sqliteTable('home', {
  id: text('id').primaryKey(),
  profiles: text('profiles').notNull(),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
});
