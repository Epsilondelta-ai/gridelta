import type { OAuthCredential } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { setProvider } from '@flue/runtime';
import type { Store } from '../store/index.ts';
import { decrypt, encrypt, KEY_VERSION } from './secrets.ts';

export const CODEX_PROVIDER = 'openai-codex';
/** 만료까지 이보다 적게 남으면 요청 전에 갱신한다 */
const REFRESH_BEFORE_MS = 5 * 60 * 1000;

export class NotLoggedInError extends Error {
  constructor() {
    super('OpenAI 로그인이 필요합니다. 서버 호스트에서 `gridelta login openai` 를 실행하세요.');
    this.name = 'NotLoggedInError';
  }
}

/** OAuth 자격 증명을 DB 에 암호화해 저장한다 (설계 9.2) */
export class OAuthVault {
  constructor(
    private readonly store: Store,
    private readonly masterKey: Buffer,
  ) {}

  async save(provider: string, cred: OAuthCredential): Promise<void> {
    await this.store.putOAuthToken({
      provider,
      credential: encrypt(this.masterKey, JSON.stringify(cred), provider),
      keyVersion: KEY_VERSION,
      account: typeof cred.accountId === 'string' ? cred.accountId : '',
      expiresAt: new Date(cred.expires),
    });
  }

  async load(provider: string): Promise<OAuthCredential | undefined> {
    const row = await this.store.getOAuthToken(provider);
    if (!row) return undefined;
    return JSON.parse(decrypt(this.masterKey, row.credential, provider, row.keyVersion)) as OAuthCredential;
  }

  delete(provider: string): Promise<boolean> {
    return this.store.deleteOAuthToken(provider);
  }
}

/**
 * Flue 가 openai-codex 모델을 부를 때 DB 의 자격 증명을 쓰도록 같은 id 로 provider 를 다시 등록한다.
 * resolve 는 요청마다 불리므로 여기서 만료를 확인하고, 동시 갱신은 하나의 Promise 로 묶는다.
 */
export function registerCodexProvider(vault: OAuthVault): void {
  const codex = openaiCodexProvider();
  const oauth = codex.auth.oauth;
  if (!oauth) throw new Error('openai-codex provider has no OAuth support');
  let refreshing: Promise<OAuthCredential> | undefined;

  async function validCredential(signal: AbortSignal): Promise<OAuthCredential> {
    const cred = await vault.load(CODEX_PROVIDER);
    if (!cred) throw new NotLoggedInError();
    if (cred.expires - Date.now() > REFRESH_BEFORE_MS) return cred;
    refreshing ??= oauth!
      .refresh(cred, signal)
      .then(async (next) => {
        const merged = { ...cred, ...next };
        await vault.save(CODEX_PROVIDER, merged);
        return merged;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }

  setProvider({
    ...codex,
    auth: {
      apiKey: {
        name: 'gridelta OpenAI login',
        resolve: async ({ signal }) => ({ auth: await oauth.toAuth(await validCredential(signal)), source: 'gridelta' }),
      },
    },
  });
}
