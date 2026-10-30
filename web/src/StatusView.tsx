import type { Endpoint, StateRecord } from '@gridelta/proto/console';
import { useCallback, useEffect, useState } from 'react';
import { consoleClient } from './api.ts';

const POLL_MS = 10_000;

function pretty(valueJson: string): string {
  try {
    const v: unknown = JSON.parse(valueJson);
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  } catch {
    return valueJson;
  }
}

function sourceLabel(source: string): string {
  if (source.startsWith('job:')) return '잡';
  if (source.startsWith('ai:')) return 'AI';
  return source;
}

/** PC 의 상태 기록: 이름별 최신 값, 이름을 누르면 이전 값들 (설계 14.9) */
export function StatusView({ endpoint, onError }: { endpoint: Endpoint; onError: (err: unknown) => void }) {
  const [latest, setLatest] = useState<StateRecord[]>([]);
  const [history, setHistory] = useState<{ name: string; records: StateRecord[] }>();

  const refresh = useCallback(async () => {
    try {
      setLatest((await consoleClient.listLatestRecords({ endpointId: endpoint.id })).records);
    } catch (err) {
      onError(err);
    }
  }, [endpoint.id, onError]);

  useEffect(() => {
    setHistory(undefined);
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function openHistory(name: string) {
    try {
      const res = await consoleClient.listRecords({ endpointId: endpoint.id, name, limit: 50 });
      setHistory({ name, records: res.records.filter((r) => r.name === name) });
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm" data-testid="status-view">
      {latest.length === 0 && (
        <p className="text-muted">아직 상태 기록이 없습니다. 스케줄 잡의 "출력을 상태로 저장" 이나 AI 가 기록을 남기면 여기에 보입니다.</p>
      )}
      {latest.length > 0 && (
        <table className="w-full text-left">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="py-2 pr-3">이름</th>
              <th className="py-2 pr-3">값</th>
              <th className="py-2 pr-3">기록 시각</th>
              <th className="py-2">출처</th>
            </tr>
          </thead>
          <tbody>
            {latest.map((r) => (
              <tr key={r.name} className="border-b border-line align-top last:border-0" data-record-name={r.name}>
                <td className="py-2 pr-3">
                  <button type="button" onClick={() => void openHistory(r.name)} className="font-mono text-accent hover:underline">
                    {r.name}
                  </button>
                </td>
                <td className="py-2 pr-3">
                  <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{pretty(r.valueJson)}</pre>
                </td>
                <td className="py-2 pr-3 whitespace-nowrap text-xs">{new Date(Number(r.recordedAtMs)).toLocaleString()}</td>
                <td className="py-2 text-xs text-muted">{sourceLabel(r.source)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {history && (
        <section aria-label={`${history.name} 이전 값`} className="mt-4">
          <h3 className="mb-1 text-xs font-semibold text-muted">
            {history.name} 이전 값 ({history.records.length}건, 최근 것부터)
          </h3>
          <ul className="divide-y divide-line rounded-md border border-line">
            {history.records.map((r, i) => (
              <li key={i} className="flex gap-3 px-3 py-1 text-xs">
                <span className="whitespace-nowrap text-muted">{new Date(Number(r.recordedAtMs)).toLocaleString()}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{pretty(r.valueJson).replaceAll('\n', ' ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
