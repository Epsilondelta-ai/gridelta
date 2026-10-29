import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { hashToken, randomToken, tokenMatches, uuidv7 } from '../auth/tokens.ts';
import type { Db } from './db.ts';
import { auditLog, endpoints, enrollTokens, sessions, users } from './schema.ts';

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

export interface SessionUser {
  id: string;
  username: string;
}

export type AuditEntry = Omit<typeof auditLog.$inferInsert, 'id' | 'at'>;

// 사용자 없음과 비밀번호 틀림의 응답 시간을 비슷하게 맞추기 위한 더미 해시
let dummyHash: Promise<string> | undefined;

/** 앱 DB 접근. DB 를 직접 만지는 코드는 store/ 밖에 두지 않는다. */
export class Store {
  constructor(readonly db: Db) {}

  // --- 등록 토큰 ---

  async createEnrollToken(ttlMs: number, now = Date.now()): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(now + ttlMs);
    await this.db.insert(enrollTokens).values({ tokenHash: hashToken(token), createdAt: new Date(now), expiresAt });
    return { token, expiresAt };
  }

  /** 아직 쓰이지 않았고 만료되지 않은 토큰이면 사용 처리하고 true. 동시에 두 번 쓰여도 한 번만 성공한다. */
  async consumeEnrollToken(token: string, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .update(enrollTokens)
      .set({ usedAt: new Date(now) })
      .where(
        and(
          eq(enrollTokens.tokenHash, hashToken(token)),
          isNull(enrollTokens.usedAt),
          gt(enrollTokens.expiresAt, new Date(now)),
        ),
      );
    return Number(result.changes) === 1;
  }

  // --- 엔드포인트 ---

  /** 새 에이전트를 등록하고 자격 증명을 발급한다. 자격 증명 원문은 이때만 돌려준다. */
  async enrollEndpoint(info: Pick<HelloInfo, 'hostname' | 'os' | 'arch'>): Promise<{ id: string; credential: string }> {
    const id = uuidv7();
    const credential = randomToken();
    await this.db.insert(endpoints).values({
      id,
      hostname: info.hostname,
      os: info.os,
      arch: info.arch,
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
}
