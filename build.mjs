import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
const files = ['index.html', 'style.css', 'app.js', 'store.js', 'sync.js'];
const source = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(file, 'utf8')])));
const version = createHash('sha256').update(files.map(file => source[file]).join('\n')).digest('hex').slice(0, 12);
for (const file of files) {
  const content = source[file].replace(/(['"])\.\/(app\.js|sync\.js|store\.js|style\.css)\1/g, (_, quote, asset) => `${quote}./${asset}?v=${version}${quote}`);
  await writeFile(`dist/client/${file}`, content);
}
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
