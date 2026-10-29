import { create } from '@bufbuild/protobuf';
import { ExecRequestSchema } from '@gridelta/proto/gateway';
import type { Hono } from 'hono';
import { AgentRequestError, type AgentHub, EndpointOfflineError } from '../hub/index.ts';

/**
 * M1 임시 디버그 라우트. GRIDELTA_DEBUG=1 일 때만 마운트한다.
 * 인증이 없으므로 운영 환경에서 켜면 안 된다.
 */
export function mountDebug(app: Hono, hub: AgentHub): void {
  app.post('/_debug/exec', async (c) => {
    const body = await c.req.json<{ endpointId: string; command: string; timeoutMs?: number }>();
    try {
      const res = await hub.request(
        body.endpointId,
        { case: 'exec', value: create(ExecRequestSchema, { command: body.command, timeoutMs: body.timeoutMs ?? 0 }) },
        { timeoutMs: (body.timeoutMs ?? 30_000) + 5_000 },
      );
      if (res.result.case !== 'exec') return c.json({ error: 'unexpected response' }, 500);
      const r = res.result.value;
      const decoder = new TextDecoder();
      return c.json({
        exitCode: r.exitCode,
        stdout: decoder.decode(r.stdout),
        stderr: decoder.decode(r.stderr),
        truncated: r.truncated,
      });
    } catch (err) {
      if (err instanceof EndpointOfflineError) return c.json({ error: err.message }, 404);
      if (err instanceof AgentRequestError) return c.json({ error: err.message, code: err.code }, 502);
      return c.json({ error: String(err) }, 500);
    }
  });
}
