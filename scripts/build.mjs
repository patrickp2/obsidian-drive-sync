import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir('dist/drive-sync', { recursive: true });
await build({ entryPoints: ['src/main.ts'], bundle: true, external: ['obsidian'],
  format: 'cjs', target: 'es2022', platform: 'browser', outfile: 'dist/drive-sync/main.js' });
await Promise.all(['manifest.json', 'styles.css'].map(file => copyFile(file, `dist/drive-sync/${file}`)));
const callback = await build({ entryPoints: ['src/callback.ts'], bundle: true, format: 'iife',
  target: 'es2022', platform: 'browser', minify: true, write: false });
const script = callback.outputFiles[0].text.trim();
const hash = createHash('sha256').update(script).digest('base64');
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'">
  <title>Drive Sync · Google connection</title>
  <script>${script}</script>
  <style>body{font:17px/1.6 system-ui,sans-serif;margin:0;padding:32px 24px;background:#f6f5f3;color:#23262b}main{max-width:560px;margin:8vh auto}h1{font-size:30px;line-height:1.2}#actions{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.button,button{font:inherit;background:#315746;color:white;border:0;border-radius:8px;padding:12px 18px;text-decoration:none;cursor:pointer}button{background:#e2e8e3;color:#23372b}.note{font-size:14px;color:#545d58}a:focus-visible,button:focus-visible{outline:3px solid #3184d0;outline-offset:3px}</style>
</head>
<body>
  <main>
    <h1>Drive Sync</h1>
    <p id="status" role="status" aria-live="polite">Start Google sign-in from the Drive Sync plugin in Obsidian. This project is an authentication-only prototype; vault synchronization is disabled.</p>
    <div id="actions"></div>
    <p class="note">This page relays a short-lived sign-in response to Obsidian. Never enter your Google password or client secret here. It uses no analytics or third-party scripts.</p>
    <noscript>JavaScript is required to return the sign-in response to Obsidian. Return to Obsidian and restart sign-in in a browser with JavaScript enabled.</noscript>
  </main>
</body>
</html>
`;
await writeFile('docs/index.html', html);
console.log('Built dist/drive-sync and docs/index.html (no runtime credentials).');
