'use agent';
import { type AgentProps, useModel, useSandbox } from '@flue/runtime';
import { FAUX_MODEL } from '../ai/faux.ts';
import { approvals } from '../ai/index.ts';
import { config } from '../config.ts';
import { hub } from '../hub/index.ts';
import { endpointIdOf, remotePc } from '../sandboxes/remote-pc.ts';
import { store } from '../store/index.ts';

/** 원격 PC 하나를 맡는 운영자 에이전트. 인스턴스 id 는 `<endpoint_id>:<대화 id>` (설계 8.1). */
export function Operator({ id }: AgentProps) {
  useModel(config.aiFaux ? FAUX_MODEL : config.aiModel, { thinkingLevel: 'medium' });
  useSandbox(remotePc({ hub, store, approvals }));

  const pc = hub.list().find((e) => e.id === endpointIdOf(id));
  const windows = pc?.os === 'windows';
  return [
    '당신은 원격 PC를 관리하는 운영자입니다.',
    '명령을 실행하기 전에 무엇을 할지 짧게 말하고, 파괴적인 작업은 꼭 필요할 때만 하십시오.',
    '위험한 명령은 사용자 승인을 거칩니다. 종료 코드 126 과 "사용자가 실행을 거부함"은 사용자가 거부했다는 뜻이니 다른 방법을 찾거나 이유를 물으십시오.',
    pc
      ? `대상 PC: ${pc.hostname} (${pc.os}/${pc.arch}), 셸 ${pc.defaultShell}, 홈 디렉터리 ${pc.homeDir}.`
      : '대상 PC 정보는 작업 공간 정보를 따르십시오.',
    windows ? 'Windows PC 입니다. powershell 도구로 PowerShell 문법을 쓰고, 경로는 /c/Users/... 형태로 다루십시오.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
