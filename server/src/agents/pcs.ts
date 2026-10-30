import type { AgentHub } from '../hub/index.ts';
import type { Store } from '../store/index.ts';

export interface PcInfo {
  id: string;
  name: string;
  group: string;
  hostname: string;
  os: string;
  arch: string;
  online: boolean;
  shell: string;
  home: string;
}

/** AI 도구에 보일 PC 목록 (폐기된 PC 제외) */
export async function listPcs(store: Store, hub: AgentHub): Promise<PcInfo[]> {
  const groupNames = new Map((await store.listGroups()).map((g) => [g.id, g.name]));
  return (await store.listEndpoints())
    .filter((e) => !e.revokedAt)
    .map((e) => ({
      id: e.id,
      name: e.displayName || e.hostname,
      group: groupNames.get(e.groupId) ?? e.groupId,
      hostname: e.hostname,
      os: e.os,
      arch: e.arch,
      online: hub.get(e.id) !== undefined,
      shell: e.defaultShell,
      home: e.homeDir,
    }));
}

/** 모델이 PC 를 id, 이름, 호스트 이름 중 무엇으로 불러도 하나로 정해지면 찾는다 */
export async function resolvePc(store: Store, hub: AgentHub, ref: string): Promise<PcInfo> {
  const pcs = await listPcs(store, hub);
  const key = ref.trim().toLowerCase();
  const exact = pcs.filter((p) => p.id === ref || p.name.toLowerCase() === key || p.hostname.toLowerCase() === key);
  if (exact.length === 1) return exact[0]!;
  const names = pcs.map((p) => `${p.name} (${p.id})`).join(', ');
  throw new Error(exact.length > 1 ? `"${ref}" 에 해당하는 PC 가 여럿입니다. id 로 지정하세요: ${names}` : `"${ref}" PC 를 찾지 못했습니다. 있는 PC: ${names}`);
}
