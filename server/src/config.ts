import { join, resolve } from 'node:path';

const env = process.env;
const dataDir = resolve(env.GRIDELTA_DATA_DIR ?? 'data');

/** 서버 설정. 모두 환경변수로 받는다. */
export const config = {
  dataDir,
  dbPath: join(dataDir, 'gridelta.db'),
  /** drizzle-kit 이 만든 마이그레이션 폴더. 서버는 server/ 디렉터리에서 실행한다 */
  migrationsDir: resolve(env.GRIDELTA_MIGRATIONS_DIR ?? 'drizzle'),
  adminSocket: env.GRIDELTA_ADMIN_SOCKET ?? join(dataDir, 'admin.sock'),

  gatewayPort: Number(env.GRIDELTA_GATEWAY_PORT ?? 8443),
  /** 에이전트가 접속할 게이트웨이 주소. 등록 명령줄에 들어간다 */
  gatewayUrl: env.GRIDELTA_GATEWAY_URL ?? 'https://localhost:8443',
  /** 둘 다 있으면 게이트웨이를 TLS 로 띄운다. 없으면 h2c (TLS 를 프록시가 맡는 경우) */
  tlsCert: env.GRIDELTA_TLS_CERT,
  tlsKey: env.GRIDELTA_TLS_KEY,
  /** 자체 서명 인증서면 등록 토큰과 함께 CA 지문을 내보내 에이전트가 고정하게 한다 */
  tlsSelfSigned: env.GRIDELTA_TLS_SELF_SIGNED === '1',

  /** 웹 UI 빌드 결과. 없으면 API 만 제공한다 */
  webDir: resolve(env.GRIDELTA_WEB_DIR ?? '../web/dist'),

  /** Flue 모델 id (provider/model). M6 에서 웹 UI 설정으로 바꿀 수 있게 한다 */
  aiModel: env.GRIDELTA_AI_MODEL ?? 'openai-codex/gpt-5.6-sol',
  /** e2e 테스트용 정해진 응답 모델을 쓴다 */
  aiFaux: env.GRIDELTA_AI_FAUX === '1',

  debug: env.GRIDELTA_DEBUG === '1',
};
