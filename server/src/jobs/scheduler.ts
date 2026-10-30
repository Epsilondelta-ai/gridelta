import { create } from '@bufbuild/protobuf';
import { ExecRequestSchema } from '@gridelta/proto/gateway';
import { type AgentHub, EndpointOfflineError } from '../hub/index.ts';
import type { EndpointRow, JobRow, JobRunRow, JobStore, Store } from '../store/index.ts';
import { keepOutput, parseRecords, RecordParseError } from './output.ts';
import { nextRunAfter } from './schedule.ts';

/** 서버가 꺼져 있던 동안 놓친 회차는 이 안이면 한 번 실행한다 (설계 14.3) */
export const CATCHUP_WINDOW_MS = 60 * 60 * 1000;
/** 서버가 막 켜지면 에이전트들이 아직 다시 붙기 전이므로, 놓친 회차는 이만큼 기다렸다가 실행한다 */
export const CATCHUP_DELAY_MS = 30_000;
/** 다음 실행 시각까지 자더라도 이 간격으로는 깨어나 DB 를 다시 본다 */
const MAX_SLEEP_MS = 30_000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface SchedulerDeps {
  hub: AgentHub;
  store: Store;
  jobs: JobStore;
}

type Trigger = JobRunRow['trigger'];

const utf8 = new TextDecoder();

/**
 * 서버 쪽 스케줄러 (설계 14.3). 잡마다 next_run_at 을 DB 에 두고, 가장 가까운 시각에 깨어나 실행한다.
 * 실행은 기존 경로(AgentHub → 에이전트)를 그대로 쓴다.
 */
export class Scheduler {
  readonly #running = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #cleanupTimer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(private readonly deps: SchedulerDeps) {}

  /** 놓친 회차를 처리하고 실행 루프를 시작한다 */
  async start(now = new Date(), catchupDelayMs = CATCHUP_DELAY_MS): Promise<void> {
    await this.#catchUp(now, catchupDelayMs);
    this.#cleanupTimer = setInterval(() => void this.deps.jobs.cleanup(), CLEANUP_INTERVAL_MS);
    this.#cleanupTimer.unref();
    void this.#loop();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#cleanupTimer);
  }

  /** 잡이 바뀌었을 때 다음 실행 시각을 다시 계산하고 루프를 깨운다 */
  async reschedule(job: JobRow, now = new Date()): Promise<Date | null> {
    const next = job.enabled ? nextRunAfter(job, now) : null;
    await this.deps.jobs.setNextRun(job.id, next);
    this.wake();
    return next;
  }

  wake(): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#loop(), 0);
  }

  /** "지금 실행". 주기와는 상관없다. 회차가 시작되면(겹침이면 skipped 회차) 그 회차를 돌려준다 */
  async runNow(job: JobRow): Promise<JobRunRow> {
    return this.#start(job, new Date(), 'manual');
  }

  /**
   * 서버가 꺼져 있던 동안 실행 시각이 지난 잡: 1시간 안이면 한 번만 실행하고, 다음 시각은 지금부터 다시 계산한다.
   * 다음 시각은 바로 바꿔 두어 루프가 이 잡들을 주기 회차로 다시 실행하지 않게 하고,
   * 실제 실행은 에이전트들이 다시 붙을 시간을 준 뒤에 한다.
   */
  async #catchUp(now: Date, delayMs: number): Promise<void> {
    const missed: { job: JobRow; at: Date }[] = [];
    for (const job of await this.deps.jobs.dueJobs(now)) {
      const at = job.nextRunAt!;
      await this.deps.jobs.setNextRun(job.id, nextRunAfter(job, now));
      if (now.getTime() - at.getTime() <= CATCHUP_WINDOW_MS) missed.push({ job, at });
    }
    if (missed.length === 0) return;
    const run = () => {
      for (const m of missed) if (!this.#stopped) void this.#start(m.job, m.at, 'catchup');
    };
    if (delayMs <= 0) run();
    else setTimeout(run, delayMs).unref();
  }

  async #loop(): Promise<void> {
    if (this.#stopped) return;
    try {
      const now = new Date();
      for (const job of await this.deps.jobs.dueJobs(now)) {
        const scheduledAt = job.nextRunAt!;
        // 실행 전에 다음 시각을 먼저 정해 두어, 실행이 길어져도 같은 회차를 두 번 시작하지 않는다
        await this.deps.jobs.setNextRun(job.id, nextRunAfter(job, now));
        void this.#start(job, scheduledAt, 'schedule');
      }
    } catch (err) {
      console.error('[scheduler] tick failed', err);
    }
    if (this.#stopped) return;
    const next = await this.deps.jobs.earliestNextRun().catch(() => undefined);
    const wait = next ? Math.max(0, Math.min(next.getTime() - Date.now(), MAX_SLEEP_MS)) : MAX_SLEEP_MS;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#loop(), wait);
  }

  /** 회차를 시작한다. 이전 회차가 아직 돌고 있으면 건너뛴 회차로 남긴다 */
  async #start(job: JobRow, scheduledAt: Date, trigger: Trigger): Promise<JobRunRow> {
    const { jobs } = this.deps;
    if (this.#running.has(job.id)) {
      return jobs.createRun({
        jobId: job.id,
        scheduledAt,
        startedAt: new Date(),
        finishedAt: new Date(),
        status: 'skipped',
        note: '이전 회차가 아직 실행 중이라 건너뜀',
        trigger,
        targetCount: 0,
        ranCount: 0,
      });
    }
    this.#running.add(job.id);
    try {
      const targets = await this.#targets(job);
      const online = targets.filter((e) => this.deps.hub.get(e.id));
      const run = await jobs.createRun({
        jobId: job.id,
        scheduledAt,
        startedAt: new Date(),
        status: 'running',
        note: '',
        trigger,
        targetCount: targets.length,
        ranCount: online.length,
      });
      void this.#execute(job, run, online).finally(() => this.#running.delete(job.id));
      return run;
    } catch (err) {
      this.#running.delete(job.id);
      throw err;
    }
  }

  /** 대상 PC: PC 하나 또는 실행 시점의 그룹 소속 (폐기된 PC 제외) */
  async #targets(job: JobRow): Promise<EndpointRow[]> {
    const all = (await this.deps.store.listEndpoints()).filter((e) => !e.revokedAt);
    return job.targetType === 'endpoint' ? all.filter((e) => e.id === job.targetId) : all.filter((e) => e.groupId === job.targetId);
  }

  async #execute(job: JobRow, run: JobRunRow, online: EndpointRow[]): Promise<void> {
    const { jobs } = this.deps;
    let failed = 0;
    try {
      if (online.length === 0) {
        await jobs.finishRun(run.id, {
          status: 'skipped',
          note: run.targetCount === 0 ? '대상 PC 가 없음' : '대상 PC 가 모두 오프라인',
          ranCount: 0,
        });
        return;
      }
      // 동시 실행 수만큼 작업자를 두고 PC 를 나눠 처리한다
      const queue = [...online];
      const worker = async () => {
        for (let e = queue.shift(); e; e = queue.shift()) if (!(await this.#runOn(job, run, e))) failed++;
      };
      await Promise.all(Array.from({ length: Math.min(job.concurrency, online.length) }, worker));
      await jobs.finishRun(run.id, {
        status: failed > 0 ? 'failed' : 'succeeded',
        note: failed > 0 ? `${online.length}대 중 ${failed}대 실패` : '',
        ranCount: online.length,
      });
    } catch (err) {
      console.error(`[scheduler] run ${run.id} failed`, err);
      await jobs.finishRun(run.id, { status: 'failed', note: String(err), ranCount: online.length }).catch(() => {});
    }
  }

  /** PC 하나에서 명령을 실행하고 결과·상태 기록을 남긴다. 성공(종료 코드 0)이면 true */
  async #runOn(job: JobRow, run: JobRunRow, e: EndpointRow): Promise<boolean> {
    const { hub, store, jobs } = this.deps;
    const startedAt = new Date();
    const command = e.os === 'windows' ? job.commandWindows : job.commandUnix;
    const base = { runId: run.id, endpointId: e.id, startedAt };
    if (!command) {
      await jobs.addResult({ ...base, exitCode: null, error: `${e.os} 용 명령이 없음`, output: '', truncated: false, recordStatus: 'none', finishedAt: new Date() });
      return false;
    }

    try {
      const timeoutMs = job.timeoutS * 1000;
      const res = await hub.request(
        e.id,
        { case: 'exec', value: create(ExecRequestSchema, { command, timeoutMs }) },
        { timeoutMs: timeoutMs + 15_000 },
      );
      if (res.result.case !== 'exec') throw new Error('unexpected exec response');
      const r = res.result.value;
      const stdout = utf8.decode(r.stdout);
      const { output, truncated } = keepOutput(stdout, utf8.decode(r.stderr));

      let recordStatus: 'none' | 'saved' | 'failed' = 'none';
      let error = '';
      if (job.recordName && r.exitCode === 0) {
        try {
          const recordedAt = new Date();
          for (const [name, value] of parseRecords(job.recordName, job.recordParse, stdout)) {
            await jobs.addRecord({ endpointId: e.id, name, value, recordedAt, source: `job:${job.id}:${run.id}` });
          }
          recordStatus = 'saved';
        } catch (err) {
          recordStatus = 'failed';
          error = err instanceof RecordParseError ? `상태 기록 실패: ${err.message}` : String(err);
        }
      }
      await jobs.addResult({ ...base, exitCode: r.exitCode, error, output, truncated: truncated || r.truncated, recordStatus, finishedAt: new Date() });
      await store.audit({ actor: 'schedule', endpointId: e.id, kind: 'job', command: `${job.name}: ${command}`, exitCode: r.exitCode });
      return r.exitCode === 0;
    } catch (err) {
      const error = err instanceof EndpointOfflineError ? '실행 중 연결이 끊김' : String(err instanceof Error ? err.message : err);
      await jobs.addResult({ ...base, exitCode: null, error, output: '', truncated: false, recordStatus: 'none', finishedAt: new Date() });
      return false;
    }
  }
}
