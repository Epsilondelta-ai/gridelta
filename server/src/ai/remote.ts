import { create } from '@bufbuild/protobuf';
import type { ShellResult } from '@flue/runtime';
import { ExecRequestSchema, FsReadRequestSchema, FsWriteRequestSchema } from '@gridelta/proto/gateway';
import type { AgentHub, RequestOpts } from '../hub/index.ts';
import type { ApprovalPolicy, Store } from '../store/index.ts';
import type { ApprovalCenter } from './approvals.ts';
import { needsApproval } from './policy.ts';

/** 거부된 명령의 종료 코드. 모델이 이유를 알고 다른 방법을 찾게 결과로 돌려준다 (설계 8.5) */
export const DENIED_EXIT_CODE = 126;
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export interface RemoteDeps {
  hub: AgentHub;
  store: Store;
  approvals: ApprovalCenter;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 승인 요청에 남길 AI 대화 (Flue 인스턴스 id) */
  requestedBy: string;
}

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/**
 * AI 가 원격 PC 에서 명령을 실행하는 단일 관문. PC 별 승인 정책을 확인하고, 필요하면 사람의 승인을 기다린 뒤
 * 실행하며, 결과를 감사 로그(actor=ai)에 남긴다. PC 대화의 샌드박스와 통합 대화의 도구가 함께 쓴다.
 * request 는 hub.request 를 감싼 함수로, 호출자가 오프라인 에러를 자기 방식으로 바꿀 수 있게 받는다.
 */
export async function execWithApproval(
  deps: RemoteDeps,
  endpointId: string,
  command: string,
  o: ExecOptions,
  request: AgentHub['request'] = deps.hub.request.bind(deps.hub),
): Promise<ShellResult> {
  const { store, approvals } = deps;
  const ep = await store.getEndpoint(endpointId);
  const policy = (ep?.approvalPolicy ?? 'dangerous') as ApprovalPolicy;
  let approvalId: string | null = null;
  if (needsApproval(policy, command)) {
    const approval = await approvals.request({ endpointId, command, requestedBy: o.requestedBy }, o.signal);
    approvalId = approval.id;
    if (approval.decision !== 'approved') {
      o.signal?.throwIfAborted();
      const result: ShellResult = {
        stdout: '',
        stderr: approval.decision === 'expired' ? '승인 대기 시간이 지나 실행하지 않음' : '사용자가 실행을 거부함',
        exitCode: DENIED_EXIT_CODE,
      };
      await store.audit({ actor: 'ai', endpointId, kind: 'exec', command, exitCode: result.exitCode, approvalId });
      return result;
    }
  }

  const timeoutMs = o.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const opts: RequestOpts = { timeoutMs: timeoutMs + 15_000, signal: o.signal }; // 에이전트가 timeout 에서 124 로 끝낸다
  const res = await request(
    endpointId,
    { case: 'exec', value: create(ExecRequestSchema, { command, cwd: o.cwd ?? '', env: o.env ?? {}, timeoutMs }) },
    opts,
  );
  if (res.result.case !== 'exec') throw new Error('unexpected exec response');
  const r = res.result.value;
  const stdout = utf8.decode(r.stdout) + (r.truncated ? '\n[출력이 너무 길어 잘렸습니다]' : '');
  await store.audit({ actor: 'ai', endpointId, kind: 'exec', command, exitCode: r.exitCode, approvalId });
  return { stdout, stderr: utf8.decode(r.stderr), exitCode: r.exitCode };
}

export async function readRemoteFile(
  deps: RemoteDeps,
  endpointId: string,
  path: string,
  request: AgentHub['request'] = deps.hub.request.bind(deps.hub),
): Promise<Uint8Array> {
  const res = await request(endpointId, { case: 'fsRead', value: create(FsReadRequestSchema, { path }) });
  return res.result.case === 'fsRead' ? res.result.value.data : new Uint8Array();
}

export async function writeRemoteFile(
  deps: RemoteDeps,
  endpointId: string,
  path: string,
  content: string | Uint8Array,
  request: AgentHub['request'] = deps.hub.request.bind(deps.hub),
): Promise<void> {
  const data = typeof content === 'string' ? encoder.encode(content) : content;
  await request(endpointId, { case: 'fsWrite', value: create(FsWriteRequestSchema, { path, data }) });
  await deps.store.audit({ actor: 'ai', endpointId, kind: 'fs', command: `write ${path} (${data.length} bytes)` });
}
