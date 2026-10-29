import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { cancel, isCancel, password as promptPassword } from '@clack/prompts';
import { ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { AdminService } from '@gridelta/proto/admin';
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
      console.log(`${e.online ? '●' : '○'} ${e.id}  ${e.hostname}  ${e.os}/${e.arch}  last seen ${seen}`);
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
