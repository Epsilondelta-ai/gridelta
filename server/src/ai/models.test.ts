import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from '../store/db.ts';
import { Store } from '../store/store.ts';
import { AiModels, UnknownModelError } from './models.ts';

const newStore = () => new Store(openDb(':memory:', resolve(import.meta.dirname, '../../drizzle')));

describe('AiModels', () => {
  it('lists codex models, persists the choice and restores it', async () => {
    const store = newStore();
    const models = new AiModels(store, 'openai-codex/gpt-5.6-sol', false);
    await models.load();
    expect(models.current()).toBe('openai-codex/gpt-5.6-sol');
    const ids = (await models.list()).map((m) => m.id);
    expect(ids).toContain('openai-codex/gpt-5.6-sol');

    const other = ids.find((id) => id !== 'openai-codex/gpt-5.6-sol')!;
    await models.set(other);
    const reloaded = new AiModels(store, 'openai-codex/gpt-5.6-sol', false);
    await reloaded.load();
    expect(reloaded.current()).toBe(other);
  });

  it('rejects models that are not in the list', async () => {
    const models = new AiModels(newStore(), 'openai-codex/gpt-5.6-sol', false);
    await expect(models.set('openai-codex/nope')).rejects.toBeInstanceOf(UnknownModelError);
  });

  it('uses only the scripted model in faux mode', async () => {
    const models = new AiModels(newStore(), 'openai-codex/gpt-5.6-sol', true);
    await models.load();
    expect(models.current()).toBe('faux/scripted');
    expect((await models.list()).map((m) => m.id)).toEqual(['faux/scripted']);
  });
});
