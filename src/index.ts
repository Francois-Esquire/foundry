import 'dotenv/config';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

import { FoundryLibrary } from './core';
import { OpenAIAgent } from './agents/openai-agent';

export * from './core';

const { OPENAI_API_KEY, ANTHROPIC_API_KEY } = process.env;

const agents = [];

if (!ANTHROPIC_API_KEY) {
  throw new Error('ANTHROPIC_API_KEY is not set');
} else {
  const claude = createAnthropic({
    apiKey: ANTHROPIC_API_KEY,
  });

  agents.push(['claude', claude]);
}

if (OPENAI_API_KEY) {
  const openai = createOpenAI({
    apiKey: OPENAI_API_KEY,
  });

  agents.push(['research', openai]);
}

export default new FoundryLibrary();
