import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type ConnectRouter,
  createConnectRouter,
  createContextKey,
  createContextValues,
} from '@connectrpc/connect';
import { universalServerRequestFromFetch, universalServerResponseToFetch } from '@connectrpc/connect/protocol';
import {
  type AiSession,
  AiSessionSchema,
  type Approval,
  type ApprovalEvent,
  ApprovalEventSchema,
  ApprovalSchema,
  ConsoleService,
  type EndpointEvent,
  EndpointEventSchema,
  EndpointSchema,
  type Terminal,
  type TerminalOutput,
  TerminalOutputSchema,
  TerminalSchema,
} from '@gridelta/proto/console';
import type { Context, Hono } from 'hono';
import { type AuthEnv, requireAuth } from '../auth/web.ts';
import { AsyncQueue } from '../hub/async-queue.ts';
import {
  AgentRequestError,
  type AgentHub,
  EndpointOfflineError,
  PtyNotFoundError,
  RequestTimeoutError,
} from '../hub/index.ts';
import type { PtySession } from '../hub/pty.ts';
import type { ApprovalCenter } from '../ai/approvals.ts';
import { type AiModels, UnknownModelError } from '../ai/models.ts';
import { agentUrl } from '../ai/sessions.ts';
import {
  ALL_PCS,
  type AiSessionRow,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalRow,
  type SessionUser,
  type Store,
} from '../store/index.ts';
import { endpointsView } from './endpoints-view.ts';

export const RPC_PREFIX = '/rpc';
const MAX_NAME_LENGTH = 64;

/** 앞뒤 공백을 지우고 길이를 확인한다. 빈 문자열은 기본 이름으로 되돌린다는 뜻이다 */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if ([...trimmed].length > MAX_NAME_LENGTH) {
    throw new ConnectError(`name must be at most ${MAX_NAME_LENGTH} characters`, Code.InvalidArgument);
  }
  return trimmed;
}

const kUser = createContextKey<SessionUser | undefined>(undefined, { description: 'logged-in user' });

/** AgentHub 의 에러를 Connect 코드로 바꾼다. */
function toConnectError(err: unknown): unknown {
  if (err instanceof EndpointOfflineError) return new ConnectError(err.message, Code.Unavailable);
  if (err instanceof PtyNotFoundError) return new ConnectError(err.message, Code.NotFound);
  if (err instanceof RequestTimeoutError) return new ConnectError(err.message, Code.DeadlineExceeded);
  if (err instanceof AgentRequestError) return new ConnectError(err.message, Code.Internal);
  return err;
}

async function mapErrors<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toConnectError(err);
  }
}

function toAiSession(row: AiSessionRow): AiSession {
  return create(AiSessionSchema, {
    id: row.id,
    scope: row.scope,
    title: row.title,
    createdAtMs: BigInt(row.createdAt.getTime()),
    updatedAtMs: BigInt(row.updatedAt.getTime()),
    agentUrl: agentUrl(row),
  });
}

function toTerminal(pty: PtySession): Terminal {
  return create(TerminalSchema, {
    sessionId: pty.id,
    endpointId: pty.endpointId,
    createdAtMs: BigInt(pty.createdAt.getTime()),
    exited: pty.exited,
    title: pty.title,
  });
}

export function consoleRoutes(hub: AgentHub, store: Store, approvals: ApprovalCenter, aiModels: AiModels) {
  const view = endpointsView(hub, store);
  const names = new Map<string, string>(); // 승인 카드에 보여 줄 PC 이름 (WatchApprovals 시작 때 채움)
  const toApproval = (row: ApprovalRow): Approval =>
    create(ApprovalSchema, {
      id: row.id,
      endpointId: row.endpointId,
      hostname: names.get(row.endpointId) || hub.list().find((e) => e.id === row.endpointId)?.hostname || '',
      command: row.command,
      status: row.status,
      createdAtMs: BigInt(row.createdAt.getTime()),
      conversationId: row.requestedBy,
    });
  return (router: ConnectRouter) => {
    router.service(ConsoleService, {
      async listEndpoints() {
        return { endpoints: await view.list() };
      },

      async *watchEndpoints(_req, ctx): AsyncIterable<EndpointEvent> {
        const queue = new AsyncQueue<string>();
        const onChange = (info: { id: string }) => queue.push(info.id);
        hub.events.on('online', onChange);
        hub.events.on('offline', onChange);
        hub.events.on('changed', onChange);
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
          hub.events.off('changed', onChange);
        }
      },

      async openTerminal(req, ctx) {
        if (!(await view.get(req.endpointId))) {
          throw new ConnectError(`endpoint ${req.endpointId} not found`, Code.NotFound);
        }
        const pty = await mapErrors(() => hub.openPty(req.endpointId, req.cols || 80, req.rows || 24));
        await store.audit({
          actor: 'user',
          userId: ctx.values.get(kUser)?.id || undefined,
          endpointId: req.endpointId,
          kind: 'pty',
          command: `open ${pty.id}`,
        });
        return { sessionId: pty.id };
      },

      listTerminals(req) {
        return { terminals: hub.listPtys(req.endpointId || undefined).map(toTerminal) };
      },

      async *attachTerminal(req, ctx): AsyncIterable<TerminalOutput> {
        const pty = await mapErrors(() => hub.getPty(req.sessionId));
        const { events, needsRedraw } = pty.subscribe(req.fromSeq);
        if (needsRedraw) hub.redrawPty(pty.id);
        const onAbort = () => pty.unsubscribe(events);
        ctx.signal.addEventListener('abort', onAbort);
        try {
          for await (const ev of events) {
            if (ev.kind === 'output') {
              yield create(TerminalOutputSchema, { data: ev.data, seq: ev.seq, reset: ev.reset, replay: ev.replay });
            } else {
              yield create(TerminalOutputSchema, { seq: ev.seq, exitCode: ev.exitCode });
              return;
            }
          }
        } finally {
          ctx.signal.removeEventListener('abort', onAbort);
          pty.unsubscribe(events);
        }
      },

      async sendInput(req) {
        await mapErrors(() => hub.sendPtyInput(req.sessionId, req.clientId, req.inputSeq, req.data));
        return {};
      },

      async resizeTerminal(req) {
        await mapErrors(() => hub.resizePty(req.sessionId, Math.max(req.cols, 1), Math.max(req.rows, 1)));
        return {};
      },

      async closeTerminal(req) {
        await mapErrors(() => hub.closePty(req.sessionId));
        return {};
      },

      async renameTerminal(req) {
        const title = cleanName(req.title);
        await mapErrors(() => hub.renamePty(req.sessionId, title));
        return {};
      },

      async renameEndpoint(req) {
        if (!(await store.renameEndpoint(req.endpointId, cleanName(req.displayName)))) {
          throw new ConnectError(`endpoint ${req.endpointId} not found`, Code.NotFound);
        }
        hub.events.emit('changed', { id: req.endpointId });
        return {};
      },

      async *watchApprovals(_req, ctx): AsyncIterable<ApprovalEvent> {
        const queue = new AsyncQueue<ApprovalRow>();
        const onChange = (row: ApprovalRow) => queue.push(row);
        approvals.events.on('change', onChange);
        ctx.signal.addEventListener('abort', () => queue.close());
        try {
          for (const e of await view.list()) names.set(e.id, e.displayName || e.hostname);
          for (const row of approvals.pending()) yield create(ApprovalEventSchema, { approval: toApproval(row) });
          for await (const row of queue) yield create(ApprovalEventSchema, { approval: toApproval(row) });
        } finally {
          approvals.events.off('change', onChange);
        }
      },

      async decideApproval(req, ctx) {
        if (!(await approvals.decide(req.id, req.approve, ctx.values.get(kUser)?.id || undefined))) {
          throw new ConnectError(`approval ${req.id} is not pending`, Code.FailedPrecondition);
        }
        return {};
      },

      async listAiSessions(req) {
        const rows = await store.listAiSessions(req.endpointId ? [ALL_PCS, req.endpointId] : undefined);
        return { sessions: rows.map(toAiSession) };
      },

      async createAiSession(req) {
        if (req.scope !== ALL_PCS && !(await view.get(req.scope))) {
          throw new ConnectError(`scope must be "${ALL_PCS}" or a registered endpoint id`, Code.InvalidArgument);
        }
        return toAiSession(await store.createAiSession(req.scope));
      },

      async renameAiSession(req) {
        if (!(await store.renameAiSession(req.id, cleanName(req.title)))) {
          throw new ConnectError(`AI session ${req.id} not found`, Code.NotFound);
        }
        return {};
      },

      async deleteAiSession(req) {
        // 목록에서만 지운다. Flue 의 대화 기록(flue.db)은 남는다
        if (!(await store.deleteAiSession(req.id))) throw new ConnectError(`AI session ${req.id} not found`, Code.NotFound);
        return {};
      },

      async getAiSettings() {
        return { model: aiModels.current(), models: await aiModels.list() };
      },

      async updateAiSettings(req) {
        try {
          await aiModels.set(req.model);
        } catch (err) {
          if (err instanceof UnknownModelError) throw new ConnectError(err.message, Code.InvalidArgument);
          throw err;
        }
        return { model: aiModels.current(), models: await aiModels.list() };
      },

      async setApprovalPolicy(req) {
        if (!APPROVAL_POLICIES.includes(req.policy as ApprovalPolicy)) {
          throw new ConnectError(`policy must be one of ${APPROVAL_POLICIES.join(', ')}`, Code.InvalidArgument);
        }
        if (!(await store.setApprovalPolicy(req.endpointId, req.policy as ApprovalPolicy))) {
          throw new ConnectError(`endpoint ${req.endpointId} not found`, Code.NotFound);
        }
        return {};
      },
    });
  };
}

/**
 * ConsoleService 를 Flue 의 Hono 앱에 마운트한다. 로그인한 사용자만 호출할 수 있다.
 * Flue 빌드 서버는 교체할 수 없으므로 Connect 를 fetch 핸들러로 바꿔 Hono 라우트로 붙인다.
 */
export function mountConsole(app: Hono, hub: AgentHub, store: Store, approvals: ApprovalCenter, aiModels: AiModels): void {
  const router = createConnectRouter();
  consoleRoutes(hub, store, approvals, aiModels)(router);
  for (const handler of router.handlers) {
    app.post(RPC_PREFIX + handler.requestPath, requireAuth(store), async (c) => {
      // 로그인 사용자를 Connect 핸들러의 context 로 넘긴다 (감사 로그용)
      const req = universalServerRequestFromFetch(c.req.raw, {});
      req.contextValues = createContextValues().set(kUser, (c as Context<AuthEnv>).get('user'));
      return universalServerResponseToFetch(await handler(req));
    });
  }
}
