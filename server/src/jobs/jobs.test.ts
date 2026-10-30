import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { ResponseSchema } from '@gridelta/proto/gateway';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentHub } from '../hub/index.ts';
import { openDb } from '../store/db.ts';
import { type JobInput, JobStore } from '../store/jobs.ts';
import { Store } from '../store/store.ts';
import { keepOutput, OUTPUT_LIMIT_BYTES, parseRecords, RecordParseError } from './output.ts';
import { InvalidScheduleError, nextRunAfter, validateSchedule } from './schedule.ts';
import { CATCHUP_WINDOW_MS, Scheduler } from './scheduler.ts';

describe('keepOutput', () => {
  it('keeps short output and appends stderr', () => {
    expect(keepOutput('out\n', 'err')).toEqual({ output: 'out\n--- stderr ---\nerr', truncated: false });
  });

  it('keeps the first and last 32 KB of long output', () => {
    const { output, truncated } = keepOutput(`HEAD${'x'.repeat(200_000)}TAIL`, '');
    expect(truncated).toBe(true);
    expect(output.startsWith('HEAD')).toBe(true);
    expect(output.endsWith('TAIL')).toBe(true);
    expect(Buffer.byteLength(output)).toBeLessThan(OUTPUT_LIMIT_BYTES + 100);
  });
});

describe('parseRecords', () => {
  it('json: whole output as one value', () => {
    expect([...parseRecords('disk.root', 'json', ' {"used_pct": 42}\n')]).toEqual([['disk.root', '{"used_pct":42}']]);
    expect(() => parseRecords('x', 'json', 'not json')).toThrow(RecordParseError);
  });

  it('kv: one record per key, values parsed as JSON when possible', () => {
    expect(Object.fromEntries(parseRecords('mem', 'kv', 'total=512\nfree = 128\nnote=hello world\nnoise line\n'))).toEqual({
      'mem.total': '512',
      'mem.free': '128',
      'mem.note': '"hello world"',
    });
    expect(() => parseRecords('mem', 'kv', 'nothing here')).toThrow(RecordParseError);
  });

  it('text: trimmed output as a string', () => {
    expect([...parseRecords('kernel', 'text', '  6.1.0\n')]).toEqual([['kernel', '"6.1.0"']]);
  });
});

describe('schedule', () => {
  it('computes the next cron run in the job timezone', () => {
    const s = { cron: '0 9 * * 1-5', runAt: null, timezone: 'Asia/Seoul' };
    // 금요일 09:30 KST 다음은 월요일 09:00 KST
    expect(nextRunAfter(s, new Date('2026-10-30T00:30:00Z'))?.toISOString()).toBe('2026-11-02T00:00:00.000Z');
  });

  it('runs a one-time job once', () => {
    const at = new Date('2026-11-01T00:00:00Z');
    const s = { cron: '', runAt: at, timezone: 'UTC' };
    expect(nextRunAfter(s, new Date('2026-10-31T00:00:00Z'))).toEqual(at);
    expect(nextRunAfter(s, at)).toBeNull();
  });

  it('rejects invalid cron, timezone or missing schedule', () => {
    expect(() => validateSchedule({ cron: 'bad', runAt: null, timezone: 'UTC' })).toThrow(InvalidScheduleError);
    expect(() => validateSchedule({ cron: '* * * * *', runAt: null, timezone: 'Nope/Zone' })).toThrow(InvalidScheduleError);
    expect(() => validateSchedule({ cron: '', runAt: null, timezone: 'UTC' })).toThrow(InvalidScheduleError);
  });
});

describe('Scheduler', () => {
  let store: Store;
  let jobs: JobStore;
  let online: Set<string>;
  let execs: { endpointId: string; command: string }[];
  let release: (() => void) | undefined;
  let scheduler: Scheduler;

  const fakeHub = {
    get: (id: string) => (online.has(id) ? {} : undefined),
    request: async (endpointId: string, op: { value: { command: string } }) => {
      execs.push({ endpointId, command: op.value.command });
      if (op.value.command === 'block') await new Promise<void>((r) => (release = r));
      const stdout = new TextEncoder().encode(op.value.command === 'fail' ? '' : '{"used_pct": 7}');
      return create(ResponseSchema, {
        result: { case: 'exec', value: { exitCode: op.value.command === 'fail' ? 3 : 0, stdout, stderr: new Uint8Array() } },
      });
    },
  } as unknown as AgentHub;

  const job = (over: Partial<JobInput> = {}): JobInput => ({
    name: 'disk',
    kind: 'command',
    targetType: 'group',
    targetId: 'default',
    cron: '0 * * * *',
    runAt: null,
    timezone: 'UTC',
    commandUnix: 'df',
    commandWindows: '',
    aiPrompt: '',
    recordName: 'disk.root',
    recordParse: 'json',
    timeoutS: 60,
    concurrency: 10,
    enabled: true,
    createdBy: 'user',
    createdSession: '',
    approvalId: null,
    ...over,
  });

  /** 회차가 끝날 때까지 기다린다 */
  async function finished(runId: string) {
    for (let i = 0; i < 100; i++) {
      const run = await jobs.getRun(runId);
      if (run && run.status !== 'running') return run;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('run did not finish');
  }

  beforeEach(async () => {
    store = new Store(openDb(':memory:', resolve(import.meta.dirname, '../../drizzle')));
    jobs = new JobStore(store.db);
    online = new Set();
    execs = [];
    scheduler = new Scheduler({ hub: fakeHub, store, jobs });
  });

  it('runs on online group members only and stores records', async () => {
    const a = await store.enrollEndpoint({ hostname: 'a', os: 'linux', arch: 'arm64' });
    const b = await store.enrollEndpoint({ hostname: 'b', os: 'linux', arch: 'arm64' });
    const w = await store.enrollEndpoint({ hostname: 'w', os: 'windows', arch: 'amd64' });
    online.add(a.id).add(w.id);
    const j = await jobs.createJob(job(), null);

    const run = await finished((await scheduler.runNow(j)).id);
    expect(run).toMatchObject({ status: 'failed', targetCount: 3, ranCount: 2 }); // w 는 Windows 명령이 없어 실패
    const results = await jobs.listResults(run.id);
    expect(results.map((r) => r.endpointId).sort()).toEqual([a.id, w.id].sort()); // 오프라인 b 는 결과 없음
    expect(results.find((r) => r.endpointId === w.id)?.error).toContain('windows 용 명령이 없음');
    expect((await jobs.latestRecords(a.id)).map((r) => [r.name, r.value])).toEqual([['disk.root', '{"used_pct":7}']]);
    expect(await jobs.latestRecords(b.id)).toEqual([]);
  });

  it('records a skipped run when all targets are offline', async () => {
    await store.enrollEndpoint({ hostname: 'a', os: 'linux', arch: 'arm64' });
    const j = await jobs.createJob(job(), null);
    expect(await finished((await scheduler.runNow(j)).id)).toMatchObject({ status: 'skipped', ranCount: 0 });
  });

  it('skips a run while the previous one is still running', async () => {
    const a = await store.enrollEndpoint({ hostname: 'a', os: 'linux', arch: 'arm64' });
    online.add(a.id);
    const j = await jobs.createJob(job({ commandUnix: 'block', recordName: '' }), null);
    const first = await scheduler.runNow(j);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    const second = await scheduler.runNow(j);
    expect(second).toMatchObject({ status: 'skipped' });
    release();
    expect(await finished(first.id)).toMatchObject({ status: 'succeeded' });
  });

  it('catches up a missed run within an hour once, and skips older ones', async () => {
    const a = await store.enrollEndpoint({ hostname: 'a', os: 'linux', arch: 'arm64' });
    online.add(a.id);
    const now = new Date('2026-10-30T10:30:00Z');
    const recent = await jobs.createJob(job({ name: 'recent' }), new Date(now.getTime() - 10 * 60_000));
    const old = await jobs.createJob(job({ name: 'old' }), new Date(now.getTime() - CATCHUP_WINDOW_MS - 60_000));

    await scheduler.start(now, 0);
    await new Promise((r) => setTimeout(r, 50));
    scheduler.stop();
    const recentRuns = await jobs.listRuns(recent.id);
    expect(recentRuns.map((r) => r.trigger)).toEqual(['catchup']);
    expect(await jobs.listRuns(old.id)).toEqual([]);
    // 다음 시각은 지금부터 다시 계산된다
    expect((await jobs.getJob(old.id))?.nextRunAt?.toISOString()).toBe('2026-10-30T11:00:00.000Z');
  });
});
