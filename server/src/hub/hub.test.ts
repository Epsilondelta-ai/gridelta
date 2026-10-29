import { create } from '@bufbuild/protobuf';
import { ExecRequestSchema, HelloSchema, ResponseSchema, type ServerMessage } from '@gridelta/proto/gateway';
import { describe, expect, it } from 'vitest';
import { AgentHub, AgentRequestError, type EndpointConn, EndpointOfflineError } from './hub.ts';

const execOp = { case: 'exec' as const, value: create(ExecRequestSchema, { command: 'true' }) };

function connect(hub: AgentHub, id = 'pc1') {
  return hub.attach(create(HelloSchema, { agentId: id, os: 'linux' }));
}

async function nextMessage(conn: EndpointConn): Promise<ServerMessage> {
  const r = await conn.outbox[Symbol.asyncIterator]().next();
  if (r.done) throw new Error('outbox closed');
  return r.value;
}

async function nextRequestId(conn: EndpointConn): Promise<string> {
  const msg = await nextMessage(conn);
  if (msg.msg.case !== 'request') throw new Error(`expected request, got ${msg.msg.case}`);
  return msg.msg.value.requestId;
}

describe('AgentHub', () => {
  it('matches responses to requests by request_id', async () => {
    const hub = new AgentHub();
    const conn = connect(hub);
    const pending = hub.request('pc1', execOp);
    const requestId = await nextRequestId(conn);

    hub.resolveResponse(conn, create(ResponseSchema, { requestId, result: { case: 'exec', value: { exitCode: 3 } } }));

    const res = await pending;
    expect(res.result.case === 'exec' && res.result.value.exitCode).toBe(3);
  });

  it('rejects with AgentRequestError when the agent reports an error', async () => {
    const hub = new AgentHub();
    const conn = connect(hub);
    const pending = hub.request('pc1', execOp);
    const requestId = await nextRequestId(conn);

    hub.resolveResponse(conn, create(ResponseSchema, { requestId, error: { code: 'not_found', message: 'x' } }));

    await expect(pending).rejects.toBeInstanceOf(AgentRequestError);
  });

  it('rejects immediately with EndpointOfflineError when the PC is not connected', async () => {
    await expect(new AgentHub().request('missing', execOp)).rejects.toBeInstanceOf(EndpointOfflineError);
  });

  it('rejects pending requests with EndpointOfflineError when the connection drops', async () => {
    const hub = new AgentHub();
    const conn = connect(hub);
    const pending = hub.request('pc1', execOp);
    hub.detach(conn);
    await expect(pending).rejects.toBeInstanceOf(EndpointOfflineError);
    expect(hub.list()[0]?.online).toBe(false);
  });

  it('sends CancelRequest and rejects when the signal aborts', async () => {
    const hub = new AgentHub();
    const conn = connect(hub);
    const ac = new AbortController();
    const pending = hub.request('pc1', execOp, { signal: ac.signal });
    const requestId = await nextRequestId(conn);

    ac.abort(new Error('stop'));

    await expect(pending).rejects.toThrow('stop');
    const cancel = await nextMessage(conn);
    expect(cancel.msg.case === 'request' && cancel.msg.value.op.case).toBe('cancel');
    expect(cancel.msg.case === 'request' && cancel.msg.value.op.case === 'cancel' && cancel.msg.value.op.value.targetRequestId).toBe(requestId);
  });

  it('replaces an older connection with the same agent id', async () => {
    const hub = new AgentHub();
    const first = connect(hub);
    const pending = hub.request('pc1', execOp);
    const second = connect(hub);

    await expect(pending).rejects.toBeInstanceOf(EndpointOfflineError);
    expect(first.outbox.closed).toBe(true);
    expect(hub.get('pc1')).toBe(second);
    expect(hub.list()[0]?.online).toBe(true);
  });
});
