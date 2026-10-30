import { resolve } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { ResponseSchema } from '@gridelta/proto/gateway';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentHub } from '../hub/index.ts';
import { openDb } from '../store/db.ts';
import { Store } from '../store/store.ts';
import { ApprovalCenter } from './approvals.ts';
import { DENIED_EXIT_CODE, execWithApproval, UNATTENDED_DENIED } from './remote.ts';

describe('execWithApproval', () => {
  let store: Store;
  let approvals: ApprovalCenter;
  let ran: string[];
  const hub = {
    request: async (_id: string, op: { value: { command: string } }) => {
      ran.push(op.value.command);
      return create(ResponseSchema, { result: { case: 'exec', value: { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() } } });
    },
  } as unknown as AgentHub;

  beforeEach(() => {
    store = new Store(openDb(':memory:', resolve(import.meta.dirname, '../../drizzle')));
    approvals = new ApprovalCenter(store);
    ran = [];
  });

  it('refuses commands that need approval in a scheduled AI session, without asking', async () => {
    const ep = await store.enrollEndpoint({ hostname: 'a', os: 'linux', arch: 'arm64' });
    const s = await store.createAiSession(ep.id, { jobRunId: 'run-1' });
    const deps = { hub, store, approvals };
    const r = await execWithApproval(deps, ep.id, 'rm -rf /tmp/x', { requestedBy: `${ep.id}:${s.id}` });
    expect(r).toEqual({ stdout: '', stderr: UNATTENDED_DENIED, exitCode: DENIED_EXIT_CODE });
    expect(approvals.pending()).toEqual([]);
    expect(ran).toEqual([]);

    // 승인이 필요 없는 명령은 그대로 실행한다
    expect((await execWithApproval(deps, ep.id, 'uname -r', { requestedBy: `${ep.id}:${s.id}` })).exitCode).toBe(0);
    expect(ran).toEqual(['uname -r']);
  });
});
