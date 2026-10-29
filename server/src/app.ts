import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Operator } from './agents/operator.ts';
import { registerFauxProvider } from './ai/faux.ts';
import { approvals } from './ai/index.ts';
import { mountAuth, requireAuth } from './auth/web.ts';
import { config } from './config.ts';
import { certFingerprint, startGateway } from './gateway/gateway.ts';
import { hub } from './hub/index.ts';
import { startAdmin } from './rpc/admin.ts';
import { endpointIdOf } from './sandboxes/remote-pc.ts';
import { mountConsole } from './rpc/console.ts';
import { mountDebug } from './rpc/debug.ts';
import { store } from './store/index.ts';

// AgentGateway(HTTP/2)와 AdminService(유닉스 소켓)는 Flue 서버와 별도로 띄운다(설계 6.1).
// Vite 개발 모드에서 app.ts 가 다시 로드돼도 한 번만 실행하도록 globalThis 로 막는다.
const g = globalThis as { __grideltaServers?: unknown };
g.__grideltaServers ??= (() => {
  const caFingerprint = config.tlsSelfSigned && config.tlsCert ? certFingerprint(config.tlsCert) : undefined;

  hub.events.on('pty-exit', (pty) => {
    void store.audit({
      actor: 'user',
      endpointId: pty.endpointId,
      kind: 'pty',
      command: `exit ${pty.id}`,
      exitCode: pty.exitCode,
    });
  });
  setInterval(() => void store.deleteExpiredSessions(), 60 * 60 * 1000).unref();
  // 재시작 전에 기다리던 AI 호출은 사라졌으므로 대기 중인 승인 요청을 만료 처리한다
  void store.expirePendingApprovals();
  if (config.aiFaux) registerFauxProvider();

  return {
    gateway: startGateway(hub, store, { port: config.gatewayPort, tlsCert: config.tlsCert, tlsKey: config.tlsKey }),
    admin: startAdmin(hub, store, config.adminSocket, { gatewayUrl: config.gatewayUrl, caFingerprint }),
  };
})();

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
mountAuth(app, store);
mountConsole(app, hub, store, approvals);

// AI 대화: Flue 라우트 (/agents/operator/:id). 로그인한 사용자만, 등록된 PC 의 대화만 연다.
// "대화 URL 에 접근할 수 있으면 누구나 대화할 수 있다" 는 Flue 의 전제 때문에 인증을 반드시 앞에 둔다
app.use('/agents/*', requireAuth(store));
app.use('/agents/operator/:id/*', async (c, next) => {
  const ep = await store.getEndpoint(endpointIdOf(c.req.param('id')));
  if (!ep || ep.revokedAt) return c.json({ error: 'unknown endpoint' }, 404);
  await next();
});
app.use('/agents/operator/:id', async (c, next) => {
  const ep = await store.getEndpoint(endpointIdOf(c.req.param('id')));
  if (!ep || ep.revokedAt) return c.json({ error: 'unknown endpoint' }, 404);
  await next();
});
app.route('/agents/operator', createAgentRouter(Operator));
if (config.debug) mountDebug(app, hub);

// 웹 UI (SPA): 파일이 있으면 그대로, 없으면 index.html
if (existsSync(config.webDir)) {
  app.use('/*', serveStatic({ root: config.webDir }));
  app.get('/*', serveStatic({ root: config.webDir, path: 'index.html' }));
}

export default app;
