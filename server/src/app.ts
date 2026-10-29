import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { mountAuth } from './auth/web.ts';
import { config } from './config.ts';
import { certFingerprint, startGateway } from './gateway/gateway.ts';
import { hub } from './hub/index.ts';
import { startAdmin } from './rpc/admin.ts';
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

  return {
    gateway: startGateway(hub, store, { port: config.gatewayPort, tlsCert: config.tlsCert, tlsKey: config.tlsKey }),
    admin: startAdmin(hub, store, config.adminSocket, { gatewayUrl: config.gatewayUrl, caFingerprint }),
  };
})();

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
mountAuth(app, store);
mountConsole(app, hub, store);
if (config.debug) mountDebug(app, hub);

// 웹 UI (SPA): 파일이 있으면 그대로, 없으면 index.html
if (existsSync(config.webDir)) {
  app.use('/*', serveStatic({ root: config.webDir }));
  app.get('/*', serveStatic({ root: config.webDir, path: 'index.html' }));
}

export default app;
