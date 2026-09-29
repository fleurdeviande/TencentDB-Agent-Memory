/**
 * Hook entry: the #1268 plugin's `handleHook` (UserPromptSubmit recall, Stop / SessionEnd capture),
 * fed from the pw-memory config instead of the plugin's own env names.
 *
 * Prompt caching: recall reaches the model only as `hookSpecificOutput.additionalContext`, which Claude
 * Code attaches to that turn's user message — the system prompt and every earlier turn stay untouched.
 * The stable block (persona, scene index, tool guide) is sent on the first prompt of a session only;
 * later prompts carry just `<relevant-memories>` for that prompt.
 */

import type { PwConfig } from "./config.js";
import { loadPwConfig } from "./config.js";
import type { Log } from "./log.js";
import {
  createMemoryClient,
  handleHook,
  loadPluginConfig,
  MEMORY_TOOLS_GUIDE,
  PluginState,
  type HookInput,
  type HookOutput,
} from "./upstream/memory.js";

const PLUGIN_WIKI_LINE = "- tdai_wiki_search / tdai_wiki_read: the team wiki, when a Knowledge Service is configured.";
const PW_KNOWLEDGE_LINE =
  "- wiki_search / wiki_read: the team wiki; code_search / code_explore / code_callers: the indexed code graphs.";

/** The plugin's guide names the wiki tools this server replaces with MemoryKnowledge's; same text every time. */
export const PW_TOOLS_GUIDE = MEMORY_TOOLS_GUIDE.replace(PLUGIN_WIKI_LINE, PW_KNOWLEDGE_LINE);

export function rewriteGuide(output: HookOutput, config: PwConfig): HookOutput {
  if (!config.knowledge) return output;
  const specific = output.hookSpecificOutput as { additionalContext?: unknown } | undefined;
  if (!specific || typeof specific.additionalContext !== "string") return output;
  return {
    ...output,
    hookSpecificOutput: { ...specific, additionalContext: specific.additionalContext.replace(MEMORY_TOOLS_GUIDE, PW_TOOLS_GUIDE) },
  };
}

export interface HookRunOptions {
  env?: NodeJS.ProcessEnv;
  log: Log;
  /** Tests point this at a temp dir; Claude Code's own default otherwise. */
  claudeConfigDir?: string;
}

/** Returns the JSON line for stdout. Fails open with `{}` on every error. */
export async function runHook(stdin: string, options: HookRunOptions): Promise<string> {
  try {
    const config = loadPwConfig(options.env ?? process.env);
    if (!config.memory) return "{}";
    const input = JSON.parse(stdin) as HookInput;
    const pluginConfig = loadPluginConfig(config.pluginEnv);
    const output = await handleHook(input, {
      config: pluginConfig,
      state: new PluginState(pluginConfig.stateDir),
      recallClient: createMemoryClient(pluginConfig, pluginConfig.recallTimeoutMs),
      captureClient: createMemoryClient(pluginConfig, pluginConfig.captureTimeoutMs),
      log: options.log,
      claudeConfigDir: options.claudeConfigDir,
    });
    return JSON.stringify(rewriteGuide(output, config));
  } catch (error) {
    options.log(`hook failed open: ${error instanceof Error ? error.message : String(error)}`);
    return "{}";
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}
