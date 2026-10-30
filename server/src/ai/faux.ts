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
 * 잡: "점검 잡" → 바로 켜지는 명령 잡, "정리 잡" → rm 이 들어 있어 승인이 필요한 잡, "AI 잡" → 10초마다 도는 AI 잡,
 * "기록 조회" → query_records. AI 잡 회차("커널 버전을 기록")는 uname 과 rm 을 실행하고 커널 버전을 record_value 로 남긴다.
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

    const user = [...msgs].reverse().find((m) => m.role === 'user');
    const said = typeof user?.content === 'string' ? user.content : (user?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? '');

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
      // 스케줄 AI 잡: uname 결과의 커널 버전을 상태로 기록한다
      const uname = results.find((r) => r.role === 'toolResult' && r.toolName === 'bash' && /\d+\.\d+/.test(textOf(r)));
      if (said.includes('커널 버전을 기록') && uname && !results.some((r) => r.role === 'toolResult' && r.toolName === 'record_value')) {
        const version = /\d+\.\d+[\w.+-]*/.exec(textOf(uname))![0];
        return fauxAssistantMessage(tool('record_value', { name: 'kernel.ai', value: JSON.stringify(version) }), { stopReason: 'toolUse' });
      }
      return fauxAssistantMessage(`도구 결과입니다.\n${results.map(textOf).join('\n')}`);
    }

    const call = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(tool(name, args), { stopReason: 'toolUse' });
    // 잡 도구 (M8)
    if (said.includes('점검 잡')) {
      return call('create_job', {
        name: '루트 점검',
        kind: 'command',
        target_group: 'default',
        cron: '*/10 * * * * *',
        command_unix: 'df -P / | tail -1',
        record_name: 'disk.root',
        record_parse: 'text',
      });
    }
    if (said.includes('정리 잡')) {
      return call('create_job', {
        name: '임시 정리',
        kind: 'command',
        target_group: 'default',
        cron: '0 3 * * *',
        timezone: 'Asia/Seoul',
        command_unix: 'rm -rf /tmp/gridelta-cleanup-test',
      });
    }
    if (said.includes('AI 잡')) {
      return call('create_job', {
        name: '커널 AI',
        kind: 'ai',
        target_pc: 'agent-debian',
        cron: '*/10 * * * * *',
        ai_prompt: '커널 버전을 기록하고 임시 폴더도 비워줘',
      });
    }
    if (said.includes('기록 조회')) return call('query_records', { pc: 'agent-debian', name: 'kernel' });
    // 스케줄 AI 잡 회차: 커널 버전 확인과 위험 명령(스케줄 실행에서는 거부됨)을 함께 시도한다
    if (said.includes('커널 버전을 기록')) {
      return fauxAssistantMessage([tool('bash', { command: 'uname -r' }), tool('bash', { command: 'rm -rf /tmp/gridelta-sched-test' })], {
        stopReason: 'toolUse',
      });
    }
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
