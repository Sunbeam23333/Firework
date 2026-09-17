import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
const files = ['index.html', 'style.css', 'app.js', 'store.js'];
await mkdir('dist', { recursive: true });
for (const file of files) await cp(file, `dist/${file}`);
await cp('assets', 'dist/assets', { recursive: true });
await writeFile('dist/.nojekyll', '');
const html = await readFile('dist/index.html', 'utf8');
if (!html.includes('./app.js') || !html.includes('./assets/ant.png')) throw new Error('Missing page assets.');
console.log('Firework static site is ready in dist/.');
