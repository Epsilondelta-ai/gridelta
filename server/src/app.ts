import { Hono } from 'hono';
import { config } from './config.ts';
import { certFingerprint, startGateway } from './gateway/gateway.ts';
import { hub } from './hub/index.ts';
import { startAdmin } from './rpc/admin.ts';
import { mountConsole } from './rpc/console.ts';
import { mountDebug } from './rpc/debug.ts';
import { store } from './store/index.ts';

// AgentGateway(HTTP/2)와 AdminService(유닉스 소켓)는 Flue 서버와 별도로 띄운다(설계 6.1).
// Vite 개발 모드에서 app.ts 가 다시 로드돼도 한 번만 listen 하도록 globalThis 로 막는다.
const g = globalThis as { __grideltaServers?: unknown };
g.__grideltaServers ??= (() => {
  const caFingerprint = config.tlsSelfSigned && config.tlsCert ? certFingerprint(config.tlsCert) : undefined;
  return {
    gateway: startGateway(hub, store, { port: config.gatewayPort, tlsCert: config.tlsCert, tlsKey: config.tlsKey }),
    admin: startAdmin(hub, store, config.adminSocket, { gatewayUrl: config.gatewayUrl, caFingerprint }),
  };
})();

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
mountConsole(app, hub, store);
if (config.debug) mountDebug(app, hub);

export default app;
