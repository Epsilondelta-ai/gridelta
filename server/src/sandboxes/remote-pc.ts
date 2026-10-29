import { create } from '@bufbuild/protobuf';
import {
  createBashTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
  type FileStat,
  type Sandbox,
  type SandboxDriver,
  type SandboxFactory,
  SandboxDiedError,
  SandboxOperationUnsupportedError,
  type ShellResult,
  sandboxFromDriver,
} from '@flue/runtime';
import {
  ExecRequestSchema,
  FsMkdirRequestSchema,
  FsReadRequestSchema,
  FsReaddirRequestSchema,
  FsRmRequestSchema,
  FsStatRequestSchema,
  FsWriteRequestSchema,
  type Response,
} from '@gridelta/proto/gateway';
import type { ApprovalCenter } from '../ai/approvals.ts';
import { needsApproval } from '../ai/policy.ts';
import { AgentRequestError, type AgentHub, EndpointOfflineError, type RequestOp, type RequestOpts } from '../hub/index.ts';
import type { ApprovalPolicy, Store } from '../store/index.ts';

/** 거부된 명령의 종료 코드. 모델이 이유를 알고 다른 방법을 찾게 결과로 돌려준다 (설계 8.5) */
export const DENIED_EXIT_CODE = 126;
const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

export interface RemotePcDeps {
  hub: AgentHub;
  store: Store;
  approvals: ApprovalCenter;
}

/** Flue 인스턴스 id 는 `<endpoint_id>:<대화 id>` 형식이다 (설계 8.1). */
export function endpointIdOf(instanceId: string): string {
  return instanceId.split(':')[0] ?? '';
}

/** Windows PC 의 샌드박스 cwd 는 /c/... 형태다. */
export function isWindowsCwd(cwd: string): boolean {
  return /^\/[a-z](\/|$)/.test(cwd);
}

const utf8 = new TextDecoder();
const encoder = new TextEncoder();

/** 원격 PC 를 Flue 샌드박스로 연결한다. Flue 기본 도구(read/write/edit/bash/grep/glob)가 원격 PC 에서 동작한다. */
export function remotePc(deps: RemotePcDeps): SandboxFactory {
  const { hub, store, approvals } = deps;
  return {
    async createSandbox({ id }) {
      const endpointId = endpointIdOf(id);
      // 마지막 Hello 기준 정보. PC 가 오프라인이어도 있으므로 대화 기록은 열리고, 원격 호출만 실패한다
      const ep = await store.getEndpoint(endpointId);
      if (!ep || ep.revokedAt) throw new Error(`등록되지 않았거나 폐기된 PC입니다: ${endpointId}`);

      // AgentHub 의 오프라인 에러를 Flue 의 SandboxDiedError 로 바꾼다 (설계 6.2)
      const call = (operation: string, op: RequestOp, opts?: RequestOpts): Promise<Response> =>
        hub.request(endpointId, op, opts).catch((err: unknown) => {
          if (err instanceof EndpointOfflineError) throw new SandboxDiedError({ operation, reason: 'stopped' });
          throw err;
        });

      const driver: SandboxDriver = {
        async exec(command, o) {
          const ep = await store.getEndpoint(endpointId);
          const policy = (ep?.approvalPolicy ?? 'dangerous') as ApprovalPolicy;
          let approvalId: string | null = null;
          if (needsApproval(policy, command)) {
            const approval = await approvals.request({ endpointId, command, requestedBy: id }, o?.signal);
            approvalId = approval.id;
            const decision = approval.decision;
            if (decision !== 'approved') {
              o?.signal?.throwIfAborted();
              const result: ShellResult = {
                stdout: '',
                stderr: decision === 'expired' ? '승인 대기 시간이 지나 실행하지 않음' : '사용자가 실행을 거부함',
                exitCode: DENIED_EXIT_CODE,
              };
              await store.audit({ actor: 'ai', endpointId, kind: 'exec', command, exitCode: result.exitCode, approvalId });
              return result;
            }
          }

          const timeoutMs = o?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
          const res = await call(
            'exec',
            {
              case: 'exec',
              value: create(ExecRequestSchema, { command, cwd: o?.cwd ?? '', env: o?.env ?? {}, timeoutMs }),
            },
            // 에이전트가 timeout 에서 124 로 끝내므로 응답 대기는 조금 더 길게 둔다
            { timeoutMs: timeoutMs + 15_000, signal: o?.signal },
          );
          if (res.result.case !== 'exec') throw new Error('unexpected exec response');
          const r = res.result.value;
          const stdout = utf8.decode(r.stdout) + (r.truncated ? '\n[출력이 너무 길어 잘렸습니다]' : '');
          await store.audit({ actor: 'ai', endpointId, kind: 'exec', command, exitCode: r.exitCode, approvalId });
          return { stdout, stderr: utf8.decode(r.stderr), exitCode: r.exitCode };
        },

        async readFile(path) {
          return utf8.decode(await this.readFileBuffer(path));
        },
        async readFileBuffer(path) {
          const res = await call('readFile', { case: 'fsRead', value: create(FsReadRequestSchema, { path }) });
          return res.result.case === 'fsRead' ? res.result.value.data : new Uint8Array();
        },
        async writeFile(path, content) {
          const data = typeof content === 'string' ? encoder.encode(content) : content;
          await call('writeFile', { case: 'fsWrite', value: create(FsWriteRequestSchema, { path, data }) });
          await store.audit({ actor: 'ai', endpointId, kind: 'fs', command: `write ${path} (${data.length} bytes)` });
        },
        async stat(path): Promise<FileStat> {
          const res = await call('stat', { case: 'fsStat', value: create(FsStatRequestSchema, { path }) });
          if (res.result.case !== 'fsStat') throw new Error('unexpected stat response');
          const s = res.result.value;
          // 모르는 값은 채우지 않는다
          return {
            isFile: !s.isDir,
            isDirectory: s.isDir,
            isSymbolicLink: s.isSymlink,
            ...(s.size !== undefined && { size: Number(s.size) }),
            ...(s.mtimeMs !== undefined && { mtime: new Date(Number(s.mtimeMs)) }),
          };
        },
        async readdir(path) {
          const res = await call('readdir', { case: 'fsReaddir', value: create(FsReaddirRequestSchema, { path }) });
          return res.result.case === 'fsReaddir' ? res.result.value.names : [];
        },
        async exists(path) {
          try {
            await call('exists', { case: 'fsStat', value: create(FsStatRequestSchema, { path }) });
            return true;
          } catch (err) {
            // 파일 부재·권한 문제는 false. 연결이 끊긴 것은 "없음"과 다르므로 그대로 던진다
            if (err instanceof SandboxDiedError) throw err;
            return false;
          }
        },
        async mkdir(path, o) {
          await call('mkdir', { case: 'fsMkdir', value: create(FsMkdirRequestSchema, { path, recursive: !!o?.recursive }) });
        },
        async rm(path, o) {
          try {
            await call('rm', {
              case: 'fsRm',
              value: create(FsRmRequestSchema, { path, recursive: !!o?.recursive, force: !!o?.force }),
            });
          } catch (err) {
            if (err instanceof AgentRequestError && err.code === 'unsupported') {
              throw new SandboxOperationUnsupportedError({
                operation: 'rm',
                provider: 'gridelta',
                options: Object.keys(o ?? {}).filter((k) => o?.[k as keyof typeof o]),
              });
            }
            throw err;
          }
          await store.audit({ actor: 'ai', endpointId, kind: 'fs', command: `rm ${o?.recursive ? '-r ' : ''}${path}` });
        },
      };
      return sandboxFromDriver(driver, ep.homeDir || '/');
    },

    // tools 는 sandbox 를 받으므로 cwd 형태(/c/...)로 Windows 여부를 판별한다 (설계 8.4)
    tools: (sandbox) => (isWindowsCwd(sandbox.cwd) ? windowsTools(sandbox) : defaultTools(sandbox)),
  };
}

function defaultTools(sandbox: Sandbox) {
  return [
    createReadTool(sandbox),
    createWriteTool(sandbox),
    createEditTool(sandbox),
    createBashTool(sandbox),
    createGrepTool(sandbox),
    createGlobTool(sandbox),
  ];
}

/** Windows: bash·grep·glob 대신 PowerShell 도구 하나. 실행은 bash 도구와 같이 sandbox.exec 를 쓴다. */
function windowsTools(sandbox: Sandbox) {
  const bash = createBashTool(sandbox);
  return [
    createReadTool(sandbox),
    createWriteTool(sandbox),
    createEditTool(sandbox),
    {
      ...bash,
      name: 'powershell',
      label: 'PowerShell',
      description:
        'Run a PowerShell command on the remote Windows PC and return stdout/stderr. Use PowerShell syntax (Get-ChildItem, Select-String, etc.), not bash.',
    },
  ];
}
