import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const theme = readFileSync('app/cds-theme.css', 'utf8');
const definitions = new Set([...theme.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map(m => m[1]));
const files = [];
function walk(dir) { for (const f of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, f.name); if (f.isDirectory()) walk(p); else if (/\.(css|tsx)$/.test(p) && !p.endsWith('cds-theme.css')) files.push(p); } }
walk('app');
for (const file of files) for (const match of readFileSync(file,'utf8').matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)) definitions.add(match[1]);
const failures = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/var\((--cds-[a-zA-Z0-9-]+)/g)) if (!definitions.has(match[1])) failures.push(`${file}: undefined token ${match[1]}`);
  if (/transition\s*:\s*all[^;}]*linear/.test(source)) failures.push(`${file}: generic linear transition`);
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`CDS token check: ${files.length} files, 0 errors`);
