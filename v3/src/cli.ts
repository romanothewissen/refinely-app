import path from 'node:path';
import { GeminiJsonGenerator, HeuristicGenerator } from './generator';
import { runV3Pipeline } from './pipeline';
import { GeminiFlashPlanner, HeuristicPlanner } from './planner';
import { loadEnvFallbacks } from './env';
import type { V3BacklogExample, V3Generator, V3Planner, V3WorkInstruction } from './contracts';
import fs from 'node:fs';

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function main() {
  loadEnvFallbacks();

  const requirement = argValue('--requirement');
  if (!requirement) {
    throw new Error('Missing --requirement "plain English requirement"');
  }

  const fixtureDir = path.resolve(argValue('--fixtures') ?? path.join(__dirname, '..', '..', 'fixtures'));
  const provider = argValue('--provider') ?? process.env.REFINELY_V3_PROVIDER ?? (process.env.GEMINI_API_KEY ? 'gemini' : 'heuristic');
  const workInstructions = readJson<V3WorkInstruction[]>(path.join(fixtureDir, 'work-instructions.json'));
  const backlogExamples = readJson<V3BacklogExample[]>(path.join(fixtureDir, 'backlog-examples.json'));
  let generator: V3Generator = new HeuristicGenerator();
  let planner: V3Planner = new HeuristicPlanner();

  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when --provider gemini is used.');
    const geminiOptions = {
      apiKey,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      baseUrl: process.env.GEMINI_BASE_URL,
      thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 4096),
    };
    planner = new GeminiFlashPlanner(geminiOptions);
    generator = new GeminiJsonGenerator(geminiOptions);
  }

  const result = await runV3Pipeline({
    requirement,
    workInstructions,
    backlogExamples,
    maxContextCards: Number(argValue('--max-context-cards') ?? 12),
  }, generator, planner);

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
