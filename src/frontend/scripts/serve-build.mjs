import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const buildDir = normalize(join(__dirname, '..', 'build'));
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.map', 'application/json; charset=utf-8'],
]);

async function readAsset(requestPath) {
  const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const absolutePath = join(buildDir, safePath);

  try {
    const fileStats = await stat(absolutePath);
    if (fileStats.isDirectory()) return null;
    const body = await readFile(absolutePath);
    return { body, contentType: contentTypes.get(extname(absolutePath)) || 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${host}:${port}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  const asset = await readAsset(pathname);
  const isAssetRequest = extname(pathname) !== '';
  const fallback = !isAssetRequest && pathname !== '/index.html' ? await readAsset('/index.html') : null;
  const response = asset || fallback;

  if (!response) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, { 'Content-Type': response.contentType });
  res.end(response.body);
});

server.listen(port, host, () => {
  console.log(`Serving ${buildDir} on http://${host}:${port}`);
});
