// Builds the static page into dist/: index.html, assets/main.{js,css}, config.json, data/.
// `npm start` serves it on http://localhost:8000 with local data from ./data or ./seed.
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const serve = process.argv.includes('--serve');
const repo = process.env.GITHUB_REPOSITORY;
const source = repo ? `https://github.com/${repo}` : '#';

fs.rmSync('dist', {recursive: true, force: true});
fs.mkdirSync('dist/data', {recursive: true});
fs.writeFileSync('dist/index.html', fs.readFileSync('index.html', 'utf8').replace('__SOURCE_URL__', source));
fs.copyFileSync('config.json', 'dist/config.json');
fs.writeFileSync('dist/.nojekyll', '');
// local preview: use existing history if present (the workflow copies fresh data afterwards)
for (const dir of ['data', 'seed']) {
  if (fs.existsSync(`${dir}/history.json`)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) fs.copyFileSync(`${dir}/${f}`, `dist/data/${f}`);
    break;
  }
}

const options = {
  entryPoints: ['src/main.jsx'],
  bundle: true,
  minify: !serve,
  sourcemap: serve,
  outdir: 'dist/assets',
  jsx: 'automatic',
  loader: {'.module.css': 'local-css'},
  target: ['es2019'],
  define: {'process.env.NODE_ENV': serve ? '"development"' : '"production"'},
  logLevel: 'info',
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await ctx.serve({servedir: 'dist', port: 8000});
  console.log('http://localhost:8000');
} else {
  await esbuild.build(options);
}
