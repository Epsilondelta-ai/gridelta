import {
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai/providers/faux';
import { setProvider } from '@flue/runtime';

/** e2e 테스트용 모델 id. GRIDELTA_AI_FAUX=1 이면 이 모델을 쓴다. */
export const FAUX_MODEL = 'faux/scripted';

/**
 * 실제 LLM 없이 Flue → 샌드박스 → 에이전트 → 승인 흐름을 확인하기 위한 정해진 응답 모델.
 * 사용자 메시지의 키워드로 도구 호출을 고르고, 도구 결과를 받으면 그 내용을 그대로 답한다.
 */
export function registerFauxProvider(): void {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted', name: 'Scripted (test)' }] });
  const respond: FauxResponseFactory = (context) => {
    const last = context.messages.at(-1);
    if (last?.role === 'toolResult') {
      const text = last.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      return fauxAssistantMessage(`도구 결과입니다.\n${text}`);
    }
    const user = [...context.messages].reverse().find((m) => m.role === 'user');
    const said = typeof user?.content === 'string' ? user.content : (user?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '');
    const tool = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    if (said.includes('디스크')) return tool('bash', { command: 'du -sh /usr/* 2>/dev/null | sort -rh | head -5' });
    if (said.includes('지워')) return tool('bash', { command: 'rm -rf /tmp/gridelta-ai-test' });
    if (said.includes('파일')) return tool('write', { path: '/tmp/gridelta-ai.txt', content: 'written by ai\n' });
    return fauxAssistantMessage('무엇을 도와드릴까요?');
  };
  // 응답 목록을 차례로 소비하므로 같은 함수를 넉넉히 넣어 둔다
  faux.setResponses(Array.from({ length: 100_000 }, () => respond));
  setProvider(faux.provider);
}
