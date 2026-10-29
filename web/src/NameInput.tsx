import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

interface Props {
  /** 지금 이름 (사용자가 붙인 이름이 없으면 빈 문자열) */
  value: string;
  /** 비워 두면 돌아갈 기본 이름 */
  placeholder: string;
  label: string;
  onSave: (name: string) => void;
  onCancel: () => void;
}

/** 이름 편집 입력칸. Enter 저장, Esc 취소, 포커스를 잃으면 저장. 비우면 기본 이름으로 돌아간다 */
export function NameInput({ value, placeholder, label, onSave, onCancel }: Props) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  function finish(save: boolean) {
    if (done.current) return;
    done.current = true;
    if (save && draft.trim() !== value) onSave(draft.trim());
    else onCancel();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    // 한글 조합 중의 Enter 는 글자를 확정하는 키이므로 저장하지 않는다
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  }

  return (
    <input
      ref={input}
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      maxLength={64}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      className="w-full min-w-24 rounded border border-accent bg-bg px-1 py-0.5 text-sm text-fg outline-none"
    />
  );
}
