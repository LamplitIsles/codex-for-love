import { readFile } from 'node:fs/promises';
import type { Config } from './config.ts';
import { companionPrompt, compactionPrompt } from './prompts.ts';

/** Load the selected base and compaction instructions once per startup or import. */
export async function loadPrompts(config: Pick<Config, 'prompts' | 'codex'>): Promise<{ companion: string; compaction: string }> {
  if (config.prompts?.compaction && !config.codex.local_compaction) {
    throw new Error('prompts.compaction requires codex.local_compaction = true');
  }
  const load = async (path: string | undefined, name: string, fallback: string) => {
    if (!path) return fallback;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(path));
    } catch (error) {
      throw new Error(`Cannot read prompts.${name} as UTF-8 from ${path}`, { cause: error });
    }
    if (!text.trim()) throw new Error(`prompts.${name} file is empty: ${path}`);
    return text;
  };
  return {
    companion: await load(config.prompts?.companion, 'companion', companionPrompt),
    compaction: await load(config.prompts?.compaction, 'compaction', compactionPrompt),
  };
}
