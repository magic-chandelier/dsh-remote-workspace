import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const host = readFileSync(resolve(root, 'src/index.js'), 'utf8');
const imports = [
  'server', 'binding-tools', 'remote-context', 'virtual-workspace', 'remote-guard',
];
let built = host;
for (const name of imports) {
  built = built.replace(`require('../lib/${name}.cjs')`, `require('./${name}.cjs')`);
}
writeFileSync(resolve(root, 'lib/index.js'), built);

const sourceClient = readFileSync(resolve(root, 'src/client.cjs'), 'utf8');
const css = readFileSync(resolve(root, 'src/ui.css'), 'utf8');
const theme = readFileSync(resolve(root, 'src/theme.js'), 'utf8').trim();
if (!sourceClient.includes('const STYLE = __RW_CSS__;')) throw new Error('Missing UI stylesheet marker');
const client = sourceClient.replace('const STYLE = __RW_CSS__;', `const STYLE = ${JSON.stringify(css)};`)
  .replace('const themeTools = __RW_THEME__;', `const themeTools = ${theme};`);
writeFileSync(resolve(root, 'lib/client.js'),
  `window.__ModuleLoader__.load({ id: "dsh-remote-workspace", factory: (require) => {\n` +
  `const module = { exports: {} }; const exports = module.exports;\n${client}\nreturn module.exports;\n} });\n`);
console.log('Built Host and experimental Web Client.');
