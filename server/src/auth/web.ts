import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { config } from '../config.ts';
import type { SessionUser, Store } from '../store/index.ts';

export const SESSION_COOKIE = 'gridelta_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// 로그인 실패 제한: 같은 아이디로 5번 틀리면 1분 잠근다 (단일 프로세스라 메모리로 충분)
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

export type AuthEnv = { Variables: { user: SessionUser } };

/** 웹 로그인을 끈 경우(GRIDELTA_WEB_AUTH=off)의 사용자. 감사 로그에는 user_id 없이 남는다 */
export const ANONYMOUS_USER: SessionUser = { id: '', username: 'local' };

/** 프록시 뒤에서는 X-Forwarded-Proto 로 HTTPS 여부를 판단한다. HTTPS 일 때만 Secure 쿠키를 쓴다. */
function isHttps(c: Context): boolean {
  return c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';
}

export async function verifySession(store: Store, c: Context): Promise<SessionUser | undefined> {
  if (!config.webAuth) return ANONYMOUS_USER;
  const token = getCookie(c, SESSION_COOKIE);
  return token ? store.getSessionUser(token) : undefined;
}

/** 로그인한 사용자만 통과시킨다. Connect 클라이언트는 401 을 Unauthenticated 로 받는다. */
export function requireAuth(store: Store): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const user = await verifySession(store, c);
    if (!user) return c.json({ code: 'unauthenticated', message: 'login required' }, 401);
    c.set('user', user);
    await next();
  };
}

export function mountAuth(app: Hono, store: Store): void {
  app.post('/api/login', async (c) => {
    const body: { username?: string; password?: string } = await c.req.json().catch(() => ({}));
    const { username = '', password = '' } = body;
    const f = failures.get(username);
    if (f && f.lockedUntil > Date.now()) {
      return c.json({ error: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' }, 429);
    }

    const user = await store.verifyPassword(username, password);
    if (!user) {
      const count = (f?.count ?? 0) + 1;
      failures.set(username, { count, lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCK_MS : 0 });
      return c.json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' }, 401);
    }
    failures.delete(username);

    const { token, expiresAt } = await store.createSession(user.id, SESSION_TTL_MS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: isHttps(c),
      sameSite: 'Strict',
      path: '/',
      expires: expiresAt,
    });
    return c.json({ user });
  });

  app.post('/api/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await store.deleteSession(token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({});
  });

  app.get('/api/me', async (c) => {
    const user = await verifySession(store, c);
    return user ? c.json({ user, authDisabled: !config.webAuth }) : c.json({ error: 'login required' }, 401);
  });
}
