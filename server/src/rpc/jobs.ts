import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type Job,
  type JobResult,
  JobResultSchema,
  type JobRun,
  JobRunSchema,
  JobSchema,
  type JobSpec,
  type StateRecord,
  StateRecordSchema,
} from '@gridelta/proto/console';
import { InvalidScheduleError, validateSchedule } from '../jobs/schedule.ts';
import type { Scheduler } from '../jobs/scheduler.ts';
import type { JobInput, JobResultRow, JobRow, JobRunRow, JobStore, RecordRow, Store } from '../store/index.ts';

const RECORD_NAME = /^[A-Za-z0-9_][\w.-]{0,127}$/;
const ms = (d: Date | null | undefined) => BigInt(d?.getTime() ?? 0);

export function toRun(r: JobRunRow): JobRun {
  return create(JobRunSchema, {
    id: r.id,
    jobId: r.jobId,
    scheduledAtMs: ms(r.scheduledAt),
    startedAtMs: ms(r.startedAt),
    finishedAtMs: ms(r.finishedAt),
    status: r.status,
    note: r.note,
    trigger: r.trigger,
    targetCount: r.targetCount,
    ranCount: r.ranCount,
    aiSessionId: r.aiSessionId ?? '',
  });
}

function toJob(j: JobRow, lastRun?: JobRunRow): Job {
  return create(JobSchema, {
    id: j.id,
    spec: {
      name: j.name,
      kind: j.kind,
      targetType: j.targetType,
      targetId: j.targetId,
      cron: j.cron,
      runAtMs: ms(j.runAt),
      timezone: j.timezone,
      commandUnix: j.commandUnix,
      commandWindows: j.commandWindows,
      aiPrompt: j.aiPrompt,
      recordName: j.recordName,
      recordParse: j.recordParse,
      timeoutS: j.timeoutS,
      concurrency: j.concurrency,
      enabled: j.enabled,
    },
    nextRunAtMs: ms(j.nextRunAt),
    createdBy: j.createdBy,
    createdAtMs: ms(j.createdAt),
    updatedAtMs: ms(j.updatedAt),
    lastRun: lastRun && toRun(lastRun),
  });
}

function toResult(r: JobResultRow): JobResult {
  return create(JobResultSchema, {
    endpointId: r.endpointId,
    exitCode: r.exitCode ?? undefined,
    error: r.error,
    output: r.output,
    truncated: r.truncated,
    recordStatus: r.recordStatus,
    startedAtMs: ms(r.startedAt),
    finishedAtMs: ms(r.finishedAt),
  });
}

export function toRecord(r: RecordRow): StateRecord {
  return create(StateRecordSchema, {
    endpointId: r.endpointId,
    name: r.name,
    valueJson: r.value,
    recordedAtMs: ms(r.recordedAt),
    source: r.source,
  });
}

const invalid = (msg: string) => new ConnectError(msg, Code.InvalidArgument);

/** JobSpec 을 검사해 DB 에 넣을 값으로 바꾼다. 사람(웹)과 AI 도구가 함께 쓴다 */
export async function specToInput(
  store: Store,
  spec: JobSpec | undefined,
  createdBy: JobInput['createdBy'],
  createdSession = '',
): Promise<JobInput> {
  if (!spec) throw invalid('spec is required');
  const name = spec.name.trim();
  if (!name || [...name].length > 64) throw invalid('이름은 1~64자여야 합니다');
  if (spec.kind !== 'command' && spec.kind !== 'ai') throw invalid('kind 는 command 또는 ai 입니다');
  const ai = spec.kind === 'ai';

  if (spec.targetType === 'endpoint') {
    const ep = await store.getEndpoint(spec.targetId);
    if (!ep || ep.revokedAt) throw invalid(`PC ${spec.targetId} 를 찾지 못했습니다`);
  } else if (spec.targetType === 'group') {
    if (!(await store.findGroup(spec.targetId))) throw invalid(`그룹 ${spec.targetId} 를 찾지 못했습니다`);
  } else {
    throw invalid('대상은 PC(endpoint) 또는 그룹(group) 입니다');
  }

  const schedule = {
    cron: spec.cron.trim(),
    runAt: spec.runAtMs ? new Date(Number(spec.runAtMs)) : null,
    timezone: spec.timezone || 'UTC',
  };
  try {
    validateSchedule(schedule);
  } catch (err) {
    if (err instanceof InvalidScheduleError) throw invalid(err.message);
    throw err;
  }

  if (ai && !spec.aiPrompt.trim()) throw invalid('AI 에게 줄 지시가 필요합니다');
  if (!ai && !spec.commandUnix.trim() && !spec.commandWindows.trim()) throw invalid('실행할 명령이 필요합니다');
  if (!ai && spec.recordName && !RECORD_NAME.test(spec.recordName)) throw invalid('상태 이름은 영문·숫자·_ . - 로 128자 이내입니다');
  if (!['json', 'kv', 'text'].includes(spec.recordParse || 'json')) throw invalid('record_parse 는 json, kv, text 중 하나입니다');
  const timeoutS = spec.timeoutS || 600;
  const concurrency = spec.concurrency || 10;
  if (timeoutS > 86400) throw invalid('타임아웃은 24시간 이내입니다');
  if (concurrency > 100) throw invalid('동시 실행은 100 이하입니다');

  return {
    name,
    kind: spec.kind,
    targetType: spec.targetType,
    targetId: spec.targetId,
    ...schedule,
    // AI 잡은 명령·상태 저장 대신 지시만 쓴다 (상태는 AI 가 record_value 로 남긴다)
    commandUnix: ai ? '' : spec.commandUnix.trim(),
    commandWindows: ai ? '' : spec.commandWindows.trim(),
    aiPrompt: ai ? spec.aiPrompt.trim() : '',
    recordName: ai ? '' : spec.recordName,
    recordParse: (spec.recordParse || 'json') as JobInput['recordParse'],
    timeoutS,
    concurrency,
    enabled: spec.enabled,
    createdBy,
    createdSession,
    approvalId: null,
  };
}

/** ConsoleService 의 잡·상태 기록 메서드 */
export function jobHandlers(deps: { store: Store; jobs: JobStore; scheduler: Scheduler }) {
  const { store, jobs, scheduler } = deps;
  const mustGet = async (id: string) => {
    const job = await jobs.getJob(id);
    if (!job) throw new ConnectError(`job ${id} not found`, Code.NotFound);
    return job;
  };
  const withLastRun = async (job: JobRow) => toJob(job, (await jobs.lastRuns([job.id])).get(job.id));

  return {
    async listJobs() {
      const rows = await jobs.listJobs();
      const last = await jobs.lastRuns(rows.map((j) => j.id));
      return { jobs: rows.map((j) => toJob(j, last.get(j.id))) };
    },

    async getJob(req: { id: string }) {
      return withLastRun(await mustGet(req.id));
    },

    async createJob(req: { spec?: JobSpec }) {
      const input = await specToInput(store, req.spec, 'user');
      const job = await jobs.createJob(input, null);
      await scheduler.reschedule(job);
      return withLastRun((await jobs.getJob(job.id))!);
    },

    async updateJob(req: { id: string; spec?: JobSpec }) {
      const before = await mustGet(req.id);
      const input = await specToInput(store, req.spec, before.createdBy, before.createdSession);
      const job = (await jobs.updateJob(req.id, input))!;
      await scheduler.reschedule(job);
      return withLastRun((await jobs.getJob(job.id))!);
    },

    async deleteJob(req: { id: string }) {
      if (!(await jobs.deleteJob(req.id))) throw new ConnectError(`job ${req.id} not found`, Code.NotFound);
      return {};
    },

    async setJobEnabled(req: { id: string; enabled: boolean }) {
      await mustGet(req.id);
      const job = (await jobs.updateJob(req.id, { enabled: req.enabled }))!;
      await scheduler.reschedule(job);
      return withLastRun((await jobs.getJob(job.id))!);
    },

    async runJobNow(req: { id: string }) {
      return toRun(await scheduler.runNow(await mustGet(req.id)));
    },

    async listJobRuns(req: { jobId: string; limit: number }) {
      return { runs: (await jobs.listRuns(req.jobId, req.limit || 50)).map(toRun) };
    },

    async getJobRun(req: { runId: string }) {
      const run = await jobs.getRun(req.runId);
      if (!run) throw new ConnectError(`run ${req.runId} not found`, Code.NotFound);
      return { run: toRun(run), results: (await jobs.listResults(run.id)).map(toResult) };
    },

    async listLatestRecords(req: { endpointId: string }) {
      return { records: (await jobs.latestRecords(req.endpointId)).map(toRecord) };
    },

    async listRecords(req: { endpointId: string; name: string; sinceMs: bigint; limit: number }) {
      const rows = await jobs.listRecords({
        endpointId: req.endpointId,
        name: req.name || undefined,
        since: req.sinceMs ? new Date(Number(req.sinceMs)) : undefined,
        limit: Math.min(req.limit || 200, 1000),
      });
      return { records: rows.map(toRecord) };
    },
  };
}
