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
 * 통합 대화: "모든 PC" → list_pcs → 온라인 PC 마다 run_command hostname, "통합 삭제" → 승인이 필요한 run_command.
 */
export function registerFauxProvider(): void {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted', name: 'Scripted (test)' }] });
  const respond: FauxResponseFactory = (context) => {
    const msgs = context.messages;
    const lastAssistant = msgs.findLastIndex((m) => m.role === 'assistant');
    const results = msgs.slice(lastAssistant + 1).filter((m) => m.role === 'toolResult');
    const tool = (name: string, args: Record<string, string>) => fauxToolCall(name, args);
    const textOf = (m: (typeof msgs)[number]) =>
      m.role === 'toolResult' ? m.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '';

    if (results.length > 0) {
      // 통합 대화: PC 목록을 받으면 온라인인 PC 마다 hostname 을 실행한다
      const list = results.find((r) => r.role === 'toolResult' && r.toolName === 'list_pcs');
      if (list) {
        // Flue 가 도구의 문자열 결과를 JSON 문자열로 한 번 더 감싸 넘길 수 있다
        let parsed: unknown = JSON.parse(textOf(list));
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        const pcs = parsed as { id: string; online: boolean }[];
        const calls = pcs.filter((p) => p.online).map((p) => tool('run_command', { pc: p.id, command: 'hostname' }));
        return fauxAssistantMessage(calls, { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(`도구 결과입니다.\n${results.map(textOf).join('\n')}`);
    }

    const user = [...msgs].reverse().find((m) => m.role === 'user');
    const said = typeof user?.content === 'string' ? user.content : (user?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '');
    const call = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(tool(name, args), { stopReason: 'toolUse' });
    if (said.includes('모든 PC')) return call('list_pcs', {});
    if (said.includes('통합 삭제')) return call('run_command', { pc: 'agent-debian', command: 'rm -rf /tmp/gridelta-ai-test2' });
    if (said.includes('디스크')) return call('bash', { command: 'du -sh /usr/* 2>/dev/null | sort -rh | head -5' });
    if (said.includes('지워')) return call('bash', { command: 'rm -rf /tmp/gridelta-ai-test' });
    if (said.includes('파일')) return call('write', { path: '/tmp/gridelta-ai.txt', content: 'written by ai\n' });
    return fauxAssistantMessage('무엇을 도와드릴까요?');
  };
  // 응답 목록을 차례로 소비하므로 같은 함수를 넉넉히 넣어 둔다
  faux.setResponses(Array.from({ length: 100_000 }, () => respond));
  setProvider(faux.provider);
}
