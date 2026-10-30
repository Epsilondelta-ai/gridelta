import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** PC 그룹. 'default' 는 처음부터 있는 "기본" 그룹이며 지울 수 없다 */
export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const endpoints = sqliteTable('endpoints', {
  id: text('id').primaryKey(),
  hostname: text('hostname').notNull(),
  displayName: text('display_name').notNull().default(''),
  groupId: text('group_id').notNull().default('default'),
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
  /** 이 토큰으로 등록한 PC 가 들어갈 그룹 */
  groupId: text('group_id').notNull().default('default'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  /** 마지막으로 쓴 시각 */
  usedAt: integer('used_at', { mode: 'timestamp_ms' }),
  /** 0 이면 만료 전까지 무제한 */
  maxUses: integer('max_uses').notNull().default(1),
  uses: integer('uses').notNull().default(0),
  revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
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
  actor: text('actor', { enum: ['user', 'ai', 'schedule'] }).notNull(),
  userId: text('user_id'),
  endpointId: text('endpoint_id').notNull(),
  kind: text('kind', { enum: ['exec', 'pty', 'fs', 'job'] }).notNull(),
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

/** 스케줄 잡 (설계 14장). 대상은 PC 하나 또는 그룹 */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['command', 'ai'] }).notNull(),
  targetType: text('target_type', { enum: ['endpoint', 'group'] }).notNull(),
  targetId: text('target_id').notNull(),
  /** cron 식 (5~6필드). 비어 있으면 runAt 에 한 번만 실행 */
  cron: text('cron').notNull().default(''),
  runAt: integer('run_at', { mode: 'timestamp_ms' }),
  timezone: text('timezone').notNull().default('UTC'),
  commandUnix: text('command_unix').notNull().default(''),
  commandWindows: text('command_windows').notNull().default(''),
  aiPrompt: text('ai_prompt').notNull().default(''),
  /** 명령 잡 출력을 저장할 상태 이름. 비어 있으면 저장하지 않는다 */
  recordName: text('record_name').notNull().default(''),
  recordParse: text('record_parse', { enum: ['json', 'kv', 'text'] }).notNull().default('json'),
  timeoutS: integer('timeout_s').notNull().default(600),
  concurrency: integer('concurrency').notNull().default(10),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** 다음 실행 시각. 꺼졌거나 한 번만 실행하는 잡을 이미 실행했으면 null */
  nextRunAt: integer('next_run_at', { mode: 'timestamp_ms' }),
  createdBy: text('created_by', { enum: ['user', 'ai'] }).notNull(),
  /** AI 가 만들었으면 그 대화 세션 (Flue 인스턴스 id) */
  createdSession: text('created_session').notNull().default(''),
  approvalId: text('approval_id'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** 잡 회차. 겹쳐서 건너뛴 회차도 status=skipped 로 남긴다 */
export const jobRuns = sqliteTable('job_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id')
    .notNull()
    .references(() => jobs.id, { onDelete: 'cascade' }),
  scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
  status: text('status', { enum: ['running', 'succeeded', 'failed', 'skipped'] }).notNull(),
  /** skipped·failed 의 이유 (겹침, 대상 없음 등) */
  note: text('note').notNull().default(''),
  /** manual = 지금 실행, schedule = 주기, catchup = 서버가 꺼져 있던 동안 놓친 회차 */
  trigger: text('trigger', { enum: ['schedule', 'manual', 'catchup'] }).notNull(),
  targetCount: integer('target_count').notNull().default(0),
  ranCount: integer('ran_count').notNull().default(0),
  aiSessionId: text('ai_session_id'),
});

/** 회차 안에서 PC 하나의 결과. 오프라인으로 건너뛴 PC 는 행이 없다 */
export const jobResults = sqliteTable('job_results', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  runId: text('run_id')
    .notNull()
    .references(() => jobRuns.id, { onDelete: 'cascade' }),
  endpointId: text('endpoint_id').notNull(),
  /** 명령이 끝나지 못했으면(전송 실패·명령 없음) null 이고 error 에 이유 */
  exitCode: integer('exit_code'),
  error: text('error').notNull().default(''),
  /** stdout + stderr, 최대 64 KB (넘으면 앞뒤 32 KB) */
  output: text('output').notNull().default(''),
  truncated: integer('truncated', { mode: 'boolean' }).notNull().default(false),
  /** 상태 기록 저장 결과: none(저장 안 함) | saved | failed */
  recordStatus: text('record_status', { enum: ['none', 'saved', 'failed'] }).notNull().default('none'),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  finishedAt: integer('finished_at', { mode: 'timestamp_ms' }).notNull(),
});

/** PC 상태 기록: 이름 + JSON 값. 덮어쓰지 않고 쌓는다 (설계 14.5) */
export const records = sqliteTable(
  'records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    endpointId: text('endpoint_id').notNull(),
    name: text('name').notNull(),
    /** JSON 문자열 */
    value: text('value').notNull(),
    recordedAt: integer('recorded_at', { mode: 'timestamp_ms' }).notNull(),
    /** job:<job_id>:<run_id> 또는 ai:<세션> */
    source: text('source').notNull(),
  },
  (t) => [index('records_endpoint_name_time').on(t.endpointId, t.name, t.recordedAt)],
);
