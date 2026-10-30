import { existsSync } from 'node:fs';
import { serveStatic } from '@hono/node-server/serve-static';
import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono, type Next } from 'hono';
import { Assistant } from './agents/assistant.ts';
import { Operator } from './agents/operator.ts';
import { registerFauxProvider } from './ai/faux.ts';
import { aiModels, approvals } from './ai/index.ts';
import { aiJobRunner } from './ai/job-runner.ts';
import { sessionForInstance } from './ai/sessions.ts';
import { OAuthVault, registerCodexProvider } from './auth/openai.ts';
import { loadMasterKey } from './auth/secrets.ts';
import { mountAuth, requireAuth } from './auth/web.ts';
import { config } from './config.ts';
import { certFingerprint, startGateway } from './gateway/gateway.ts';
import { hub } from './hub/index.ts';
import { startAdmin } from './rpc/admin.ts';
import { mountConsole } from './rpc/console.ts';
import { mountDebug } from './rpc/debug.ts';
import { scheduler } from './jobs/index.ts';
import { jobStore, store } from './store/index.ts';

// AgentGateway(HTTP/2)와 AdminService(유닉스 소켓)는 Flue 서버와 별도로 띄운다(설계 6.1).
// Vite 개발 모드에서 app.ts 가 다시 로드돼도 한 번만 실행하도록 globalThis 로 막는다.
const g = globalThis as { __grideltaServers?: unknown };

// 등록 명령에 넣는 게이트웨이 주소와 (자체 서명이면) 인증서 지문. CLI(AdminService)와 웹(ConsoleService)이 함께 쓴다
const enrollInfo = {
  gatewayUrl: config.gatewayUrl,
  caFingerprint: config.tlsSelfSigned && config.tlsCert ? certFingerprint(config.tlsCert) : undefined,
};

g.__grideltaServers ??= (() => {
  if (!config.webAuth) {
    console.warn('[auth] GRIDELTA_WEB_AUTH=off: 웹 로그인 없이 모든 기능이 열려 있습니다. 외부에 노출하지 마세요.');
  }

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
  const vault = new OAuthVault(store, loadMasterKey(config.masterKeyPath));
  void aiModels.load();
  scheduler.setAiRunner(aiJobRunner(store, jobStore));
  void scheduler.start(new Date(), config.catchupDelayMs);
  if (config.aiFaux) registerFauxProvider();
  // openai-codex 는 CLI 로그인(gridelta login openai)으로 저장한 자격 증명을 쓴다. openai/... 는 OPENAI_API_KEY
  else registerCodexProvider(vault);

  return {
    gateway: startGateway(hub, store, { port: config.gatewayPort, tlsCert: config.tlsCert, tlsKey: config.tlsKey }),
    admin: startAdmin(hub, store, config.adminSocket, {
      ...enrollInfo,
      vault,
      aiModel: () => aiModels.current(),
    }),
  };
})();

const app = new Hono();

app.get('/healthz', (c) => c.text('ok'));
mountAuth(app, store);
mountConsole(app, { hub, store, jobs: jobStore, approvals, aiModels, scheduler, enroll: enrollInfo });

// AI 대화: Flue 라우트. 통합 대화는 /agents/assistant/<세션>, PC 대화는 /agents/operator/<PC>:<세션>.
// "대화 URL 에 접근할 수 있으면 누구나 대화할 수 있다" 는 Flue 의 전제 때문에 인증을 반드시 앞에 두고,
// 등록된 세션(ConsoleService.CreateAiSession)의 URL 만 열어 준다
app.use('/agents/*', requireAuth(store));
for (const agent of ['assistant', 'operator'] as const) {
  const check = async (c: Context, next: Next) => {
    const session = await sessionForInstance(store, agent, c.req.param('id') ?? '');
    if (!session) return c.json({ error: 'unknown AI session' }, 404);
    // 메시지를 보낼 때 세션 목록의 "마지막 사용" 을 갱신한다
    if (c.req.method === 'POST' && !c.req.path.endsWith('/abort')) await store.touchAiSession(session.id);
    await next();
  };
  app.use(`/agents/${agent}/:id`, check);
  app.use(`/agents/${agent}/:id/*`, check);
}
app.route('/agents/assistant', createAgentRouter(Assistant));
app.route('/agents/operator', createAgentRouter(Operator));
if (config.debug) mountDebug(app, hub);

// 웹 UI (SPA): 파일이 있으면 그대로, 없으면 index.html
if (existsSync(config.webDir)) {
  app.use('/*', serveStatic({ root: config.webDir }));
  app.get('/*', serveStatic({ root: config.webDir, path: 'index.html' }));
}

export default app;
