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
