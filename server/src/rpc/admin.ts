import { chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { AdminService } from '@gridelta/proto/admin';
import { CODEX_PROVIDER, type OAuthVault } from '../auth/openai.ts';
import type { AgentHub } from '../hub/index.ts';
import { NameTakenError, type Store, UsernameTakenError } from '../store/index.ts';
import { createEnrollToken, type EnrollInfo } from './enroll.ts';
import { endpointsView } from './endpoints-view.ts';

export interface AdminOptions extends EnrollInfo {
  vault: OAuthVault;
  /** 현재 AI 모델 (웹 UI 에서 바꿀 수 있다) */
  aiModel: () => string;
}

const MIN_PASSWORD_LENGTH = 8;

export function adminRoutes(hub: AgentHub, store: Store, opts: AdminOptions) {
  return (router: ConnectRouter) => {
    router.service(AdminService, {
      createEnrollToken: (req) => createEnrollToken(store, opts, req),

      async listGroups() {
        return { groups: (await store.listGroups()).map((g) => ({ id: g.id, name: g.name, endpointCount: g.endpointCount })) };
      },

      async createGroup(req) {
        if (!req.name.trim()) throw new ConnectError('name is required', Code.InvalidArgument);
        try {
          const g = await store.createGroup(req.name.trim());
          return { id: g.id, name: g.name, endpointCount: 0 };
        } catch (err) {
          if (err instanceof NameTakenError) throw new ConnectError(err.message, Code.AlreadyExists);
          throw err;
        }
      },

      async listEndpoints() {
        return { endpoints: await endpointsView(hub, store).list() };
      },

      async revokeEndpoint(req) {
        if (!(await store.revokeEndpoint(req.endpointId))) {
          throw new ConnectError(`endpoint ${req.endpointId} not found or already revoked`, Code.NotFound);
        }
        // 즉시 연결을 끊는다. 재접속은 인증 단계에서 거부된다
        const conn = hub.get(req.endpointId);
        if (conn) hub.detach(conn);
        return {};
      },

      async storeOAuthToken(req) {
        if (req.provider !== CODEX_PROVIDER) {
          throw new ConnectError(`unsupported provider ${req.provider}`, Code.InvalidArgument);
        }
        const cred = JSON.parse(req.credentialJson) as { access?: unknown; refresh?: unknown; expires?: unknown };
        if (typeof cred.access !== 'string' || typeof cred.refresh !== 'string' || typeof cred.expires !== 'number') {
          throw new ConnectError('credential must have access, refresh and expires', Code.InvalidArgument);
        }
        await opts.vault.save(req.provider, { ...cred, type: 'oauth' } as Parameters<OAuthVault['save']>[1]);
        return {};
      },

      async deleteOAuthToken(req) {
        await opts.vault.delete(req.provider || CODEX_PROVIDER);
        return {};
      },

      async getAuthStatus() {
        const row = await store.getOAuthToken(CODEX_PROVIDER);
        return {
          loggedIn: !!row,
          provider: row?.provider ?? '',
          account: row?.account ?? '',
          expiresAtMs: BigInt(row?.expiresAt.getTime() ?? 0),
          model: opts.aiModel(),
        };
      },

      async createUser(req) {
        if (!req.username) throw new ConnectError('username is required', Code.InvalidArgument);
        if (req.password.length < MIN_PASSWORD_LENGTH) {
          throw new ConnectError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, Code.InvalidArgument);
        }
        try {
          return { userId: await store.createUser(req.username, req.password) };
        } catch (err) {
          if (err instanceof UsernameTakenError) throw new ConnectError(err.message, Code.AlreadyExists);
          throw err;
        }
      },
    });
  };
}

/** CLI 용 AdminService 를 유닉스 소켓에 띄운다. 소켓 권한 0600 이 곧 인증이다. */
export function startAdmin(hub: AgentHub, store: Store, socketPath: string, opts: AdminOptions): http.Server {
  rmSync(socketPath, { force: true });
  const server = http.createServer(connectNodeAdapter({ routes: adminRoutes(hub, store, opts) }));
  server.listen(socketPath, () => {
    chmodSync(socketPath, 0o600);
    console.info(`[admin] listening on ${socketPath}`);
  });
  return server;
}
