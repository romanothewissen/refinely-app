import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const editorHtmlPath = path.join(__dirname, 'model-strategy-editor.html');
const catalogPath = path.join(repoRoot, 'src', 'frontend', 'src', 'modelStrategyCatalog.json');
const port = Number(process.env.MODEL_STRATEGY_EDITOR_PORT || 4312);

function jsonResponse(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  });
  res.end(JSON.stringify(payload));
}

function textResponse(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type',
  });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function inferFamily(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase();
  if (normalized.includes('flash')) return 'flash';
  if (normalized.startsWith('gpt-4.1') || normalized.startsWith('gpt-4o') || normalized.startsWith('o4') || normalized.includes('sonnet')) {
    return normalized.includes('mini') ? 'lite' : 'flash';
  }
  if (normalized.includes('lite') || normalized.includes('mini') || normalized.includes('nano') || normalized.includes('haiku')) return 'lite';
  if (normalized.includes('pro') || normalized.includes('opus') || normalized.startsWith('gpt-5') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'pro';
  return undefined;
}

function toDisplayName(modelId) {
  return String(modelId || '')
    .replace(/^models\//, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isTextCapableGeminiModel(id) {
  const normalized = id.toLowerCase();
  return normalized.startsWith('gemini-')
    && !normalized.includes('image')
    && !normalized.includes('vision')
    && !normalized.includes('video')
    && !normalized.includes('veo')
    && !normalized.includes('tts')
    && !normalized.includes('speech')
    && !normalized.includes('audio')
    && !normalized.includes('embedding');
}

function isChatCapableOpenAiModel(id) {
  const normalized = id.toLowerCase();
  if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3') || normalized.startsWith('o4')) {
    return !normalized.includes('audio') && !normalized.includes('realtime') && !normalized.includes('transcribe');
  }
  return false;
}

async function discoverAnthropic({ apiKey, baseUrl }) {
  const key = (apiKey || process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) throw new Error('Missing Anthropic API key');
  const root = (baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${root}/models`, {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`Anthropic discovery failed with status ${res.status}`);
  return (payload.data || [])
    .filter((model) => model && model.id)
    .map((model) => ({
      id: String(model.id),
      displayName: model.display_name || toDisplayName(model.id),
      family: inferFamily(model.id),
    }));
}

async function discoverGemini({ apiKey, baseUrl }) {
  const key = (apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!key) throw new Error('Missing Gemini API key');
  const root = (baseUrl || process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  const res = await fetch(`${root}/models?key=${encodeURIComponent(key)}`);
  const payload = await res.json();
  if (!res.ok) throw new Error(`Gemini discovery failed with status ${res.status}`);
  return (payload.models || [])
    .filter((model) => (model.supportedGenerationMethods || []).includes('generateContent'))
    .map((model) => String(model.name || '').replace(/^models\//, ''))
    .filter((id) => id && isTextCapableGeminiModel(id))
    .map((id) => ({
      id,
      displayName: toDisplayName(id),
      family: inferFamily(id),
    }));
}

async function discoverOpenAI({ apiKey, baseUrl }) {
  const key = (apiKey || process.env.OPENAI_API_KEY || '').trim();
  if (!key) throw new Error('Missing OpenAI API key');
  const root = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${root}/models`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`OpenAI discovery failed with status ${res.status}`);
  return (payload.data || [])
    .filter((model) => model && model.id && isChatCapableOpenAiModel(model.id))
    .map((model) => ({
      id: String(model.id),
      displayName: toDisplayName(model.id),
      family: inferFamily(model.id),
    }));
}

async function discoverAzureOpenAI({ apiKey, baseUrl, apiVersion }) {
  const key = (apiKey || process.env.AZURE_OPENAI_API_KEY || '').trim();
  const endpoint = (baseUrl || process.env.AZURE_OPENAI_BASE_URL || process.env.AZURE_OPENAI_ENDPOINT || '').trim();
  const version = (apiVersion || process.env.AZURE_OPENAI_API_VERSION || '2024-06-01').trim();
  if (!key || !endpoint) throw new Error('Missing Azure OpenAI API key or endpoint');
  const res = await fetch(`${endpoint.replace(/\/+$/, '')}/openai/deployments?api-version=${encodeURIComponent(version)}`, {
    headers: { 'api-key': key },
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`Azure OpenAI discovery failed with status ${res.status}`);
  const items = payload.data || payload.value || [];
  return items
    .filter((deployment) => deployment && deployment.id)
    .map((deployment) => ({
      id: String(deployment.id),
      displayName: deployment.model ? `${deployment.id} (${deployment.model})` : String(deployment.id),
      family: inferFamily(deployment.model || deployment.id),
    }));
}

async function discoverModels(payload) {
  if (payload.provider === 'anthropic') return await discoverAnthropic(payload);
  if (payload.provider === 'gemini') return await discoverGemini(payload);
  if (payload.provider === 'openai') return await discoverOpenAI(payload);
  if (payload.provider === 'azure_openai') return await discoverAzureOpenAI(payload);
  throw new Error(`Unsupported provider: ${payload.provider}`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/') {
      const html = await readFile(editorHtmlPath, 'utf8');
      textResponse(res, 200, html, 'text/html; charset=utf-8');
      return;
    }

    if (req.method === 'GET' && req.url === '/api/catalog') {
      const raw = await readFile(catalogPath, 'utf8');
      jsonResponse(res, 200, JSON.parse(raw));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/catalog') {
      const payload = await readBody(req);
      await writeFile(catalogPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      jsonResponse(res, 200, { success: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/refresh-models') {
      const payload = await readBody(req);
      const catalog = await discoverModels(payload);
      jsonResponse(res, 200, { success: true, catalog });
      return;
    }

    textResponse(res, 404, 'Not found');
  } catch (error) {
    jsonResponse(res, 500, { success: false, error: error?.message || String(error) });
  }
});

server.listen(port, () => {
  console.log(`Model strategy editor available at http://localhost:${port}`);
});
