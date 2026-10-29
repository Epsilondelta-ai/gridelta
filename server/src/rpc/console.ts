import { create } from '@bufbuild/protobuf';
import { type ConnectRouter, createConnectRouter } from '@connectrpc/connect';
import { createFetchHandler } from '@connectrpc/connect/protocol';
import { ConsoleService, type EndpointEvent, EndpointEventSchema, EndpointSchema } from '@gridelta/proto/console';
import type { Hono } from 'hono';
import { AsyncQueue } from '../hub/async-queue.ts';
import type { AgentHub, EndpointInfo } from '../hub/index.ts';
import type { Store } from '../store/index.ts';
import { endpointsView } from './endpoints-view.ts';

export const RPC_PREFIX = '/rpc';

export function consoleRoutes(hub: AgentHub, store: Store) {
  const view = endpointsView(hub, store);
  return (router: ConnectRouter) => {
    router.service(ConsoleService, {
      async listEndpoints() {
        return { endpoints: await view.list() };
      },

      async *watchEndpoints(_req, ctx): AsyncIterable<EndpointEvent> {
        const queue = new AsyncQueue<string>();
        const onChange = (info: EndpointInfo) => queue.push(info.id);
        hub.events.on('online', onChange);
        hub.events.on('offline', onChange);
        ctx.signal.addEventListener('abort', () => queue.close());
        try {
          for (const endpoint of await view.list()) yield create(EndpointEventSchema, { endpoint });
          for await (const id of queue) {
            // 폐기된 PC 는 목록에서 빠지므로 id 와 오프라인 상태만 알린다
            const endpoint = (await view.get(id)) ?? create(EndpointSchema, { id, online: false });
            yield create(EndpointEventSchema, { endpoint });
          }
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
export function mountConsole(app: Hono, hub: AgentHub, store: Store): void {
  const router = createConnectRouter();
  consoleRoutes(hub, store)(router);
  for (const handler of router.handlers) {
    const fetchHandler = createFetchHandler(handler);
    app.post(RPC_PREFIX + handler.requestPath, (c) => fetchHandler(c.req.raw));
  }
}
