import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const endpoints = sqliteTable('endpoints', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  displayName: text('display_name').notNull().default(''),
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

/** 웹 로그인 세션. 쿠키에는 원문 토큰, DB 에는 해시만 둔다. */
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/** 사람·AI 가 실행한 작업 기록. PTY 는 입력 내용 없이 시작/종료만 남긴다. */
export const auditLog = sqliteTable('audit_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  at: integer('at', { mode: 'timestamp_ms' }).notNull(),
  actor: text('actor', { enum: ['user', 'ai'] }).notNull(),
  userId: text('user_id'),
  endpointId: text('endpoint_id').notNull(),
  kind: text('kind', { enum: ['exec', 'pty', 'fs'] }).notNull(),
  command: text('command').notNull(),
  exitCode: integer('exit_code'),
  approvalId: text('approval_id'),
});

/** AI 가 요청한 위험 명령의 승인 대기열. */
export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  endpointId: text('endpoint_id').notNull(),
  command: text('command').notNull(),
  requestedBy: text('requested_by').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied', 'expired'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  decidedBy: text('decided_by'),
  decidedAt: integer('decided_at', { mode: 'timestamp_ms' }),
});

/** OpenAI 등 OAuth 자격 증명. credential 은 마스터 키로 암호화한 값이다. */
export const oauthTokens = sqliteTable('oauth_tokens', {
  provider: text('provider').primaryKey(),
  credential: text('credential').notNull(),
  keyVersion: integer('key_version').notNull(),
  account: text('account').notNull().default(''),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** 서버 설정 (AI 모델 등). 값은 JSON 이 아닌 문자열이다 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/** AI 대화 세션 목록. 대화 내용은 Flue 가 flue.db 에 저장하고, 여기에는 목록과 이름만 둔다 */
export const aiSessions = sqliteTable('ai_sessions', {
  id: text('id').primaryKey(),
  /** 'all' 이면 여러 PC 를 다루는 통합 대화, 아니면 그 PC(endpoint id)에 묶인 대화 */
  scope: text('scope').notNull(),
  title: text('title').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
