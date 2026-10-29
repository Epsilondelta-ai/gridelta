import { Hono } from 'hono';
import { startGateway } from './gateway/gateway.ts';
import { hub } from './hub/index.ts';
import { mountDebug } from './rpc/debug.ts';
import { mountConsole } from './rpc/console.ts';

// AgentGateway 는 Flue 서버와 별도의 HTTP/2 서버로 띄운다(설계 6.1).
// Vite 개발 모드에서 app.ts 가 다시 로드돼도 한 번만 listen 하도록 globalThis 로 막는다.
const g = globalThis as { __grideltaGateway?: unknown };
g.__grideltaGateway ??= startGateway(hub, Number(process.env.GRIDELTA_GATEWAY_PORT ?? 8443));

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
mountConsole(app, hub);
if (process.env.GRIDELTA_DEBUG === '1') mountDebug(app, hub);

export default app;
