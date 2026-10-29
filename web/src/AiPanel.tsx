import { type FlueConversationPart, useFlueAgent } from '@flue/react';
import type { AiSettings, Endpoint } from '@gridelta/proto/console';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { consoleClient } from './api.ts';
import { randomId } from './random.ts';

const POLICIES = [
  { value: 'dangerous', label: '위험 명령만 승인' },
  { value: 'always', label: '항상 승인' },
  { value: 'auto', label: '자동 실행' },
];

function conversationKey(endpointId: string) {
  return `gridelta.conversation.${endpointId}`;
}

/** PC 별 현재 대화 id. 새로고침해도 이어지도록 localStorage 에 둔다 (없거나 막혀 있으면 새로 만든다) */
function loadConversation(endpointId: string): string {
  try {
    const saved = localStorage.getItem(conversationKey(endpointId));
    if (saved) return saved;
    const id = randomId();
    localStorage.setItem(conversationKey(endpointId), id);
    return id;
  } catch {
    return randomId();
  }
}

/** 선택한 PC 를 조작하는 AI 대화 패널. Flue 인스턴스 id 는 `<endpoint_id>:<대화 id>` (설계 8.1) */
export function AiPanel({ endpoint }: { endpoint: Endpoint }) {
  const [conversation, setConversation] = useState(() => loadConversation(endpoint.id));
  useEffect(() => {
    setConversation(loadConversation(endpoint.id));
  }, [endpoint.id]);

  const agent = useFlueAgent({ url: `/agents/operator/${encodeURIComponent(`${endpoint.id}:${conversation}`)}` });
  const [draft, setDraft] = useState('');
  const [policy, setPolicy] = useState(endpoint.approvalPolicy || 'dangerous');
  useEffect(() => {
    setPolicy(endpoint.approvalPolicy || 'dangerous');
  }, [endpoint.approvalPolicy]);
  const [ai, setAi] = useState<AiSettings>();
  useEffect(() => {
    void consoleClient.getAiSettings({}).then(setAi, () => {});
  }, []);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [agent.messages]);

  const busy = agent.status === 'submitted' || agent.status === 'streaming';

  function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void agent.sendMessage(text).catch(() => {});
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  function newConversation() {
    const id = randomId();
    try {
      localStorage.setItem(conversationKey(endpoint.id), id);
    } catch {}
    setConversation(id);
  }

  async function changeModel(model: string) {
    try {
      setAi(await consoleClient.updateAiSettings({ model }));
    } catch {
      // 목록에 없는 모델이면 서버가 거부한다. 표시는 그대로 둔다
    }
  }

  async function changePolicy(value: string) {
    setPolicy(value);
    await consoleClient.setApprovalPolicy({ endpointId: endpoint.id, policy: value }).catch(() => setPolicy(policy));
  }

  return (
    <section aria-label="AI" className="flex min-h-0 flex-col border-line bg-panel md:w-[26rem] md:border-l max-md:h-[50dvh] max-md:border-t">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
        <h2 className="text-sm font-semibold">AI</h2>
        {ai && (
          <select
            aria-label="AI 모델"
            title="바꾸면 새 대화부터 적용됩니다"
            value={ai.model}
            onChange={(e) => void changeModel(e.target.value)}
            className="min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-xs"
          >
            {ai.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <select
          aria-label="승인 정책"
          value={policy}
          onChange={(e) => void changePolicy(e.target.value)}
          className="ml-auto rounded-md border border-line bg-bg px-2 py-1 text-xs"
        >
          {POLICIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={newConversation} className="text-xs text-muted hover:text-fg">
          새 대화
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm" data-testid="ai-messages">
        {agent.historyReady && agent.messages.length === 0 && (
          <p className="text-muted">{endpoint.hostname}에서 할 일을 말해 보세요. 예: 디스크 사용량이 큰 폴더 5개 알려줘</p>
        )}
        {agent.messages
          .filter((m) => m.display !== 'hidden')
          .map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''} data-role={m.role}>
              <div className={m.role === 'user' ? 'max-w-[85%] rounded-lg bg-accent-soft px-3 py-2' : 'w-full space-y-2'}>
                {m.parts.map((part, i) => (
                  <Part key={i} part={part} />
                ))}
              </div>
            </div>
          ))}
        {agent.error && agent.status === 'error' && (
          <p className="text-danger" role="alert">
            {agent.error.message}
          </p>
        )}
        <div ref={bottom} />
      </div>

      <div className="border-t border-line p-3">
        <div className="flex gap-2">
          <textarea
            aria-label="AI 에게 보낼 메시지"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={endpoint.online ? '무엇을 할까요?' : '이 PC는 오프라인입니다'}
            className="field resize-none"
          />
          <button type="button" onClick={send} disabled={!draft.trim()} className="btn-primary self-end">
            보내기
          </button>
        </div>
        <p className="mt-1 h-4 text-xs text-muted">{busy ? '작업 중…' : ''}</p>
      </div>
    </section>
  );
}

function toolOutputText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'content' in output && Array.isArray(output.content)) {
    return output.content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text : '')).join('');
  }
  return JSON.stringify(output, null, 2);
}

function Part({ part }: { part: FlueConversationPart }) {
  switch (part.type) {
    case 'text':
      return <p className="whitespace-pre-wrap break-words">{part.text}</p>;
    case 'reasoning':
      return (
        <details className="text-xs text-muted">
          <summary>생각</summary>
          <p className="whitespace-pre-wrap">{part.text}</p>
        </details>
      );
    case 'dynamic-tool': {
      const input = (part.input ?? {}) as { command?: string; path?: string };
      return (
        <div className="overflow-hidden rounded-md border border-line" data-testid="tool-call" data-tool={part.toolName} data-state={part.state}>
          <div className="flex items-center gap-2 bg-hover px-2 py-1 text-xs">
            <span className="font-mono font-medium">{part.toolName}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{input.command ?? input.path ?? ''}</span>
            <span className="text-muted">
              {part.state === 'input-available' ? '실행 중…' : part.state === 'output-error' ? '실패' : '완료'}
            </span>
          </div>
          {part.state === 'output-available' && (
            <pre className="max-h-48 overflow-auto bg-term p-2 text-xs text-slate-200">{toolOutputText(part.output)}</pre>
          )}
          {part.state === 'output-error' && <pre className="p-2 text-xs text-danger">{part.errorText}</pre>}
        </div>
      );
    }
    default:
      return null;
  }
}
