import { create } from '@bufbuild/protobuf';
import { type Endpoint, EndpointSchema } from '@gridelta/proto/console';
import type { AgentHub } from '../hub/index.ts';
import type { EndpointRow, Store } from '../store/index.ts';

/** DB 의 등록 정보와 AgentHub 의 온라인 상태를 합쳐 Endpoint 메시지로 만든다. 폐기된 PC 는 뺀다. */
export function endpointsView(hub: AgentHub, store: Store) {
  const toEndpoint = (row: EndpointRow): Endpoint =>
    create(EndpointSchema, {
      id: row.id,
      hostname: row.hostname,
      os: row.os,
      arch: row.arch,
      homeDir: row.homeDir,
      defaultShell: row.defaultShell,
      agentVersion: row.agentVersion,
      online: hub.get(row.id) !== undefined,
      lastSeenMs: BigInt(row.lastSeen?.getTime() ?? 0),
      approvalPolicy: row.approvalPolicy,
      displayName: row.displayName,
      groupId: row.groupId,
    });

  return {
    async list(): Promise<Endpoint[]> {
      return (await store.listEndpoints()).filter((row) => !row.revokedAt).map(toEndpoint);
    },
    async get(id: string): Promise<Endpoint | undefined> {
      const row = await store.getEndpoint(id);
      return row && !row.revokedAt ? toEndpoint(row) : undefined;
    },
  };
}
