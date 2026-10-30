import { and, asc, desc, eq, gte, inArray, isNotNull, like, lt, lte, sql } from 'drizzle-orm';
import { uuidv7 } from '../auth/tokens.ts';
import type { Db } from './db.ts';
import { jobResults, jobRuns, jobs, records } from './schema.ts';

export type JobRow = typeof jobs.$inferSelect;
export type JobInput = Omit<JobRow, 'id' | 'nextRunAt' | 'createdAt' | 'updatedAt'>;
export type JobRunRow = typeof jobRuns.$inferSelect;
export type JobResultRow = typeof jobResults.$inferSelect;
export type RecordRow = typeof records.$inferSelect;

const DAY = 24 * 60 * 60 * 1000;
/** 실행 기록 보관: 30일 또는 잡당 최근 100회 (설계 14.3) */
export const RUN_RETENTION_MS = 30 * DAY;
export const RUNS_PER_JOB = 100;
/** 상태 기록 보관 90일 (설계 14.5) */
export const RECORD_RETENTION_MS = 90 * DAY;

/** 스케줄 잡·회차·결과·상태 기록 DB 접근 */
export class JobStore {
  constructor(readonly db: Db) {}

  // --- 잡 ---

  async createJob(input: JobInput, nextRunAt: Date | null): Promise<JobRow> {
    const now = new Date();
    const row: JobRow = { ...input, id: uuidv7(), nextRunAt, createdAt: now, updatedAt: now };
    await this.db.insert(jobs).values(row);
    return row;
  }

  async updateJob(id: string, patch: Partial<JobInput> & { nextRunAt?: Date | null }): Promise<JobRow | undefined> {
    await this.db
      .update(jobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(jobs.id, id));
    return this.getJob(id);
  }

  /** 스케줄러 전용: updated_at 을 건드리지 않고 다음 실행 시각만 바꾼다 */
  async setNextRun(id: string, nextRunAt: Date | null): Promise<void> {
    await this.db.update(jobs).set({ nextRunAt }).where(eq(jobs.id, id));
  }

  async getJob(id: string): Promise<JobRow | undefined> {
    const [row] = await this.db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    return row;
  }

  async listJobs(): Promise<JobRow[]> {
    return this.db.select().from(jobs).orderBy(asc(jobs.createdAt));
  }

  async deleteJob(id: string): Promise<boolean> {
    const result = await this.db.delete(jobs).where(eq(jobs.id, id));
    return Number(result.changes) === 1;
  }

  /** 켜져 있고 실행 시각이 된 잡 */
  async dueJobs(now: Date): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.enabled, true), isNotNull(jobs.nextRunAt), lte(jobs.nextRunAt, now)))
      .orderBy(asc(jobs.nextRunAt));
  }

  /** 가장 가까운 다음 실행 시각 (스케줄러가 그때까지 잔다) */
  async earliestNextRun(): Promise<Date | undefined> {
    const [row] = await this.db
      .select({ at: sql<number>`min(${jobs.nextRunAt})` })
      .from(jobs)
      .where(eq(jobs.enabled, true));
    return row?.at ? new Date(Number(row.at)) : undefined;
  }

  // --- 회차·결과 ---

  async createRun(run: Omit<JobRunRow, 'id' | 'finishedAt' | 'aiSessionId'> & { finishedAt?: Date }): Promise<JobRunRow> {
    const row: JobRunRow = { finishedAt: null, aiSessionId: null, ...run, id: uuidv7() };
    await this.db.insert(jobRuns).values(row);
    return row;
  }

  async finishRun(id: string, patch: Pick<JobRunRow, 'status' | 'note' | 'ranCount'>): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ ...patch, finishedAt: new Date() })
      .where(eq(jobRuns.id, id));
  }

  async getRun(id: string): Promise<JobRunRow | undefined> {
    const [row] = await this.db.select().from(jobRuns).where(eq(jobRuns.id, id)).limit(1);
    return row;
  }

  async listRuns(jobId: string, limit = 50): Promise<JobRunRow[]> {
    return this.db.select().from(jobRuns).where(eq(jobRuns.jobId, jobId)).orderBy(desc(jobRuns.startedAt)).limit(limit);
  }

  /** 잡마다 가장 최근 회차 */
  async lastRuns(jobIds: string[]): Promise<Map<string, JobRunRow>> {
    const map = new Map<string, JobRunRow>();
    if (jobIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(jobRuns)
      .where(inArray(jobRuns.jobId, jobIds))
      .orderBy(desc(jobRuns.startedAt));
    for (const r of rows) if (!map.has(r.jobId)) map.set(r.jobId, r);
    return map;
  }

  async addResult(row: Omit<JobResultRow, 'id'>): Promise<void> {
    await this.db.insert(jobResults).values(row);
  }

  async listResults(runId: string): Promise<JobResultRow[]> {
    return this.db.select().from(jobResults).where(eq(jobResults.runId, runId)).orderBy(asc(jobResults.startedAt));
  }

  // --- 상태 기록 ---

  async addRecord(row: Omit<RecordRow, 'id'>): Promise<void> {
    await this.db.insert(records).values(row);
  }

  /** PC 의 이름별 최신 값 */
  async latestRecords(endpointId: string): Promise<RecordRow[]> {
    const latest = this.db
      .select({ name: records.name, at: sql<number>`max(${records.recordedAt})`.as('at') })
      .from(records)
      .where(eq(records.endpointId, endpointId))
      .groupBy(records.name)
      .as('latest');
    return this.db
      .select({
        id: records.id,
        endpointId: records.endpointId,
        name: records.name,
        value: records.value,
        recordedAt: records.recordedAt,
        source: records.source,
      })
      .from(records)
      .innerJoin(latest, and(eq(records.name, latest.name), eq(records.recordedAt, latest.at)))
      .where(eq(records.endpointId, endpointId))
      .orderBy(asc(records.name));
  }

  /** 이름(정확히 또는 `prefix.` 아래 전부)과 기간으로 조회, 최근 것부터 */
  async listRecords(q: { endpointId: string; name?: string; since?: Date; limit?: number }): Promise<RecordRow[]> {
    const conds = [eq(records.endpointId, q.endpointId)];
    if (q.name) conds.push(sql`(${records.name} = ${q.name} or ${like(records.name, `${q.name}.%`)})`);
    if (q.since) conds.push(gte(records.recordedAt, q.since));
    return this.db
      .select()
      .from(records)
      .where(and(...conds))
      .orderBy(desc(records.recordedAt))
      .limit(q.limit ?? 200);
  }

  /** 오래된 회차(30일, 잡당 100회 초과)와 상태 기록(90일)을 지운다 */
  async cleanup(now = Date.now()): Promise<void> {
    await this.db.delete(jobRuns).where(lt(jobRuns.startedAt, new Date(now - RUN_RETENTION_MS)));
    this.db.run(sql`
      delete from ${jobRuns} where ${jobRuns.id} in (
        select id from (
          select id, row_number() over (partition by job_id order by started_at desc) as n from ${jobRuns}
        ) where n > ${RUNS_PER_JOB}
      )`);
    await this.db.delete(records).where(lt(records.recordedAt, new Date(now - RECORD_RETENTION_MS)));
  }
}
