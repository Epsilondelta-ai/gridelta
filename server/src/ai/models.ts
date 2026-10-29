import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import type { Store } from '../store/index.ts';
import { FAUX_MODEL } from './faux.ts';

const SETTING_KEY = 'ai.model';

export interface ModelChoice {
  id: string;
  name: string;
}

export class UnknownModelError extends Error {}

/**
 * 서버가 쓰는 AI 모델. Flue 에이전트 함수는 동기라서 현재 값을 메모리에 들고 있고, 바꾸면 settings 에 저장한다.
 * 기본값은 GRIDELTA_AI_MODEL (설계 8.3: openai-codex/gpt-5.6-sol).
 */
export class AiModels {
  #current: string;

  constructor(
    private readonly store: Store,
    private readonly defaultModel: string,
    private readonly faux: boolean,
  ) {
    this.#current = faux ? FAUX_MODEL : defaultModel;
  }

  /** 저장된 선택을 읽어 온다. 서버 시작 시 한 번 부른다 */
  async load(): Promise<void> {
    if (this.faux) return;
    this.#current = (await this.store.getSetting(SETTING_KEY)) ?? this.defaultModel;
  }

  current(): string {
    return this.#current;
  }

  async list(): Promise<ModelChoice[]> {
    if (this.faux) return [{ id: FAUX_MODEL, name: 'Scripted (test)' }];
    const models: ModelChoice[] = [];
    if (this.defaultModel.startsWith('openai-codex/') || this.#current.startsWith('openai-codex/')) {
      for (const m of await openaiCodexProvider().getModels()) models.push({ id: `openai-codex/${m.id}`, name: m.name });
    }
    // 목록에 없는 모델(환경변수로 지정한 openai/... 등)도 현재 값이면 보여 준다
    if (!models.some((m) => m.id === this.#current)) models.unshift({ id: this.#current, name: this.#current });
    return models;
  }

  async set(model: string): Promise<void> {
    if (!(await this.list()).some((m) => m.id === model)) throw new UnknownModelError(`unknown model ${model}`);
    await this.store.setSetting(SETTING_KEY, model);
    this.#current = model;
  }
}
