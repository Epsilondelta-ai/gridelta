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
  type JobSpec,
  JobSpecSchema,
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
import type { ApprovalCenter, ApprovalJobDetail } from '../ai/approvals.ts';
import { type AiModels, UnknownModelError } from '../ai/models.ts';
import { agentUrl } from '../ai/sessions.ts';
import {
  ALL_PCS,
  type AiSessionRow,
  APPROVAL_POLICIES,
  type ApprovalPolicy,
  type ApprovalRow,
  DEFAULT_GROUP,
  NameTakenError,
  type JobStore,
  type SessionUser,
  type Store,
} from '../store/index.ts';
import { endpointsView } from './endpoints-view.ts';
import { createEnrollToken, type EnrollInfo } from './enroll.ts';
import { jobHandlers } from './jobs.ts';
import type { Scheduler } from '../jobs/scheduler.ts';

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

/** 잡 승인이면 승인 카드에 보일 잡 내용 */
function jobDetail(row: ApprovalRow): { job?: JobSpec; targetName?: string } {
  if (row.kind !== 'job' || !row.detail) return {};
  const d = JSON.parse(row.detail) as ApprovalJobDetail;
  return { job: create(JobSpecSchema, { ...d.spec, runAtMs: BigInt(d.spec.runAtMs) }), targetName: d.targetName };
}

function toAiSession(row: AiSessionRow): AiSession {
  return create(AiSessionSchema, {
    id: row.id,
    scope: row.scope,
    title: row.title,
    createdAtMs: BigInt(row.createdAt.getTime()),
    updatedAtMs: BigInt(row.updatedAt.getTime()),
    agentUrl: agentUrl(row),
    jobRunId: row.jobRunId ?? '',
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

export interface ConsoleDeps {
  hub: AgentHub;
  store: Store;
  jobs: JobStore;
  approvals: ApprovalCenter;
  aiModels: AiModels;
  scheduler: Scheduler;
  enroll: EnrollInfo;
}

export function consoleRoutes({ hub, store, jobs, approvals, aiModels, scheduler, enroll }: ConsoleDeps) {
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
      kind: row.kind,
      ...jobDetail(row),
    });
  return (router: ConnectRouter) => {
    router.service(ConsoleService, {
      ...jobHandlers({ store, jobs, scheduler }),

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

      async listGroups() {
        return { groups: (await store.listGroups()).map((g) => ({ id: g.id, name: g.name, endpointCount: g.endpointCount })) };
      },

      async createGroup(req) {
        const name = cleanName(req.name);
        if (!name) throw new ConnectError('name is required', Code.InvalidArgument);
        try {
          const g = await store.createGroup(name);
          return { id: g.id, name: g.name, endpointCount: 0 };
        } catch (err) {
          if (err instanceof NameTakenError) throw new ConnectError(err.message, Code.AlreadyExists);
          throw err;
        }
      },

      async renameGroup(req) {
        const name = cleanName(req.name);
        if (!name) throw new ConnectError('name is required', Code.InvalidArgument);
        try {
          if (!(await store.renameGroup(req.id, name))) throw new ConnectError(`group ${req.id} not found`, Code.NotFound);
        } catch (err) {
          if (err instanceof NameTakenError) throw new ConnectError(err.message, Code.AlreadyExists);
          throw err;
        }
        return {};
      },

      async deleteGroup(req) {
        if (req.id === DEFAULT_GROUP) throw new ConnectError('the default group cannot be deleted', Code.FailedPrecondition);
        const moved = (await view.list()).filter((e) => e.groupId === req.id).map((e) => e.id);
        if (!(await store.deleteGroup(req.id))) throw new ConnectError(`group ${req.id} not found`, Code.NotFound);
        for (const id of moved) hub.events.emit('changed', { id });
        return {};
      },

      async moveEndpoint(req) {
        if (!(await store.findGroup(req.groupId))) throw new ConnectError(`group ${req.groupId} not found`, Code.NotFound);
        if (!(await store.moveEndpoint(req.endpointId, req.groupId))) {
          throw new ConnectError(`endpoint ${req.endpointId} not found`, Code.NotFound);
        }
        hub.events.emit('changed', { id: req.endpointId });
        return {};
      },

      createEnrollToken: (req) => createEnrollToken(store, enroll, req),

      async listEnrollTokens(req) {
        const rows = await store.listEnrollTokens(req.groupId || undefined);
        return {
          tokens: rows.map((t) => ({
            id: t.tokenHash,
            groupId: t.groupId,
            createdAtMs: BigInt(t.createdAt.getTime()),
            expiresAtMs: BigInt(t.expiresAt.getTime()),
            maxUses: t.maxUses,
            uses: t.uses,
          })),
        };
      },

      async revokeEnrollToken(req) {
        if (!(await store.revokeEnrollToken(req.id))) throw new ConnectError('token not found or already revoked', Code.NotFound);
        return {};
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
export function mountConsole(app: Hono, deps: ConsoleDeps): void {
  const store = deps.store;
  const router = createConnectRouter();
  consoleRoutes(deps)(router);
  for (const handler of router.handlers) {
    app.post(RPC_PREFIX + handler.requestPath, requireAuth(store), async (c) => {
      // 로그인 사용자를 Connect 핸들러의 context 로 넘긴다 (감사 로그용)
      const req = universalServerRequestFromFetch(c.req.raw, {});
      req.contextValues = createContextValues().set(kUser, (c as Context<AuthEnv>).get('user'));
      return universalServerResponseToFetch(await handler(req));
    });
  }
}
