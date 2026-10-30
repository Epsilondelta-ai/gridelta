import { ALL_PCS, type AiSessionRow, type Store } from '../store/index.ts';

/** 세션의 Flue 대화 URL. 통합 대화는 Assistant, PC 대화는 Operator(인스턴스 id `<endpoint>:<세션>`, 설계 8.1) */
export function agentUrl(row: Pick<AiSessionRow, 'id' | 'scope'>): string {
  return row.scope === ALL_PCS
    ? `/agents/assistant/${row.id}`
    : `/agents/operator/${encodeURIComponent(`${row.scope}:${row.id}`)}`;
}

/**
 * Flue 라우트의 인스턴스 id 가 등록된 세션인지 확인한다. 아무 id 로나 대화를 열 수 없게 한다.
 * agent 는 라우트 이름(assistant | operator).
 */
export async function sessionForInstance(
  store: Store,
  agent: 'assistant' | 'operator',
  instanceId: string,
): Promise<AiSessionRow | undefined> {
  if (agent === 'assistant') {
    const row = await store.getAiSession(instanceId);
    return row?.scope === ALL_PCS ? row : undefined;
  }
  const sep = instanceId.lastIndexOf(':');
  if (sep < 0) return undefined;
  const endpointId = instanceId.slice(0, sep);
  const row = await store.getAiSession(instanceId.slice(sep + 1));
  if (row?.scope !== endpointId) return undefined;
  const ep = await store.getEndpoint(endpointId);
  return ep && !ep.revokedAt ? row : undefined;
}

/** Flue 인스턴스 id 에서 세션 id 를 꺼낸다. 통합 대화는 그대로, PC 대화는 `<endpoint>:<세션>` 의 뒷부분 */
export function sessionIdOf(instanceId: string): string {
  return instanceId.slice(instanceId.lastIndexOf(':') + 1);
}

/** 스케줄 AI 잡 회차의 대화인지. 사람이 지켜보지 않으므로 승인이 필요한 일은 기다리지 않고 거부한다 (설계 14.3) */
export async function isUnattended(store: Store, instanceId: string): Promise<boolean> {
  return !!(await store.getAiSession(sessionIdOf(instanceId)))?.jobRunId;
}
