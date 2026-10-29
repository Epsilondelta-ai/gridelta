import { create } from '@bufbuild/protobuf';
import { type ConnectRouter, createConnectRouter } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { ConsoleService, type Endpoint, type EndpointEvent, EndpointEventSchema, EndpointSchema } from '@gridelta/proto/console';
import type { Hono } from 'hono';
import { AsyncQueue } from '../hub/async-queue.ts';
import type { AgentHub, EndpointInfo } from '../hub/index.ts';

export const RPC_PREFIX = '/rpc';

function toEndpoint(info: EndpointInfo): Endpoint {
  return create(EndpointSchema, {
    id: info.id,
    hostname: info.hostname,
    os: info.os,
    arch: info.arch,
    homeDir: info.homeDir,
    defaultShell: info.defaultShell,
    agentVersion: info.agentVersion,
    online: info.online,
    lastSeenMs: BigInt(info.lastSeen.getTime()),
  });
}

export function consoleRoutes(hub: AgentHub) {
  return (router: ConnectRouter) => {
    router.service(ConsoleService, {
      listEndpoints() {
        return { endpoints: hub.list().map(toEndpoint) };
      },

      async *watchEndpoints(_req, ctx): AsyncIterable<EndpointEvent> {
        const queue = new AsyncQueue<EndpointInfo>();
        const onChange = (info: EndpointInfo) => queue.push(info);
        hub.events.on('online', onChange);
        hub.events.on('offline', onChange);
        ctx.signal.addEventListener('abort', () => queue.close());
        try {
          for (const info of hub.list()) yield create(EndpointEventSchema, { endpoint: toEndpoint(info) });
          for await (const info of queue) yield create(EndpointEventSchema, { endpoint: toEndpoint(info) });
        } finally {
          hub.events.off('online', onChange);
          hub.events.off('offline', onChange);
        }
      },
    });
  };
}

/**
 * ConsoleService 를 Flue 의 Hono 앱에 마운트한다.
 * Flue 빌드 서버는 교체할 수 없으므로 Connect 를 fetch 핸들러로 바꿔 Hono 라우트로 붙인다.
 */
export function mountConsole(app: Hono, hub: AgentHub): void {
  const router = createConnectRouter();
  consoleRoutes(hub)(router);
  for (const handler of router.handlers) {
    const fetchHandler = createFetchHandler(handler);
    app.post(RPC_PREFIX + handler.requestPath, (c) => fetchHandler(c.req.raw));
  }
}
