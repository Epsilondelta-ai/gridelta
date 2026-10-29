import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  type CreateEnrollTokenRequest,
  type CreateEnrollTokenResponse,
  CreateEnrollTokenResponseSchema,
} from '@gridelta/proto/console';
import { DEFAULT_GROUP, type Store } from '../store/index.ts';

const DEFAULT_ENROLL_TTL_S = 3600;

export interface EnrollInfo {
  /** 에이전트가 접속할 게이트웨이 주소 */
  gatewayUrl: string;
  /** 자체 서명 인증서일 때만 등록 명령에 넣는 지문 */
  caFingerprint?: string;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** 등록만 하는 명령줄 인자 */
export function enrollArgs(info: EnrollInfo, token: string): string[] {
  const args = ['enroll', '--server', info.gatewayUrl, '--token', token];
  if (info.caFingerprint) args.push('--ca-fingerprint', info.caFingerprint);
  return args;
}

/** 그룹에 PC 를 등록하는 토큰을 만들고, OS 별로 등록부터 서비스 시작까지 하는 명령을 함께 돌려준다 (CLI·웹 공용) */
export async function createEnrollToken(
  store: Store,
  info: EnrollInfo,
  req: Pick<CreateEnrollTokenRequest, 'groupId' | 'ttlSeconds' | 'maxUses'>,
): Promise<CreateEnrollTokenResponse> {
  const groupId = req.groupId || DEFAULT_GROUP;
  if (!(await store.findGroup(groupId))) throw new ConnectError(`group ${groupId} not found`, Code.NotFound);
  const ttlS = req.ttlSeconds || DEFAULT_ENROLL_TTL_S;
  const { token, expiresAt } = await store.createEnrollToken(ttlS * 1000, { groupId, maxUses: req.maxUses });
  const args = enrollArgs(info, token);
  const unixEnroll = ['gridelta-agent', ...args].map(shellQuote).join(' ');
  return create(CreateEnrollTokenResponseSchema, {
    token,
    expiresAtMs: BigInt(expiresAt.getTime()),
    serverUrl: info.gatewayUrl,
    caFingerprint: info.caFingerprint ?? '',
    unixCommand: `sudo sh -c ${shellQuote(`${unixEnroll} && gridelta-agent install && gridelta-agent start`)}`,
    windowsCommand: `gridelta-agent.exe ${args.map((a) => (/^[\w:./-]+$/.test(a) ? a : `'${a}'`)).join(' ')}; if ($?) { gridelta-agent.exe install; gridelta-agent.exe start }`,
  });
}
