import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { hashToken, randomToken, tokenMatches, uuidv7 } from '../auth/tokens.ts';
import type { Db } from './db.ts';
import {
  aiSessions,
  approvals,
  auditLog,
  endpoints,
  enrollTokens,
  groups,
  oauthTokens,
  sessions,
  settings,
  users,
} from './schema.ts';

export type EndpointRow = typeof endpoints.$inferSelect;

export interface HelloInfo {
  hostname: string;
  os: string;
  arch: string;
  homeDir: string;
  defaultShell: string;
  agentVersion: string;
}

export class UsernameTakenError extends Error {}
export class NameTakenError extends Error {}

/** 처음부터 있는 "기본" 그룹 (마이그레이션이 만든다) */
export const DEFAULT_GROUP = 'default';
export type GroupRow = typeof groups.$inferSelect;
export type EnrollTokenRow = typeof enrollTokens.$inferSelect;

export interface SessionUser {
  id: string;
  username: string;
}

export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalPolicy = 'always' | 'dangerous' | 'auto';
export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['always', 'dangerous', 'auto'];

export type AiSessionRow = typeof aiSessions.$inferSelect;
/** 통합(여러 PC) 대화의 scope 값 */
export const ALL_PCS = 'all';

export type OAuthTokenRow = typeof oauthTokens.$inferSelect;

export type AuditEntry = Omit<typeof auditLog.$inferInsert, 'id' | 'at'>;

// 사용자 없음과 비밀번호 틀림의 응답 시간을 비슷하게 맞추기 위한 더미 해시
let dummyHash: Promise<string> | undefined;

/** 앱 DB 접근. DB 를 직접 만지는 코드는 store/ 밖에 두지 않는다. */
export class Store {
  constructor(readonly db: Db) {}

  // --- 등록 토큰 ---

  /** 그룹에 PC 를 등록하는 토큰을 만든다. maxUses 0 이면 만료 전까지 여러 PC 가 쓸 수 있다 */
  async createEnrollToken(
    ttlMs: number,
    opts: { groupId?: string; maxUses?: number } = {},
    now = Date.now(),
  ): Promise<{ token: string; tokenHash: string; expiresAt: Date }> {
    const token = randomToken();
    const tokenHash = hashToken(token);
    const expiresAt = new Date(now + ttlMs);
    await this.db.insert(enrollTokens).values({
      tokenHash,
      groupId: opts.groupId ?? DEFAULT_GROUP,
      createdAt: new Date(now),
      expiresAt,
      maxUses: opts.maxUses ?? 1,
    });
    return { token, tokenHash, expiresAt };
  }

  /**
   * 쓸 수 있는 토큰이면(폐기·만료되지 않았고 사용 횟수가 남음) 한 번 사용 처리하고 등록할 그룹 id 를 돌려준다.
   * 하나의 UPDATE 로 확인과 사용을 함께 하므로 동시에 쓰여도 횟수를 넘지 않는다.
   */
  async consumeEnrollToken(token: string, now = Date.now()): Promise<string | undefined> {
    const rows = await this.db
      .update(enrollTokens)
      .set({ usedAt: new Date(now), uses: sql`${enrollTokens.uses} + 1` })
      .where(
        and(
          eq(enrollTokens.tokenHash, hashToken(token)),
          isNull(enrollTokens.revokedAt),
          gt(enrollTokens.expiresAt, new Date(now)),
          or(eq(enrollTokens.maxUses, 0), lt(enrollTokens.uses, enrollTokens.maxUses)),
        ),
      )
      .returning({ groupId: enrollTokens.groupId });
    return rows[0]?.groupId;
  }

  /** 아직 쓸 수 있는 토큰 목록 (폐기·만료·소진된 것 제외) */
  async listEnrollTokens(groupId?: string, now = Date.now()): Promise<EnrollTokenRow[]> {
    const rows = await this.db
      .select()
      .from(enrollTokens)
      .where(
        and(
          isNull(enrollTokens.revokedAt),
          gt(enrollTokens.expiresAt, new Date(now)),
          or(eq(enrollTokens.maxUses, 0), lt(enrollTokens.uses, enrollTokens.maxUses)),
          groupId ? eq(enrollTokens.groupId, groupId) : undefined,
        ),
      )
      .orderBy(desc(enrollTokens.createdAt));
    return rows;
  }

  async revokeEnrollToken(tokenHash: string): Promise<boolean> {
    const result = await this.db
      .update(enrollTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(enrollTokens.tokenHash, tokenHash), isNull(enrollTokens.revokedAt)));
    return Number(result.changes) === 1;
  }

  // --- 그룹 ---

  async listGroups(): Promise<(GroupRow & { endpointCount: number })[]> {
    const rows = await this.db
      .select({
        id: groups.id,
        name: groups.name,
        createdAt: groups.createdAt,
        endpointCount: sql<number>`(select count(*) from ${endpoints} where ${endpoints.groupId} = ${groups.id} and ${endpoints.revokedAt} is null)`,
      })
      .from(groups)
      .orderBy(groups.createdAt);
    return rows.map((r) => ({ ...r, endpointCount: Number(r.endpointCount) }));
  }

  /** id 또는 이름으로 찾는다 (CLI 에서 이름으로 부를 수 있게) */
  async findGroup(ref: string): Promise<GroupRow | undefined> {
    const [row] = await this.db
      .select()
      .from(groups)
      .where(or(eq(groups.id, ref), eq(groups.name, ref)))
      .limit(1);
    return row;
  }

  async createGroup(name: string): Promise<GroupRow> {
    if (await this.findGroup(name)) throw new NameTakenError(`group ${name} already exists`);
    const row: GroupRow = { id: uuidv7(), name, createdAt: new Date() };
    await this.db.insert(groups).values(row);
    return row;
  }

  async renameGroup(id: string, name: string): Promise<boolean> {
    const other = await this.findGroup(name);
    if (other && other.id !== id) throw new NameTakenError(`group ${name} already exists`);
    const result = await this.db.update(groups).set({ name }).where(eq(groups.id, id));
    return Number(result.changes) === 1;
  }

  /** 그룹을 지운다. 그 안의 PC 는 기본 그룹으로 옮기고, 그룹의 등록 토큰은 폐기한다 */
  async deleteGroup(id: string): Promise<boolean> {
    if (id === DEFAULT_GROUP) throw new Error('the default group cannot be deleted');
    // node:sqlite 는 동기 드라이버라 트랜잭션 콜백도 동기여야 한다
    return this.db.transaction((tx) => {
      tx.update(endpoints).set({ groupId: DEFAULT_GROUP }).where(eq(endpoints.groupId, id)).run();
      tx.update(enrollTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(enrollTokens.groupId, id), isNull(enrollTokens.revokedAt)))
        .run();
      return Number(tx.delete(groups).where(eq(groups.id, id)).run().changes) === 1;
    });
  }

  async moveEndpoint(endpointId: string, groupId: string): Promise<boolean> {
    const result = await this.db
      .update(endpoints)
      .set({ groupId })
      .where(and(eq(endpoints.id, endpointId), isNull(endpoints.revokedAt)));
    return Number(result.changes) === 1;
  }

  // --- 엔드포인트 ---

  /** 새 에이전트를 등록하고 자격 증명을 발급한다. 자격 증명 원문은 이때만 돌려준다. */
  async enrollEndpoint(
    info: Pick<HelloInfo, 'hostname' | 'os' | 'arch'>,
    groupId = DEFAULT_GROUP,
  ): Promise<{ id: string; credential: string }> {
    const id = uuidv7();
    const credential = randomToken();
    await this.db.insert(endpoints).values({
      id,
      hostname: info.hostname,
      os: info.os,
      arch: info.arch,
      groupId,
      credentialHash: hashToken(credential),
      enrolledAt: new Date(),
    });
    return { id, credential };
  }

  /** 자격 증명이 맞고 폐기되지 않은 엔드포인트만 돌려준다. */
  async authenticateEndpoint(id: string, credential: string): Promise<EndpointRow | undefined> {
    const row = await this.getEndpoint(id);
    if (!row || row.revokedAt || !tokenMatches(credential, row.credentialHash)) return undefined;
    return row;
  }

  async getEndpoint(id: string): Promise<EndpointRow | undefined> {
    const rows = await this.db.select().from(endpoints).where(eq(endpoints.id, id)).limit(1);
    return rows[0];
  }

  async listEndpoints(): Promise<EndpointRow[]> {
    return this.db.select().from(endpoints).orderBy(endpoints.enrolledAt);
  }

  /** Hello 를 받을 때마다 최신 정보를 저장한다. PC 가 오프라인이어도 마지막 정보를 쓰기 위함. */
  async updateFromHello(id: string, info: HelloInfo): Promise<void> {
    await this.db
      .update(endpoints)
      .set({ ...info, lastSeen: new Date() })
      .where(eq(endpoints.id, id));
  }

  async touchEndpoint(id: string, at: Date): Promise<void> {
    await this.db.update(endpoints).set({ lastSeen: at }).where(eq(endpoints.id, id));
  }

  async renameEndpoint(id: string, displayName: string): Promise<boolean> {
    const result = await this.db
      .update(endpoints)
      .set({ displayName })
      .where(and(eq(endpoints.id, id), isNull(endpoints.revokedAt)));
    return Number(result.changes) === 1;
  }

  async revokeEndpoint(id: string): Promise<boolean> {
    const result = await this.db
      .update(endpoints)
      .set({ revokedAt: new Date() })
      .where(and(eq(endpoints.id, id), isNull(endpoints.revokedAt)));
    return Number(result.changes) === 1;
  }

  // --- 사용자 ---

  async createUser(username: string, password: string): Promise<string> {
    const existing = await this.db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (existing.length > 0) throw new UsernameTakenError(`user ${username} already exists`);
    const id = uuidv7();
    await this.db
      .insert(users)
      .values({ id, username, passwordHash: await argon2Hash(password), createdAt: new Date() });
    return id;
  }

  /** 아이디·비밀번호가 맞으면 사용자를 돌려준다. */
  async verifyPassword(username: string, password: string): Promise<SessionUser | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.username, username)).limit(1);
    const hash = row?.passwordHash ?? (await (dummyHash ??= argon2Hash('not-a-real-password')));
    const ok = await argon2Verify(hash, password).catch(() => false);
    return row && ok ? { id: row.id, username: row.username } : undefined;
  }

  // --- 웹 세션 ---

  async createSession(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const now = Date.now();
    const expiresAt = new Date(now + ttlMs);
    await this.db.insert(sessions).values({ tokenHash: hashToken(token), userId, createdAt: new Date(now), expiresAt });
    return { token, expiresAt };
  }

  async getSessionUser(token: string): Promise<SessionUser | undefined> {
    const [row] = await this.db
      .select({ id: users.id, username: users.username })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);
    return row;
  }

  async deleteSession(token: string): Promise<void> {
    await this.db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }

  async deleteExpiredSessions(): Promise<void> {
    await this.db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  }

  // --- 감사 로그 ---

  async audit(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({ ...entry, at: new Date() });
  }

  // --- AI 승인 ---

  async setApprovalPolicy(endpointId: string, policy: ApprovalPolicy): Promise<boolean> {
    const result = await this.db.update(endpoints).set({ approvalPolicy: policy }).where(eq(endpoints.id, endpointId));
    return Number(result.changes) === 1;
  }

  async createApproval(
    row: Pick<ApprovalRow, 'endpointId' | 'command' | 'requestedBy'> & Partial<Pick<ApprovalRow, 'kind' | 'detail'>>,
  ): Promise<ApprovalRow> {
    const approval: ApprovalRow = {
      kind: 'exec',
      detail: '',
      ...row,
      id: uuidv7(),
      status: 'pending',
      createdAt: new Date(),
      decidedBy: null,
      decidedAt: null,
    };
    await this.db.insert(approvals).values(approval);
    return approval;
  }

  /** 대기 중인 요청만 결정할 수 있다. 이미 결정·만료됐으면 false. */
  async decideApproval(id: string, status: 'approved' | 'denied' | 'expired', decidedBy?: string): Promise<boolean> {
    const result = await this.db
      .update(approvals)
      .set({ status, decidedBy: decidedBy ?? null, decidedAt: new Date() })
      .where(and(eq(approvals.id, id), eq(approvals.status, 'pending')));
    return Number(result.changes) === 1;
  }

  /** 서버 재시작 전에 대기 중이던 요청은 기다리던 AI 호출이 사라졌으므로 만료 처리한다. */
  async expirePendingApprovals(): Promise<void> {
    await this.db
      .update(approvals)
      .set({ status: 'expired', decidedAt: new Date() })
      .where(eq(approvals.status, 'pending'));
  }

  // --- OAuth 자격 증명 (암호화는 호출자가 한다) ---

  async getOAuthToken(provider: string): Promise<OAuthTokenRow | undefined> {
    const [row] = await this.db.select().from(oauthTokens).where(eq(oauthTokens.provider, provider)).limit(1);
    return row;
  }

  async putOAuthToken(row: Omit<OAuthTokenRow, 'updatedAt'>): Promise<void> {
    const values = { ...row, updatedAt: new Date() };
    await this.db.insert(oauthTokens).values(values).onConflictDoUpdate({ target: oauthTokens.provider, set: values });
  }

  async deleteOAuthToken(provider: string): Promise<boolean> {
    const result = await this.db.delete(oauthTokens).where(eq(oauthTokens.provider, provider));
    return Number(result.changes) === 1;
  }

  // --- 설정 ---

  async getSetting(key: string): Promise<string | undefined> {
    const [row] = await this.db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row?.value;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  // --- AI 대화 세션 ---

  async createAiSession(scope: string, o: { title?: string; jobRunId?: string } = {}): Promise<AiSessionRow> {
    const now = new Date();
    const row: AiSessionRow = {
      id: uuidv7(),
      scope,
      title: o.title ?? '',
      jobRunId: o.jobRunId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(aiSessions).values(row);
    return row;
  }

  async getAiSession(id: string): Promise<AiSessionRow | undefined> {
    const [row] = await this.db.select().from(aiSessions).where(eq(aiSessions.id, id)).limit(1);
    return row;
  }

  /** 최근에 쓴 것부터. scopes 를 주면 그 scope 들만 */
  async listAiSessions(scopes?: string[]): Promise<AiSessionRow[]> {
    const q = this.db.select().from(aiSessions);
    const filtered = scopes ? q.where(inArray(aiSessions.scope, scopes)) : q;
    return filtered.orderBy(desc(aiSessions.updatedAt));
  }

  async renameAiSession(id: string, title: string): Promise<boolean> {
    const result = await this.db.update(aiSessions).set({ title }).where(eq(aiSessions.id, id));
    return Number(result.changes) === 1;
  }

  async touchAiSession(id: string): Promise<void> {
    await this.db.update(aiSessions).set({ updatedAt: new Date() }).where(eq(aiSessions.id, id));
  }

  async deleteAiSession(id: string): Promise<boolean> {
    const result = await this.db.delete(aiSessions).where(eq(aiSessions.id, id));
    return Number(result.changes) === 1;
  }
}
