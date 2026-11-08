import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
const python = process.platform === 'win32' ? `${backend}.venv/Scripts/python.exe` : 'python';
const configuration = JSON.parse(readFileSync(new URL('./test-env.json', import.meta.url), 'utf8'));
const databaseUri = process.env.LMA_TEST_DATABASE_URI;
if (!databaseUri?.endsWith('/lma_test')) {
  throw new Error('浏览器测试必须配置隔离 LMA_TEST_DATABASE_URI，数据库名为 lma_test。');
}
const env = { ...process.env, ...configuration, DATABASE_URI: databaseUri, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const migration = spawnSync(python, ['-m', 'app.server.storage'], { cwd: backend, env, stdio: 'inherit', windowsHide: true });
if (migration.status !== 0) process.exit(migration.status || 1);
const args = ['-m', 'uvicorn', 'app.server.api:app', '--host', '127.0.0.1', '--port', '21420'];
if (process.platform === 'win32') args.push('--loop', 'app.server.loop:create_loop');
const server = spawn(python, args, { cwd: backend, env, stdio: 'inherit', windowsHide: true });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.kill(signal));
}
server.on('exit', (code) => process.exit(code || 0));
