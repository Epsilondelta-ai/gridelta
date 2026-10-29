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
  sandboxFromDriver,
} from '@flue/runtime';
import {
  FsMkdirRequestSchema,
  FsReaddirRequestSchema,
  FsRmRequestSchema,
  FsStatRequestSchema,
  type Response,
} from '@gridelta/proto/gateway';
import { execWithApproval, readRemoteFile, type RemoteDeps, writeRemoteFile } from '../ai/remote.ts';
import { AgentRequestError, type AgentHub, EndpointOfflineError, type RequestOp, type RequestOpts } from '../hub/index.ts';

export type RemotePcDeps = RemoteDeps;

/** Flue 인스턴스 id 는 `<endpoint_id>:<대화 id>` 형식이다 (설계 8.1). */
export function endpointIdOf(instanceId: string): string {
  return instanceId.split(':')[0] ?? '';
}

/** Windows PC 의 샌드박스 cwd 는 /c/... 형태다. */
export function isWindowsCwd(cwd: string): boolean {
  return /^\/[a-z](\/|$)/.test(cwd);
}

const utf8 = new TextDecoder();

/** 원격 PC 를 Flue 샌드박스로 연결한다. Flue 기본 도구(read/write/edit/bash/grep/glob)가 원격 PC 에서 동작한다. */
export function remotePc(deps: RemotePcDeps): SandboxFactory {
  const { hub, store } = deps;
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
        exec: (command, o) =>
          execWithApproval(deps, endpointId, command, { ...o, requestedBy: id }, (ep, op, opts) =>
            call('exec', op, opts),
          ),

        async readFile(path) {
          return utf8.decode(await this.readFileBuffer(path));
        },
        readFileBuffer: (path) => readRemoteFile(deps, endpointId, path, (ep, op, opts) => call('readFile', op, opts)),
        writeFile: (path, content) =>
          writeRemoteFile(deps, endpointId, path, content, (ep, op, opts) => call('writeFile', op, opts)),
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
