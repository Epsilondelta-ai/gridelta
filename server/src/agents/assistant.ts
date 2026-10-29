'use agent';
import { type AgentProps, defineTool, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { aiModels, approvals } from '../ai/index.ts';
import { execWithApproval, readRemoteFile, writeRemoteFile } from '../ai/remote.ts';
import { hub } from '../hub/index.ts';
import { store } from '../store/index.ts';

const deps = { hub, store, approvals };
const utf8 = new TextDecoder();

interface PcInfo {
  id: string;
  name: string;
  hostname: string;
  os: string;
  arch: string;
  online: boolean;
  shell: string;
  home: string;
}

async function listPcs(): Promise<PcInfo[]> {
  return (await store.listEndpoints())
    .filter((e) => !e.revokedAt)
    .map((e) => ({
      id: e.id,
      name: e.displayName || e.hostname,
      hostname: e.hostname,
      os: e.os,
      arch: e.arch,
      online: hub.get(e.id) !== undefined,
      shell: e.defaultShell,
      home: e.homeDir,
    }));
}

/** 모델이 PC 를 id, 이름, 호스트 이름 중 무엇으로 불러도 하나로 정해지면 찾는다 */
async function resolvePc(ref: string): Promise<PcInfo> {
  const pcs = await listPcs();
  const key = ref.trim().toLowerCase();
  const exact = pcs.filter((p) => p.id === ref || p.name.toLowerCase() === key || p.hostname.toLowerCase() === key);
  if (exact.length === 1) return exact[0]!;
  const names = pcs.map((p) => `${p.name} (${p.id})`).join(', ');
  throw new Error(exact.length > 1 ? `"${ref}" 에 해당하는 PC 가 여럿입니다. id 로 지정하세요: ${names}` : `"${ref}" PC 를 찾지 못했습니다. 있는 PC: ${names}`);
}

const pcParam = v.pipe(v.string(), v.description('대상 PC 의 id, 이름 또는 호스트 이름 (list_pcs 결과 참고)'));

/**
 * 여러 PC 를 다루는 통합 대화 에이전트. 샌드박스 없이(= 서버 자체의 셸·파일 도구 없음) 아래 도구만 쓴다.
 * 명령 실행은 PC 대화와 같은 승인 관문(execWithApproval)을 거친다.
 */
export function Assistant({ id }: AgentProps) {
  useModel(aiModels.current(), { thinkingLevel: 'medium' });

  useTool(
    defineTool({
      name: 'list_pcs',
      description: '관리 중인 PC 목록(id, 이름, OS, 온라인 여부, 셸, 홈 디렉터리)을 돌려준다.',
      run: async () => JSON.stringify(await listPcs(), null, 2),
    }),
  );

  useTool(
    defineTool({
      name: 'run_command',
      description:
        '지정한 PC 에서 셸 명령을 실행하고 stdout/stderr/종료 코드를 돌려준다. Windows PC 는 PowerShell 문법을 쓴다. 위험한 명령은 사용자 승인을 기다리며, 거부되면 종료 코드 126 이다.',
      input: v.object({
        pc: pcParam,
        command: v.string(),
        cwd: v.optional(v.pipe(v.string(), v.description('POSIX 형식 작업 디렉터리 (Windows: /c/Users/...)'))),
        timeout_seconds: v.optional(v.number()),
      }),
      run: async ({ data, signal }) => {
        const pc = await resolvePc(data.pc);
        if (!pc.online) return `${pc.name} 는 오프라인입니다.`;
        const r = await execWithApproval(deps, pc.id, data.command, {
          cwd: data.cwd,
          timeoutMs: data.timeout_seconds ? data.timeout_seconds * 1000 : undefined,
          signal,
          requestedBy: id,
        });
        return [`[${pc.name}] exit code ${r.exitCode}`, r.stdout && `stdout:\n${r.stdout}`, r.stderr && `stderr:\n${r.stderr}`]
          .filter(Boolean)
          .join('\n');
      },
    }),
  );

  useTool(
    defineTool({
      name: 'read_file',
      description: '지정한 PC 의 텍스트 파일을 읽는다 (최대 3 MiB). 경로는 POSIX 형식 (Windows: /c/...).',
      input: v.object({ pc: pcParam, path: v.string() }),
      run: async ({ data }) => {
        const pc = await resolvePc(data.pc);
        return utf8.decode(await readRemoteFile(deps, pc.id, data.path));
      },
    }),
  );

  useTool(
    defineTool({
      name: 'write_file',
      description: '지정한 PC 에 파일을 쓴다 (덮어씀). 경로는 POSIX 형식 (Windows: /c/...).',
      input: v.object({ pc: pcParam, path: v.string(), content: v.string() }),
      run: async ({ data }) => {
        const pc = await resolvePc(data.pc);
        await writeRemoteFile(deps, pc.id, data.path, data.content);
        return `[${pc.name}] ${data.path} 에 썼습니다.`;
      },
    }),
  );

  return [
    '당신은 여러 원격 PC 를 함께 관리하는 운영자입니다.',
    '어떤 PC 가 있는지 모르면 먼저 list_pcs 를 호출하고, 명령마다 대상 PC 를 정확히 지정하십시오.',
    '명령을 실행하기 전에 무엇을 할지 짧게 말하고, 파괴적인 작업은 꼭 필요할 때만 하십시오.',
    '위험한 명령은 사용자 승인을 거칩니다. 종료 코드 126 과 "사용자가 실행을 거부함"은 사용자가 거부했다는 뜻입니다.',
    'Windows PC 에서는 PowerShell 문법을 쓰고, 경로는 /c/Users/... 형태로 다루십시오.',
  ].join('\n');
}
