import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-web';
import { ConsoleService } from '@gridelta/proto/console';

const transport = createConnectTransport({ baseUrl: '/rpc' });

export const consoleClient = createClient(ConsoleService, transport);

export interface User {
  id: string;
  username: string;
}

export async function fetchMe(): Promise<User | undefined> {
  const res = await fetch('/api/me');
  if (!res.ok) return undefined;
  return ((await res.json()) as { user: User }).user;
}

export async function login(username: string, password: string): Promise<User> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = (await res.json()) as { user?: User; error?: string };
  if (!res.ok || !body.user) throw new Error(body.error ?? '로그인에 실패했습니다.');
  return body.user;
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

export function isUnauthenticated(err: unknown): boolean {
  return ConnectError.from(err).code === Code.Unauthenticated;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
