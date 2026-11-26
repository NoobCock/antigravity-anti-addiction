import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const MANAGE_PY = join(HERE, '..', 'manage.py');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

test('manage.py installs, reports status, and uninstalls cleanly in isolated home', async () => {
  const fakeHome = await mkdtemp(join(tmpdir(), 'ag-aa-home-'));
  const env = { ...process.env, AG_ANTI_ADDICTION_HOME: fakeHome };
  try {
    await exec(PYTHON, [MANAGE_PY, 'install'], { env });
    const pluginDir = join(fakeHome, '.gemini', 'config', 'plugins', 'anti-addiction');
    assert.equal((await stat(join(pluginDir, 'plugin.json'))).isFile(), true);
    assert.equal((await stat(join(pluginDir, 'sidecars', 'guardian', 'main.mjs'))).isFile(), true);
    assert.equal((await stat(join(pluginDir, 'assets', 'logo.svg'))).isFile(), true);

    const { stdout: statusOut } = await exec(PYTHON, [MANAGE_PY, 'status'], { env });
    const parsed = JSON.parse(statusOut);
    assert.equal(parsed.installed, true);

    await exec(PYTHON, [MANAGE_PY, 'uninstall'], { env });
    await assert.rejects(() => stat(pluginDir));
  } finally {
    await rm(fakeHome, { recursive: true, force: true });
  }
});
