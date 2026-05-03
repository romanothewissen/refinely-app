import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDir = join(root, 'src');
const publicDir = join(root, 'public');
const buildDir = join(root, 'build');

const postCssPlugin = {
  name: 'postcss-tailwind',
  setup(buildContext) {
    buildContext.onLoad({ filter: /\.css$/ }, async (args) => {
      const source = readFileSync(args.path, 'utf8');
      const processed = await postcss([tailwindcss(), autoprefixer()]).process(source, {
        from: args.path,
      });
      return {
        contents: processed.css,
        loader: 'css',
      };
    });
  },
};

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });

const result = await build({
  entryPoints: [join(srcDir, 'index.tsx')],
  outdir: buildDir,
  bundle: true,
  minify: true,
  sourcemap: false,
  splitting: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome114', 'safari16'],
  jsx: 'automatic',
  entryNames: 'static/js/[name]-[hash]',
  assetNames: 'static/media/[name]-[hash]',
  metafile: true,
  loader: {
    '.png': 'file',
    '.jpg': 'file',
    '.jpeg': 'file',
    '.svg': 'file',
    '.woff': 'file',
    '.woff2': 'file',
    '.ttf': 'file',
    '.eot': 'file',
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [postCssPlugin],
});

const outputs = Object.keys(result.metafile.outputs);
const jsOutput = outputs.find((output) => output.endsWith('.js'));
const cssOutput = outputs.find((output) => output.endsWith('.css'));

if (!jsOutput) {
  throw new Error('esbuild did not emit a JS bundle.');
}

const htmlTemplate = readFileSync(join(publicDir, 'index.html'), 'utf8');
const scriptPath = relative(buildDir, jsOutput).replace(/\\/g, '/');
const cssTag = cssOutput
  ? `    <link rel="stylesheet" href="${relative(buildDir, cssOutput).replace(/\\/g, '/')}">`
  : '';

const html = htmlTemplate
  .replace('</head>', `${cssTag ? `${cssTag}\n` : ''}  </head>`)
  .replace('</body>', `    <script src="${scriptPath}"></script>\n  </body>`);

writeFileSync(join(buildDir, 'index.html'), html, 'utf8');

if (existsSync(join(publicDir, 'logo.png'))) {
  cpSync(join(publicDir, 'logo.png'), join(buildDir, 'logo.png'));
}

const assetManifest = {
  files: {
    'main.js': scriptPath,
    ...(cssOutput ? { 'main.css': relative(buildDir, cssOutput).replace(/\\/g, '/') } : {}),
    'index.html': 'index.html',
    'logo.png': 'logo.png',
  },
  entrypoints: [
    ...(cssOutput ? [relative(buildDir, cssOutput).replace(/\\/g, '/')] : []),
    scriptPath,
  ],
};

writeFileSync(join(buildDir, 'asset-manifest.json'), JSON.stringify(assetManifest, null, 2), 'utf8');
