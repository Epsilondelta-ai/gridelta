import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const endpoints = sqliteTable('endpoints', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  os: text('os').notNull(),
  arch: text('arch').notNull(),
  homeDir: text('home_dir').notNull().default(''),
  defaultShell: text('default_shell').notNull().default(''),
  agentVersion: text('agent_version').notNull().default(''),
  credentialHash: text('credential_hash').notNull(),
  enrolledAt: integer('enrolled_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeen: integer('last_seen', { mode: 'timestamp_ms' }),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull().default([]),
  approvalPolicy: text('approval_policy').notNull().default('dangerous'),
});

export const enrollTokens = sqliteTable('enroll_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});
