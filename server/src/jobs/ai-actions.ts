import { create } from '@bufbuild/protobuf';
import { type JobSpec, JobSpecSchema } from '@gridelta/proto/console';
import type { ApprovalCenter, ApprovalJobDetail } from '../ai/approvals.ts';
import { classifyCommand } from '../ai/policy.ts';
import { isUnattended } from '../ai/sessions.ts';
import { specToInput } from '../rpc/jobs.ts';
import type { JobInput, JobRow, JobStore, Store } from '../store/index.ts';
import type { Scheduler } from './scheduler.ts';

export interface AiJobDeps {
  store: Store;
  jobs: JobStore;
  scheduler: Pick<Scheduler, 'reschedule'>;
  approvals: ApprovalCenter;
}

/** 명령 잡에서 위험으로 분류되는 명령 (설계 14.4). AI 잡(자연어 지시)은 실행 시 위험 명령이 거부되므로 보지 않는다 */
export function dangerousCommand(input: Pick<JobInput, 'kind' | 'commandUnix' | 'commandWindows'>): string | undefined {
  if (input.kind !== 'command') return undefined;
  return [input.commandUnix, input.commandWindows].find((c) => c && classifyCommand(c) === 'dangerous');
}

export function jobToSpec(j: JobRow): JobSpec {
  return create(JobSpecSchema, {
    name: j.name,
    kind: j.kind,
    targetType: j.targetType,
    targetId: j.targetId,
    cron: j.cron,
    runAtMs: BigInt(j.runAt?.getTime() ?? 0),
    timezone: j.timezone,
    commandUnix: j.commandUnix,
    commandWindows: j.commandWindows,
    aiPrompt: j.aiPrompt,
    recordName: j.recordName,
    recordParse: j.recordParse,
    timeoutS: j.timeoutS,
    concurrency: j.concurrency,
    enabled: j.enabled,
  });
}

export async function targetName(store: Store, j: Pick<JobInput, 'targetType' | 'targetId'>): Promise<string> {
  if (j.targetType === 'group') return `그룹 ${(await store.findGroup(j.targetId))?.name ?? j.targetId}`;
  const ep = await store.getEndpoint(j.targetId);
  return ep ? ep.displayName || ep.hostname : j.targetId;
}

/** 감사 로그의 endpoint_id: PC 대상이면 그 PC, 그룹이면 `group:<id>` */
const auditTarget = (j: Pick<JobInput, 'targetType' | 'targetId'>) =>
  j.targetType === 'endpoint' ? j.targetId : `group:${j.targetId}`;

export type AiSaveOutcome =
  /** 위험 명령이 없어 바로 저장됨 */
  | 'saved'
  /** 위험 명령이 있어 승인을 받고 저장됨 */
  | 'approved'
  /** 사람이 거부함. 새 잡은 지우고, 바꾸려던 잡은 그대로 둔다 */
  | 'denied'
  /** 승인 대기 시간이 지남. 새 잡은 꺼진 채 남고, 바꾸려던 잡은 그대로 둔다 */
  | 'expired'
  /** 스케줄 AI 잡 회차 안에서 위험한 잡을 만들려고 함. 저장하지 않는다 */
  | 'unattended';

/**
 * AI 가 잡을 만들거나 바꾼다 (설계 14.4). 위험 명령이 없으면 바로 저장하고, 있으면 그 대화 안에 승인 카드를 띄워
 * 결정을 기다린다. 새 잡은 기다리는 동안 꺼진 채 저장해 두어 서버가 재시작돼도 사람이 스케줄 화면에서 볼 수 있다.
 * session 은 요청한 AI 대화의 Flue 인스턴스 id.
 */
export async function saveJobAsAi(
  deps: AiJobDeps,
  o: { spec: JobSpec; session: string; existing?: JobRow; signal?: AbortSignal },
): Promise<{ outcome: AiSaveOutcome; job?: JobRow; command?: string }> {
  const { store, jobs, scheduler, approvals } = deps;
  const { existing, session } = o;
  const input = await specToInput(store, o.spec, existing?.createdBy ?? 'ai', existing?.createdSession ?? session);
  const verb = existing ? 'update' : 'create';
  const audit = (approvalId: string | null = null) =>
    store.audit({ actor: 'ai', endpointId: auditTarget(input), kind: 'job', command: `${verb} ${input.name}`, approvalId });

  const danger = dangerousCommand(input);
  if (!danger) {
    const job = existing ? (await jobs.updateJob(existing.id, input))! : await jobs.createJob(input, null);
    await scheduler.reschedule(job);
    await audit();
    return { outcome: 'saved', job: (await jobs.getJob(job.id))! };
  }
  if (await isUnattended(store, session)) return { outcome: 'unattended', command: danger };

  const pending = existing ?? (await jobs.createJob({ ...input, enabled: false }, null));
  const detail: ApprovalJobDetail = {
    spec: {
      name: input.name,
      kind: input.kind,
      targetType: input.targetType,
      targetId: input.targetId,
      cron: input.cron,
      runAtMs: input.runAt?.getTime() ?? 0,
      timezone: input.timezone,
      commandUnix: input.commandUnix,
      commandWindows: input.commandWindows,
      aiPrompt: input.aiPrompt,
      recordName: input.recordName,
      recordParse: input.recordParse,
    },
    targetName: await targetName(store, input),
  };
  const approval = await approvals.request(
    {
      kind: 'job',
      endpointId: input.targetType === 'endpoint' ? input.targetId : '',
      command: danger,
      requestedBy: session,
      detail: JSON.stringify(detail),
    },
    o.signal,
  );

  if (approval.decision === 'approved') {
    const job = (await jobs.updateJob(pending.id, { ...input, approvalId: approval.id }))!;
    await scheduler.reschedule(job);
    await audit(approval.id);
    return { outcome: 'approved', job: (await jobs.getJob(job.id))!, command: danger };
  }
  if (!existing) {
    if (approval.decision === 'denied') await jobs.deleteJob(pending.id);
    else await jobs.updateJob(pending.id, { approvalId: approval.id });
  }
  return { outcome: approval.decision, job: approval.decision === 'expired' && !existing ? pending : undefined, command: danger };
}

/** AI 가 잡을 지운다. 승인 없이 하되 감사 로그에 남긴다 (설계 14.4) */
export async function deleteJobAsAi(deps: Pick<AiJobDeps, 'store' | 'jobs'>, job: JobRow): Promise<void> {
  await deps.jobs.deleteJob(job.id);
  await deps.store.audit({ actor: 'ai', endpointId: auditTarget(job), kind: 'job', command: `delete ${job.name}` });
}
