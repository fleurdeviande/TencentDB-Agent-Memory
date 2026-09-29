/** Which backends the server builds, in collision-priority order (knowledge first: upstream names win). */

import type { PwConfig } from "./config.js";
import { createKnowledgeBackend } from "./knowledge-backend.js";
import { createMemoryBackend } from "./memory-backend.js";
import type { BackendFactory } from "./server.js";
import { loadPluginConfig } from "./upstream/memory.js";

export const knowledgeFactory: BackendFactory = async (config: PwConfig) =>
  config.knowledge ? createKnowledgeBackend({ url: config.knowledge.url, token: config.knowledge.token }) : undefined;

export const memoryFactory: BackendFactory = async (config: PwConfig) => {
  if (!config.memory) return undefined;
  const pluginConfig = loadPluginConfig(config.pluginEnv);
  const hasKnowledge = Boolean(config.knowledge);
  return createMemoryBackend(pluginConfig, { includeWiki: hasKnowledge, dropSuperseded: hasKnowledge });
};

export const DEFAULT_FACTORIES: BackendFactory[] = [knowledgeFactory, memoryFactory];
