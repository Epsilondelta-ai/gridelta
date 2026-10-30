import { init } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';
import { Operator } from '../agents/operator.ts';
import type { AiJobRunner } from '../jobs/scheduler.ts';
import { ALL_PCS, type EndpointRow, type JobStore, type Store } from '../store/index.ts';

const pcLine = (e: EndpointRow) => `- ${e.displayName || e.hostname} (id ${e.id}, ${e.os}/${e.arch})`;

/**
 * AI 잡 회차 실행기 (설계 14.3). 회차마다 `[스케줄] <잡 이름> <일시>` 대화를 만들고(PC 대상이면 PC 대화,
 * 그룹이면 통합 대화) 지시를 보낸 뒤 답을 기다린다. 대화는 job_run_id 로 표시되어, 그 안의 위험 명령은
 * 승인을 기다리지 않고 거부된다. 타임아웃이 지나면 대화를 중단한다.
 */
export function aiJobRunner(store: Store, jobs: JobStore): AiJobRunner {
  return async (job, run, online, offline) => {
    const when = new Intl.DateTimeFormat('ko-KR', { timeZone: job.timezone, dateStyle: 'short', timeStyle: 'short' }).format(
      run.scheduledAt,
    );
    const scope = job.targetType === 'endpoint' ? job.targetId : ALL_PCS;
    const session = await store.createAiSession(scope, { title: `[스케줄] ${job.name} ${when}`, jobRunId: run.id });
    await jobs.setRunSession(run.id, session.id);

    const lines = [`[스케줄 잡 "${job.name}"] ${when} 회차입니다. 사람이 지켜보지 않으므로 위험 명령은 실행되지 않습니다.`];
    if (job.targetType === 'group') {
      const group = await store.findGroup(job.targetId);
      lines.push(`대상: 그룹 ${group?.name ?? job.targetId} 의 온라인 PC`, ...online.map(pcLine));
      if (offline.length > 0) lines.push(`오프라인이라 이번 회차에서 제외: ${offline.map((e) => e.displayName || e.hostname).join(', ')}`);
    }
    lines.push('', job.aiPrompt);

    const handle = init(scope === ALL_PCS ? Assistant : Operator, {
      id: scope === ALL_PCS ? session.id : `${scope}:${session.id}`,
    });
    const timeout = AbortSignal.timeout(job.timeoutS * 1000);
    try {
      const receipt = await handle.dispatch({ message: lines.join('\n'), idempotencyKey: run.id });
      const reply = await handle.read(receipt, { signal: timeout });
      return { text: reply.text };
    } catch (err) {
      if (timeout.aborted) {
        await handle.abort().catch(() => {});
        return { text: '', error: `타임아웃 (${job.timeoutS}초)` };
      }
      return { text: '', error: err instanceof Error ? err.message : String(err) };
    }
  };
}
