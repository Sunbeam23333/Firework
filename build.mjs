import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
for (const file of ['index.html', 'style.css', 'app.js', 'store.js', 'sync.js']) await cp(file, `dist/client/${file}`);
await cp('assets', 'dist/client/assets', { recursive: true });
await writeFile('dist/client/.nojekyll', '');
// Both modules are dependency-free ES modules; inline the shared validation module.
const worker = (await readFile('backend/worker.js', 'utf8')).replace("import { createState, exportState } from '../store.js';", await readFile('store.js', 'utf8'));
await writeFile('dist/server/index.js', worker);
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('drizzle', 'dist/drizzle', { recursive: true });
const html = await readFile('dist/client/index.html', 'utf8');
if (!html.includes('./app.js') || !html.includes('./assets/ant.png')) throw new Error('Missing page assets.');
console.log('GitHub Pages frontend: dist/client; shared memory Worker: dist/server.');
