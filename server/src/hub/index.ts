import { AgentHub } from './hub.ts';

export * from './hub.ts';

// Vite 개발 모드에서 모듈이 다시 로드돼도 같은 인스턴스를 쓰도록 globalThis 에 둔다
const g = globalThis as { __grideltaHub?: AgentHub };
export const hub: AgentHub = (g.__grideltaHub ??= new AgentHub());
