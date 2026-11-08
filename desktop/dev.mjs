// デスクトップ開発起動 — app の Vite dev サーバと Electron を
// 一緒に立ち上げる。どちらかが死んだら両方畳む。
// （root の npm install が workspace 解決で壊れているため
//   concurrently に頼らず spawn で足す）

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

// Devin/VSCode など Electron 製ホストから起動されると
// ELECTRON_RUN_AS_NODE=1 が継承されて electron が素の Node と
// して動いてしまう — 念のため除去する
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const procs = [
  // Vite dev server (5173 固定ではない — main.js がポートを探す)
  spawn('npm', ['--prefix', '../app', 'run', 'dev'], {
    stdio: 'inherit',
    shell: true,
    env,
  }),
  spawn(electronBin, ['.'], { stdio: 'inherit', shell: false, env }),
];

const shutdown = () => {
  for (const p of procs) if (!p.killed) p.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
for (const p of procs) p.on('exit', shutdown);
