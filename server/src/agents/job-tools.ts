import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { approvals } from '../ai/index.ts';
import { hub } from '../hub/index.ts';
import { RECORD_VALUE_LIMIT_BYTES } from '../jobs/output.ts';
import { deleteJobAsAi, jobToSpec, saveJobAsAi, targetName } from '../jobs/ai-actions.ts';
import { scheduler } from '../jobs/index.ts';
import { type JobRow, jobStore as jobs, store } from '../store/index.ts';
import { resolvePc } from './pcs.ts';

const deps = { store, jobs, scheduler, approvals };
const RECORD_NAME = /^[A-Za-z0-9_][\w.-]{0,127}$/;
/** run_job_now 가 명령 잡의 결과를 기다리는 최대 시간 */
const RUN_WAIT_MS = 120_000;
/** 도구 결과에 넣는 PC 별 출력 상한. 전체 출력은 스케줄 화면의 회차 기록에 있다 */
const RESULT_OUTPUT_CHARS = 4000;

/** 두 에이전트가 함께 쓰는 잡·상태 기록 안내 */
export const JOB_GUIDE = [
  '정기적으로 할 일은 create_job 으로 스케줄 잡을 만들 수 있습니다. 명령 잡의 출력이나 record_value 로 남긴 값은 PC 의 상태 기록으로 쌓이고 query_records 로 조회합니다.',
  '"[스케줄 잡" 으로 시작하는 메시지는 사람이 지켜보지 않는 스케줄 실행입니다. 위험 명령은 실행되지 않으니(종료 코드 126) 시도하지 말고, 수집한 값은 record_value 로 남긴 뒤 결과를 짧게 요약하십시오.',
].join('\n');

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

async function findJob(ref: string): Promise<JobRow> {
  const found = await jobs.findJob(ref);
  if (found.length === 1) return found[0]!;
  const names = (await jobs.listJobs()).map((j) => `${j.name} (${j.id})`).join(', ') || '없음';
  throw new Error(found.length > 1 ? `"${ref}" 이름의 잡이 여럿입니다. id 로 지정하세요: ${names}` : `"${ref}" 잡을 찾지 못했습니다. 있는 잡: ${names}`);
}

async function resolveGroup(ref: string): Promise<string> {
  const g = await store.findGroup(ref);
  if (g) return g.id;
  const names = (await store.listGroups()).map((x) => `${x.name} (${x.id})`).join(', ');
  throw new Error(`"${ref}" 그룹을 찾지 못했습니다. 있는 그룹: ${names}`);
}

/** 잡 목록에 보일 요약 */
async function summary(j: JobRow, last?: { status: string; startedAt: Date; note: string }) {
  return {
    id: j.id,
    name: j.name,
    kind: j.kind,
    target: await targetName(store, j),
    cron: j.cron || null,
    run_at: iso(j.runAt),
    timezone: j.timezone,
    ...(j.kind === 'command'
      ? { command_unix: j.commandUnix, command_windows: j.commandWindows, record_name: j.recordName, record_parse: j.recordParse }
      : { ai_prompt: j.aiPrompt }),
    enabled: j.enabled,
    next_run: iso(j.nextRunAt),
    last_run: last ? { status: last.status, at: last.startedAt.toISOString(), note: last.note } : null,
    created_by: j.createdBy,
  };
}

// create_job·update_job 이 함께 쓰는 잡 내용. update_job 은 준 항목만 바꾼다
const jobFields = {
  name: v.optional(v.pipe(v.string(), v.description('잡 이름 (64자 이내)'))),
  kind: v.optional(v.pipe(v.picklist(['command', 'ai']), v.description('command = 셸 명령 실행, ai = 자연어 지시를 AI 가 수행'))),
  target_pc: v.optional(v.pipe(v.string(), v.description('대상 PC 하나 (id, 이름 또는 호스트 이름). target_group 과 둘 중 하나'))),
  target_group: v.optional(v.pipe(v.string(), v.description('대상 그룹 (id 또는 이름). 실행 시점의 소속 PC 모두에서 실행'))),
  cron: v.optional(v.pipe(v.string(), v.description('반복 주기 cron 식 (5필드, 초를 포함하면 6필드). 예: "0 9 * * 1-5" = 평일 09:00'))),
  run_at: v.optional(v.pipe(v.string(), v.description('한 번만 실행할 일시 (ISO 8601, 예: 2026-11-01T09:00:00+09:00). cron 대신'))),
  timezone: v.optional(v.pipe(v.string(), v.description('IANA 시간대 (예: Asia/Seoul). cron 을 해석하는 기준'))),
  command_unix: v.optional(v.pipe(v.string(), v.description('명령 잡: macOS·Linux 에서 실행할 셸 명령'))),
  command_windows: v.optional(v.pipe(v.string(), v.description('명령 잡: Windows 에서 실행할 PowerShell 명령'))),
  ai_prompt: v.optional(v.pipe(v.string(), v.description('AI 잡: 실행할 때 AI 에게 줄 지시'))),
  record_name: v.optional(v.pipe(v.string(), v.description('명령 잡: 출력을 저장할 상태 이름 (예: disk.root). 비우면 저장 안 함'))),
  record_parse: v.optional(
    v.pipe(v.picklist(['json', 'kv', 'text']), v.description('출력 해석: json = 출력 전체가 JSON, kv = 줄마다 이름=값, text = 텍스트 그대로')),
  ),
  timeout_seconds: v.optional(v.pipe(v.number(), v.description('PC 하나당 실행 시간 상한 (기본 600)'))),
  enabled: v.optional(v.boolean()),
};
type JobFields = { [K in keyof typeof jobFields]?: v.InferOutput<(typeof jobFields)[K]> };

/** 도구 입력을 기존 잡(또는 기본값) 위에 덮어 JobSpec 으로 만든다 */
async function applyFields(base: ReturnType<typeof jobToSpec>, f: JobFields, defaultPc?: string) {
  const spec = { ...base };
  if (f.name !== undefined) spec.name = f.name;
  if (f.kind !== undefined) spec.kind = f.kind;
  if (f.target_pc) {
    spec.targetType = 'endpoint';
    spec.targetId = (await resolvePc(store, hub, f.target_pc)).id;
  } else if (f.target_group) {
    spec.targetType = 'group';
    spec.targetId = await resolveGroup(f.target_group);
  } else if (!spec.targetId && defaultPc) {
    spec.targetType = 'endpoint';
    spec.targetId = defaultPc;
  }
  if (f.cron !== undefined) {
    spec.cron = f.cron;
    if (f.cron) spec.runAtMs = 0n;
  }
  if (f.run_at) {
    const at = new Date(f.run_at);
    if (Number.isNaN(at.getTime())) throw new Error(`run_at 을 해석하지 못했습니다: ${f.run_at}`);
    spec.runAtMs = BigInt(at.getTime());
    spec.cron = '';
  }
  if (f.timezone !== undefined) spec.timezone = f.timezone;
  if (f.command_unix !== undefined) spec.commandUnix = f.command_unix;
  if (f.command_windows !== undefined) spec.commandWindows = f.command_windows;
  if (f.ai_prompt !== undefined) spec.aiPrompt = f.ai_prompt;
  if (f.record_name !== undefined) spec.recordName = f.record_name;
  if (f.record_parse !== undefined) spec.recordParse = f.record_parse;
  if (f.timeout_seconds !== undefined) spec.timeoutS = Math.round(f.timeout_seconds);
  if (f.enabled !== undefined) spec.enabled = f.enabled;
  return spec;
}

const OUTCOME_TEXT = {
  saved: (name: string) => `잡 "${name}" 을 저장했습니다.`,
  approved: (name: string) => `위험 명령이 있어 사용자 승인을 받았고, 잡 "${name}" 을 저장했습니다.`,
  denied: (name: string) => `사용자가 잡 "${name}" 을 거부했습니다. 저장하지 않았습니다.`,
  expired: (name: string) => `승인 대기 시간이 지나 잡 "${name}" 을 켜지 않았습니다. 사용자가 스케줄 화면에서 켤 수 있습니다.`,
  unattended: (name: string) => `스케줄 실행 중에는 위험 명령이 든 잡 "${name}" 을 만들 수 없습니다.`,
};

/**
 * 잡과 상태 기록을 다루는 AI 도구 7종 (설계 14.6). 통합 대화와 PC 대화가 함께 쓴다.
 * instanceId 는 대화의 Flue 인스턴스 id, defaultPc 는 PC 대화의 그 PC (도구에서 PC 를 생략하면 쓴다).
 */
export function useJobTools({ instanceId, defaultPc }: { instanceId: string; defaultPc?: string }) {
  const pcRef = defaultPc ? '대상 PC (생략하면 이 대화의 PC)' : '대상 PC 의 id, 이름 또는 호스트 이름';
  const pcOf = async (ref: string | undefined) => {
    if (ref) return (await resolvePc(store, hub, ref)).id;
    if (defaultPc) return defaultPc;
    throw new Error('pc 를 지정하세요');
  };

  useTool(
    defineTool({
      name: 'list_jobs',
      description: '스케줄 잡 목록: 종류, 대상, 주기, 명령 또는 지시, 켜짐, 다음 실행 시각, 마지막 회차 결과.',
      run: async () => {
        const rows = await jobs.listJobs();
        const last = await jobs.lastRuns(rows.map((j) => j.id));
        return JSON.stringify(await Promise.all(rows.map((j) => summary(j, last.get(j.id)))), null, 2);
      },
    }),
  );

  useTool(
    defineTool({
      name: 'create_job',
      description: [
        '정해진 시각에 PC 또는 그룹에서 실행할 스케줄 잡을 만든다.',
        '명령 잡(kind=command)은 셸 명령을 실행하고, record_name 을 주면 출력을 PC 상태로 저장한다.',
        'AI 잡(kind=ai)은 실행할 때마다 새 AI 대화를 열어 ai_prompt 를 수행한다 (사람이 지켜보지 않으므로 위험 명령은 거부된다).',
        '명령에 위험한 명령(rm -rf, sudo 등)이 있으면 사용자 승인을 기다리며, 승인되면 켜진다.',
      ].join(' '),
      input: v.object({ ...jobFields, name: v.pipe(v.string(), v.description('잡 이름 (64자 이내)')), kind: jobFields.kind }),
      run: async ({ data, signal }) => {
        const base = jobToSpec({
          name: '',
          kind: 'command',
          targetType: 'endpoint',
          targetId: '',
          cron: '',
          runAt: null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          commandUnix: '',
          commandWindows: '',
          aiPrompt: '',
          recordName: '',
          recordParse: 'json',
          timeoutS: 600,
          concurrency: 10,
          enabled: true,
        } as JobRow);
        if (data.kind === 'ai') base.kind = 'ai';
        else if (!data.kind && data.ai_prompt && !data.command_unix && !data.command_windows) base.kind = 'ai';
        const spec = await applyFields(base, data, defaultPc);
        if (!spec.targetId) throw new Error('target_pc 또는 target_group 을 지정하세요');
        const r = await saveJobAsAi(deps, { spec, session: instanceId, signal });
        const text = OUTCOME_TEXT[r.outcome](spec.name);
        return r.job ? `${text}\n${JSON.stringify(await summary(r.job), null, 2)}` : text;
      },
    }),
  );

  useTool(
    defineTool({
      name: 'update_job',
      description: '잡을 바꾼다. 준 항목만 바뀐다. 바뀐 명령에 위험한 명령이 있으면 사용자 승인 후에 적용된다.',
      input: v.object({ job: v.pipe(v.string(), v.description('잡 id 또는 이름')), ...jobFields }),
      run: async ({ data, signal }) => {
        const existing = await findJob(data.job);
        const spec = await applyFields(jobToSpec(existing), data);
        const r = await saveJobAsAi(deps, { spec, session: instanceId, existing, signal });
        const text = OUTCOME_TEXT[r.outcome](spec.name).replace('저장하지 않았습니다', '바꾸지 않았습니다');
        return r.job ? `${text}\n${JSON.stringify(await summary(r.job), null, 2)}` : text;
      },
    }),
  );

  useTool(
    defineTool({
      name: 'delete_job',
      description: '잡을 지운다. 실행 기록도 함께 지워진다.',
      input: v.object({ job: v.pipe(v.string(), v.description('잡 id 또는 이름')) }),
      run: async ({ data }) => {
        const job = await findJob(data.job);
        await deleteJobAsAi(deps, job);
        return `잡 "${job.name}" 을 지웠습니다.`;
      },
    }),
  );

  useTool(
    defineTool({
      name: 'run_job_now',
      description: '잡을 지금 한 번 실행한다. 명령 잡은 끝날 때까지(최대 2분) 기다려 PC 별 결과를 돌려준다.',
      input: v.object({ job: v.pipe(v.string(), v.description('잡 id 또는 이름')) }),
      run: async ({ data, signal }) => {
        const job = await findJob(data.job);
        let run = await scheduler.runNow(job);
        if (job.kind === 'ai') return `AI 잡 "${job.name}" 회차를 시작했습니다 (회차 ${run.id}). 결과는 스케줄 화면의 실행 기록에서 볼 수 있습니다.`;
        const deadline = Date.now() + RUN_WAIT_MS;
        while (run.status === 'running' && Date.now() < deadline && !signal?.aborted) {
          await new Promise((r) => setTimeout(r, 1000));
          run = (await jobs.getRun(run.id)) ?? run;
        }
        const results = await jobs.listResults(run.id);
        const pcs = new Map((await store.listEndpoints()).map((e) => [e.id, e.displayName || e.hostname]));
        return JSON.stringify(
          {
            run_id: run.id,
            status: run.status,
            note: run.note,
            target_count: run.targetCount,
            ran_count: run.ranCount,
            results: results.map((r) => ({
              pc: pcs.get(r.endpointId) ?? r.endpointId,
              exit_code: r.exitCode,
              error: r.error || undefined,
              record_status: r.recordStatus,
              output: r.output.length > RESULT_OUTPUT_CHARS ? `${r.output.slice(0, RESULT_OUTPUT_CHARS)}\n…(생략)` : r.output,
            })),
          },
          null,
          2,
        );
      },
    }),
  );

  useTool(
    defineTool({
      name: 'record_value',
      description:
        'PC 의 상태 기록을 남긴다 (이름 + 값, 덮어쓰지 않고 쌓인다). 이름은 점으로 나누는 관례를 쓴다 (예: disk.root, mem, service.nginx). 값은 JSON(숫자, 객체 등)이나 텍스트.',
      input: v.object({
        pc: v.optional(v.pipe(v.string(), v.description(pcRef))),
        name: v.pipe(v.string(), v.description('상태 이름 (영문·숫자·_ . -)')),
        value: v.pipe(v.string(), v.description('값. JSON 으로 읽히면(42, {"used_pct": 42}, "문자열") JSON 으로, 아니면 텍스트로 저장')),
      }),
      run: async ({ data }) => {
        const endpointId = await pcOf(data.pc);
        if (!RECORD_NAME.test(data.name)) throw new Error('상태 이름은 영문·숫자·_ . - 로 128자 이내입니다');
        let value: unknown = data.value;
        try {
          value = JSON.parse(data.value);
        } catch {
          // JSON 이 아니면 텍스트 그대로
        }
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > RECORD_VALUE_LIMIT_BYTES) throw new Error('값이 64 KB 를 넘습니다');
        await jobs.addRecord({ endpointId, name: data.name, value: json, recordedAt: new Date(), source: `ai:${instanceId}` });
        return `${data.name} = ${json} 를 기록했습니다.`;
      },
    }),
  );

  useTool(
    defineTool({
      name: 'query_records',
      description: 'PC 의 상태 기록을 조회한다. name 을 생략하면 이름별 최신 값, 주면 그 이름(과 그 아래 name.*)의 이전 값들을 최근 것부터 돌려준다.',
      input: v.object({
        pc: v.optional(v.pipe(v.string(), v.description(pcRef))),
        name: v.optional(v.pipe(v.string(), v.description('상태 이름 또는 접두사 (예: disk → disk.root, disk.home)'))),
        since_hours: v.optional(v.pipe(v.number(), v.description('최근 몇 시간 안의 기록만'))),
        limit: v.optional(v.pipe(v.number(), v.description('최대 개수 (기본 50, 최대 500)'))),
      }),
      run: async ({ data }) => {
        const endpointId = await pcOf(data.pc);
        const rows = data.name
          ? await jobs.listRecords({
              endpointId,
              name: data.name,
              since: data.since_hours ? new Date(Date.now() - data.since_hours * 3600_000) : undefined,
              limit: Math.min(Math.max(1, Math.round(data.limit ?? 50)), 500),
            })
          : await jobs.latestRecords(endpointId);
        if (rows.length === 0) return '기록이 없습니다.';
        return JSON.stringify(
          rows.map((r) => ({ name: r.name, value: JSON.parse(r.value) as unknown, recorded_at: r.recordedAt.toISOString(), source: r.source })),
          null,
          2,
        );
      },
    }),
  );
}
