import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadEnvFallbacks } from './env';
import { GeminiJsonGenerator, HeuristicGenerator } from './generator';
import { GeminiFlashPlanner, HeuristicPlanner } from './planner';
import { runV3Pipeline } from './pipeline';
import { scoreV3Result, type V3JsaBenchmark } from './scoring';
import type { V3BacklogExample, V3Generator, V3Planner, V3WorkInstruction } from './contracts';

type RunRequest = {
  requirement?: string;
  provider?: string;
  maxContextCards?: number;
  jsaText?: string;
};

const rootDir = path.resolve(__dirname, '..', '..');
const publicDir = path.join(rootDir, 'public');
const fixturesDir = path.join(rootDir, 'fixtures');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function sendJson(response: http.ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStatic(response: http.ServerResponse, filePath: string) {
  if (!fs.existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const contentType = ext === '.css' ? 'text/css' : ext === '.js' ? 'text/javascript' : 'text/html';
  response.writeHead(200, { 'Content-Type': contentType });
  response.end(fs.readFileSync(filePath));
}

async function readBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) as T : {} as T;
}

function buildEngines(provider: string): { planner: V3Planner; generator: V3Generator } {
  if (provider === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is required for Gemini runs. Add it to v3/.env.');
    const geminiOptions = {
      apiKey,
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      baseUrl: process.env.GEMINI_BASE_URL,
      thinkingBudget: Number(process.env.GEMINI_THINKING_BUDGET ?? 4096),
    };
    return {
      planner: new GeminiFlashPlanner(geminiOptions),
      generator: new GeminiJsonGenerator(geminiOptions),
    };
  }

  return {
    planner: new HeuristicPlanner(),
    generator: new HeuristicGenerator(),
  };
}

function readJsaBenchmarks(): V3JsaBenchmark[] {
  const filePath = path.join(fixturesDir, 'jsa-benchmarks.json');
  if (!fs.existsSync(filePath)) return [];
  return readJson<V3JsaBenchmark[]>(filePath);
}

function findMatchingBenchmark(requirement: string, benchmarks: V3JsaBenchmark[]): V3JsaBenchmark | undefined {
  const normalizedRequirement = requirement.toLowerCase();
  return benchmarks.find((benchmark) =>
    (benchmark.requirementIncludes ?? []).every((term) => normalizedRequirement.includes(term.toLowerCase())));
}

async function handleRun(request: http.IncomingMessage, response: http.ServerResponse) {
  const body = await readBody<RunRequest>(request);
  const requirement = body.requirement?.trim();
  if (!requirement) {
    sendJson(response, 400, { error: 'Requirement is required.' });
    return;
  }

  const provider = body.provider || (process.env.GEMINI_API_KEY ? 'gemini' : 'heuristic');
  const workInstructions = readJson<V3WorkInstruction[]>(path.join(fixturesDir, 'work-instructions.json'));
  const backlogExamples = readJson<V3BacklogExample[]>(path.join(fixturesDir, 'backlog-examples.json'));
  const benchmark = findMatchingBenchmark(requirement, readJsaBenchmarks());
  const { planner, generator } = buildEngines(provider);
  const result = await runV3Pipeline({
    requirement,
    workInstructions,
    backlogExamples,
    maxContextCards: body.maxContextCards ?? 12,
  }, generator, planner);
  const score = scoreV3Result(result, body.jsaText || benchmark?.jsaText, benchmark);

  sendJson(response, 200, { result, score });
}

async function route(request: http.IncomingMessage, response: http.ServerResponse) {
  try {
    if (request.method === 'POST' && request.url === '/api/run') {
      await handleRun(request, response);
      return;
    }

    const url = request.url === '/' ? '/index.html' : request.url || '/index.html';
    sendStatic(response, path.join(publicDir, path.normalize(url).replace(/^(\.\.[/\\])+/, '')));
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : 'Unknown V3 server error',
    });
  }
}

loadEnvFallbacks();

const port = Number(process.env.V3_PORT ?? 4177);
const server = http.createServer(route);
server.listen(port, '127.0.0.1', () => {
  console.log(`Refinely V3 POC UI running at http://127.0.0.1:${port}`);
});
