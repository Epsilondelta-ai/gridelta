import { chmodSync, rmSync } from 'node:fs';
import http from 'node:http';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { AdminService } from '@gridelta/proto/admin';
import type { AgentHub } from '../hub/index.ts';
import { type Store, UsernameTakenError } from '../store/index.ts';
import { endpointsView } from './endpoints-view.ts';

export interface AdminOptions {
  gatewayUrl: string;
  /** 자체 서명 인증서일 때만 등록 명령줄에 넣을 지문 */
  caFingerprint?: string;
}

const DEFAULT_ENROLL_TTL_S = 3600;
const MIN_PASSWORD_LENGTH = 8;

export function adminRoutes(hub: AgentHub, store: Store, opts: AdminOptions) {
  return (router: ConnectRouter) => {
    router.service(AdminService, {
      async createEnrollToken(req) {
        const ttlS = req.ttlSeconds || DEFAULT_ENROLL_TTL_S;
        const { token, expiresAt } = await store.createEnrollToken(ttlS * 1000);
        return {
          token,
          expiresAtMs: BigInt(expiresAt.getTime()),
          serverUrl: opts.gatewayUrl,
          caFingerprint: opts.caFingerprint ?? '',
        };
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
