import { type FlueConversationPart, useFlueAgent } from '@flue/react';
import type { AiSession, AiSettings, Endpoint } from '@gridelta/proto/console';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { consoleClient } from './api.ts';
import { ApprovalCard, useApprovals } from './Approvals.tsx';
import { NameInput } from './NameInput.tsx';

const ALL_PCS = 'all';
const POLICIES = [
  { value: 'dangerous', label: '위험 명령만 승인' },
  { value: 'always', label: '항상 승인' },
  { value: 'auto', label: '자동 실행' },
];

/** PC 별(또는 PC 를 고르지 않았을 때) 마지막으로 본 세션. 없거나 막혀 있으면 가장 최근 세션을 연다 */
function lastSessionKey(endpointId: string | undefined) {
  return `gridelta.aiSession.${endpointId ?? ALL_PCS}`;
}
function loadLastSession(endpointId: string | undefined): string {
  try {
    return localStorage.getItem(lastSessionKey(endpointId)) ?? '';
  } catch {
    return '';
  }
}
function saveLastSession(endpointId: string | undefined, id: string) {
  try {
    localStorage.setItem(lastSessionKey(endpointId), id);
  } catch {}
}

function sessionLabel(s: AiSession, endpointName: (id: string) => string): string {
  const scope = s.scope === ALL_PCS ? '통합' : endpointName(s.scope);
  const title = s.title || `새 대화 · ${new Date(Number(s.createdAtMs)).toLocaleString()}`;
  return `[${scope}] ${title}`;
}

interface Props {
  /** 선택한 PC. 없으면 통합 대화만 쓸 수 있다 */
  endpoint: Endpoint | undefined;
  endpointName: (id: string) => string;
  /** 이 세션을 연다 (스케줄 회차 기록의 "대화 보기"). n 은 같은 세션을 다시 열 때도 바뀌게 하는 값 */
  request?: { id: string; n: number };
}

/**
 * AI 대화 패널. 대화는 세션으로 저장된다: 통합(여러 PC) 세션과 PC 세션.
 * 세션 목록·이름은 서버 DB, 대화 내용은 Flue(flue.db) 에 남는다.
 */
export function AiPanel({ endpoint, endpointName, request }: Props) {
  const [sessions, setSessions] = useState<AiSession[]>([]);
  const [currentId, setCurrentId] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [pending, setPending] = useState(''); // 세션을 만든 직후 보낼 메시지
  /** "+ 이 PC" / "+ 통합" 으로 고른 새 대화의 대상. 세션은 첫 메시지를 보낼 때 만든다 (빈 세션이 쌓이지 않게) */
  const [draftScope, setDraftScope] = useState<string>();
  const [draft, setDraft] = useState('');
  const [ai, setAi] = useState<AiSettings>();
  const [policy, setPolicy] = useState(endpoint?.approvalPolicy || 'dangerous');
  const bottom = useRef<HTMLDivElement>(null);
  const current = sessions.find((s) => s.id === currentId);
  const endpointId = endpoint?.id;

  const refresh = useCallback(async () => {
    const res = await consoleClient.listAiSessions({ endpointId: endpointId ?? '' });
    // PC 를 고르지 않았으면 통합 세션만 보인다
    const list = endpointId ? res.sessions : res.sessions.filter((s) => s.scope === ALL_PCS);
    setSessions(list);
    return list;
  }, [endpointId]);

  useEffect(() => {
    void refresh().then(
      (list) => {
        const last = loadLastSession(endpointId);
        setCurrentId(list.some((s) => s.id === last) ? last : (list[0]?.id ?? ''));
        setDraftScope(undefined);
      },
      () => {},
    );
  }, [refresh, endpointId]);

  useEffect(() => {
    void consoleClient.getAiSettings({}).then(setAi, () => {});
  }, []);
  useEffect(() => {
    setPolicy(endpoint?.approvalPolicy || 'dangerous');
  }, [endpoint?.approvalPolicy]);

  // 요청받은 세션을 마지막 세션으로 남겨 두면 PC 가 바뀌며 목록을 다시 읽을 때도 그 세션을 연다
  useEffect(() => {
    if (!request) return;
    saveLastSession(endpointId, request.id);
    void refresh().then(
      (list) => {
        if (list.some((s) => s.id === request.id)) {
          setCurrentId(request.id);
          setDraftScope(undefined);
        }
      },
      () => {},
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const agent = useFlueAgent({ url: current?.agentUrl });
  // 이 대화가 요청한 승인은 대화 안에도 카드로 띄운다 (설계 14.4)
  const { pending: approvals } = useApprovals();
  const instanceId = current ? (current.scope === ALL_PCS ? current.id : `${current.scope}:${current.id}`) : '';
  const chatApprovals = approvals.filter((a) => instanceId && a.conversationId === instanceId);
  /** 스케줄 AI 잡 회차의 대화는 기록으로만 본다 */
  const scheduled = !!current?.jobRunId;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [agent.messages]);

  function select(id: string) {
    setCurrentId(id);
    setDraftScope(undefined);
    saveLastSession(endpointId, id);
  }

  function startNew(scope: string) {
    setCurrentId('');
    setDraftScope(scope);
  }

  async function createSession(scope: string): Promise<AiSession> {
    const s = await consoleClient.createAiSession({ scope });
    setSessions((prev) => [s, ...prev]);
    select(s.id);
    return s;
  }

  // 세션이 열려 대화 기록을 받은 뒤에 대기 중인 첫 메시지를 보낸다
  const { historyReady, sendMessage } = agent;
  useEffect(() => {
    if (!pending || !current || !historyReady) return;
    const text = pending;
    setPending('');
    void sendMessage(text).catch(() => {});
  }, [pending, current, historyReady, sendMessage]);

  async function send() {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    let session = current;
    if (!session) {
      // 새 대화: 고른 대상, 없으면 PC 를 골랐으면 그 PC, 아니면 통합 대화로 세션을 만든다
      setPending(text);
      session = await createSession(draftScope ?? endpointId ?? ALL_PCS);
    } else {
      void sendMessage(text).catch(() => {});
    }
    // 첫 메시지를 세션 이름으로 쓴다
    if (!session.title) {
      const title = text.slice(0, 40);
      const id = session.id;
      await consoleClient.renameAiSession({ id, title }).catch(() => {});
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title } : s)));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  async function rename(title: string) {
    setRenaming(false);
    if (!current) return;
    await consoleClient.renameAiSession({ id: current.id, title }).catch(() => {});
    setSessions((prev) => prev.map((s) => (s.id === current.id ? { ...s, title } : s)));
  }

  async function remove() {
    if (!current || !confirm(`"${sessionLabel(current, endpointName)}" 대화를 목록에서 지울까요?`)) return;
    await consoleClient.deleteAiSession({ id: current.id }).catch(() => {});
    const rest = sessions.filter((s) => s.id !== current.id);
    setSessions(rest);
    select(rest[0]?.id ?? '');
  }

  async function changeModel(model: string) {
    try {
      setAi(await consoleClient.updateAiSettings({ model }));
    } catch {
      // 목록에 없는 모델이면 서버가 거부한다
    }
  }

  async function changePolicy(value: string) {
    if (!endpoint) return;
    const before = policy;
    setPolicy(value);
    await consoleClient.setApprovalPolicy({ endpointId: endpoint.id, policy: value }).catch(() => setPolicy(before));
  }

  const busy = agent.status === 'submitted' || agent.status === 'streaming' || !!pending;
  const scope = current?.scope ?? draftScope;
  const scopeLabel = scope ? (scope === ALL_PCS ? '모든 PC' : endpointName(scope)) : '';

  return (
    <section aria-label="AI" className="flex min-h-0 flex-col border-line bg-panel md:w-[26rem] md:border-l max-md:h-[50dvh] max-md:border-t">
      <header className="space-y-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-1">
          {renaming && current ? (
            <NameInput value={current.title} placeholder="대화 이름" label="대화 이름" onSave={(t) => void rename(t)} onCancel={() => setRenaming(false)} />
          ) : (
            <select
              aria-label="AI 대화"
              value={currentId}
              onChange={(e) => select(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-line bg-bg px-2 py-1 text-xs"
            >
              {!current && <option value="">{scopeLabel ? `새 대화 (${scopeLabel})` : '새 대화'}</option>}
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {sessionLabel(s, endpointName)}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            aria-label="대화 이름 바꾸기"
            disabled={!current}
            onClick={() => setRenaming(true)}
            className="px-1 text-muted hover:text-fg disabled:opacity-40"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label="대화 지우기"
            disabled={!current}
            onClick={() => void remove()}
            className="px-1 text-muted hover:text-fg disabled:opacity-40"
          >
            🗑
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {endpoint && (
            <button type="button" onClick={() => startNew(endpoint.id)} className="text-xs text-accent">
              + 이 PC
            </button>
          )}
          <button type="button" onClick={() => startNew(ALL_PCS)} className="text-xs text-accent">
            + 통합
          </button>
          {ai && (
            <select
              aria-label="AI 모델"
              title="바꾸면 새 대화부터 적용됩니다"
              value={ai.model}
              onChange={(e) => void changeModel(e.target.value)}
              className="ml-auto min-w-0 rounded-md border border-line bg-bg px-2 py-1 text-xs"
            >
              {ai.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          )}
          {endpoint && (
            <select
              aria-label="승인 정책"
              title={`${endpointName(endpoint.id)} 의 승인 정책`}
              value={policy}
              onChange={(e) => void changePolicy(e.target.value)}
              className="rounded-md border border-line bg-bg px-2 py-1 text-xs"
            >
              {POLICIES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm" data-testid="ai-messages">
        {scopeLabel && (
          <p className="text-xs text-muted" data-testid="ai-scope">
            대상: {scopeLabel}
          </p>
        )}
        {(!current || (agent.historyReady && agent.messages.length === 0)) && !pending && (
          <p className="text-muted">
            {endpoint
              ? `${endpointName(endpoint.id)}에서 할 일을 말해 보세요. 여러 PC 를 함께 다루려면 "+ 통합" 으로 새 대화를 여세요.`
              : '여러 PC 에 걸친 일을 말해 보세요. 예: 모든 PC 의 디스크 사용량을 비교해줘'}
          </p>
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
        {chatApprovals.map((a) => (
          <ApprovalCard key={a.id} approval={a} testId="chat-approval" />
        ))}
        {agent.error && agent.status === 'error' && (
          <p className="text-danger" role="alert">
            {agent.error.message}
          </p>
        )}
        <div ref={bottom} />
      </div>

      {scheduled ? (
        <p className="border-t border-line p-3 text-xs text-muted" data-testid="ai-scheduled">
          스케줄 잡 회차의 대화입니다. 사람이 지켜보지 않는 실행이라 위험 명령은 실행되지 않으며, 기록으로만 볼 수 있습니다.
        </p>
      ) : (
        <div className="border-t border-line p-3">
          <div className="flex gap-2">
            <textarea
              aria-label="AI 에게 보낼 메시지"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder="무엇을 할까요?"
              className="field resize-none"
            />
            <button type="button" onClick={() => void send()} disabled={!draft.trim()} className="btn-primary self-end">
              보내기
            </button>
          </div>
          <p className="mt-1 h-4 text-xs text-muted">{busy ? '작업 중…' : ''}</p>
        </div>
      )}
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
      const input = (part.input ?? {}) as { command?: string; path?: string; pc?: string; name?: string; job?: string };
      const target = [input.pc && `[${input.pc.slice(0, 13)}]`, input.command ?? input.path ?? input.job ?? input.name].filter(Boolean).join(' ');
      return (
        <div className="overflow-hidden rounded-md border border-line" data-testid="tool-call" data-tool={part.toolName} data-state={part.state}>
          <div className="flex items-center gap-2 bg-hover px-2 py-1 text-xs">
            <span className="font-mono font-medium">{part.toolName}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-muted">{target}</span>
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
