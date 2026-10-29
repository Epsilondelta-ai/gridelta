import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { text } from 'node:stream/consumers';
import { cancel, isCancel, password as promptPassword } from '@clack/prompts';
import { ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { AdminService } from '@gridelta/proto/admin';
import type { AuthEvent, AuthPrompt, ProviderAuthInteraction } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { Command, InvalidArgumentError } from 'commander';

const program = new Command('gridelta')
  .description('gridelta 서버 관리 CLI. 서버 호스트에서 실행한다.')
  .option(
    '--socket <path>',
    'AdminService 유닉스 소켓',
    process.env.GRIDELTA_ADMIN_SOCKET ?? join(process.env.GRIDELTA_DATA_DIR ?? 'data', 'admin.sock'),
  );

function admin() {
  const transport = createConnectTransport({
    baseUrl: 'http://localhost',
    httpVersion: '1.1',
    nodeOptions: { socketPath: program.opts<{ socket: string }>().socket },
  });
  return createClient(AdminService, transport);
}

/** "90s", "30m", "1h", "2d" → 초 */
function parseDuration(value: string): number {
  const m = /^(\d+)([smhd])$/.exec(value);
  if (!m) throw new InvalidArgumentError('예: 30m, 1h, 2d');
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

const enrollToken = program.command('enroll-token').description('에이전트 등록 토큰');
enrollToken
  .command('create')
  .description('1회용 등록 토큰을 발급하고 에이전트에서 실행할 명령줄을 출력한다')
  .option('--ttl <duration>', '유효 시간', parseDuration, 3600)
  .action(async (opts: { ttl: number }) => {
    const res = await admin().createEnrollToken({ ttlSeconds: opts.ttl });
    const args = ['gridelta-agent', 'enroll', '--server', res.serverUrl, '--token', res.token];
    if (res.caFingerprint) args.push('--ca-fingerprint', res.caFingerprint);
    console.log(`만료: ${new Date(Number(res.expiresAtMs)).toISOString()}`);
    console.log('원격 PC에서 관리자 권한으로 실행하세요:\n');
    console.log(`  ${args.map(shellQuote).join(' ')}`);
  });

const endpoints = program.command('endpoints').description('등록된 PC');
endpoints
  .command('list')
  .description('등록된 PC 목록')
  .option('--json', 'JSON 으로 출력')
  .action(async (opts: { json?: boolean }) => {
    const res = await admin().listEndpoints({});
    if (opts.json) {
      console.log(JSON.stringify(res.endpoints.map(({ $typeName, lastSeenMs, ...e }) => ({ ...e, lastSeenMs: Number(lastSeenMs) }))));
      return;
    }
    if (res.endpoints.length === 0) {
      console.log('등록된 PC가 없습니다.');
      return;
    }
    for (const e of res.endpoints) {
      const seen = e.lastSeenMs ? new Date(Number(e.lastSeenMs)).toISOString() : '-';
      const name = e.displayName ? `${e.displayName} (${e.hostname})` : e.hostname;
      console.log(`${e.online ? '●' : '○'} ${e.id}  ${name}  ${e.os}/${e.arch}  last seen ${seen}`);
    }
  });
endpoints
  .command('revoke <id>')
  .description('PC 자격 증명을 폐기하고 즉시 연결을 끊는다')
  .action(async (id: string) => {
    await admin().revokeEndpoint({ endpointId: id });
    console.log(`폐기했습니다: ${id}`);
  });

const user = program.command('user').description('웹 관리자 계정');
user
  .command('create <username>')
  .description('웹 관리자 계정을 만든다')
  .option('--password-stdin', '비밀번호를 표준 입력에서 읽는다')
  .action(async (username: string, opts: { passwordStdin?: boolean }) => {
    let password: string;
    if (opts.passwordStdin) {
      password = (await text(process.stdin)).replace(/\r?\n$/, '');
    } else {
      const answer = await promptPassword({ message: `${username} 비밀번호` });
      if (isCancel(answer)) {
        cancel('취소했습니다.');
        process.exit(1);
      }
      password = answer;
    }
    const res = await admin().createUser({ username, password });
    console.log(`계정을 만들었습니다: ${username} (${res.userId})`);
  });

/** Pi 의 로그인 흐름에 터미널 입출력을 붙인다. 로그인 방식 선택은 --device 로 정한다 */
function terminalInteraction(device: boolean, signal: AbortSignal): ProviderAuthInteraction {
  return {
    signal,
    async prompt(p: AuthPrompt) {
      if (p.type === 'select') {
        const pick = p.options.find((o) => (device ? /device/i.test(o.id + o.label) : !/device/i.test(o.id + o.label)));
        return (pick ?? p.options[0]!).id;
      }
      // 콜백을 받지 못했을 때 붙여 넣는 리디렉션 URL / 코드. 콜백이 먼저 오면 signal 로 취소된다
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(`\n${p.message}\n> `, { signal: p.signal ?? signal });
      } finally {
        rl.close();
      }
    },
    notify(e: AuthEvent) {
      switch (e.type) {
        case 'auth_url':
          console.log(`\n브라우저에서 아래 주소를 열어 로그인하세요:\n\n  ${e.url}\n`);
          console.log('로그인 후 http://localhost:1455/auth/callback?... 로 이동합니다.');
          console.log('그 페이지가 열리지 않으면 주소창의 URL 전체를 복사해 아래에 붙여 넣으세요.');
          break;
        case 'device_code':
          console.log(`\n${e.verificationUri} 에서 아래 코드를 입력하세요:\n\n  ${e.userCode}\n`);
          console.log('(디바이스 코드 로그인은 ChatGPT 보안 설정 또는 워크스페이스 관리자가 켜야 합니다)');
          break;
        case 'info':
        case 'progress':
          console.log(e.message);
          break;
      }
    },
  };
}

const loginCmd = program.command('login').description('외부 서비스 로그인');
loginCmd
  .command('openai')
  .description('ChatGPT 계정으로 로그인한다 (Codex OAuth). 자격 증명은 서버 DB 에 암호화해 저장한다')
  .option('--device', '브라우저 대신 디바이스 코드로 로그인한다')
  .action(async (opts: { device?: boolean }) => {
    const oauth = openaiCodexProvider().auth.oauth!;
    const ac = new AbortController();
    process.once('SIGINT', () => ac.abort());
    const cred = await oauth.login(terminalInteraction(!!opts.device, ac.signal));
    await admin().storeOAuthToken({ provider: 'openai-codex', credentialJson: JSON.stringify(cred) });
    console.log(`\n로그인했습니다. 만료: ${new Date(cred.expires).toISOString()} (서버가 자동으로 갱신합니다)`);
    process.exit(0);
  });

program
  .command('logout')
  .argument('<service>', 'openai')
  .description('저장된 자격 증명을 지운다')
  .action(async (service: string) => {
    if (service !== 'openai') throw new InvalidArgumentError('openai 만 지원합니다');
    await admin().deleteOAuthToken({ provider: 'openai-codex' });
    console.log('로그아웃했습니다.');
  });

program
  .command('auth')
  .command('status')
  .description('OpenAI 로그인 상태와 서버가 쓰는 모델')
  .action(async () => {
    const s = await admin().getAuthStatus({});
    console.log(`모델: ${s.model}`);
    if (!s.loggedIn) {
      console.log('OpenAI: 로그인하지 않음 (gridelta login openai)');
      return;
    }
    console.log(`OpenAI: 로그인됨 (계정 ${s.account || '-'}, 토큰 만료 ${new Date(Number(s.expiresAtMs)).toISOString()})`);
  });

try {
  await program.parseAsync();
} catch (err) {
  const cause = err instanceof ConnectError ? err.cause : err;
  if (cause instanceof Error && 'code' in cause && (cause.code === 'ENOENT' || cause.code === 'ECONNREFUSED')) {
    console.error(`서버에 연결할 수 없습니다 (${program.opts<{ socket: string }>().socket}). 서버가 실행 중인지 확인하세요.`);
  } else if (err instanceof ConnectError) {
    console.error(`오류: ${err.rawMessage}`);
  } else {
    throw err;
  }
  process.exit(1);
}
