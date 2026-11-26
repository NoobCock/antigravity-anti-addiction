import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export function platformPaths({ platform = process.platform, home = homedir(), env = process.env, arch = process.arch } = {}) {
  let config;
  let local;
  if (platform === 'win32') {
    config = env.APPDATA || join(home, 'AppData', 'Roaming');
    local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  } else if (platform === 'darwin') {
    config = local = join(home, 'Library', 'Application Support');
  } else if (platform === 'linux') {
    config = env.XDG_CONFIG_HOME || join(home, '.config');
    local = env.XDG_DATA_HOME || join(home, '.local', 'share');
  } else {
    throw new Error('Supported platforms: Windows, Linux, macOS');
  }

  const profile = env.AG_ANTI_ADDICTION_PROFILE || env.AG_PULSE_PROFILE || join(config, 'Antigravity');
  const profileLog = join(profile, 'logs', 'language_server.log');
  const log = env.AG_ANTI_ADDICTION_LOG
    || (platform === 'darwin' ? join(home, 'Library', 'Logs', 'Antigravity', 'language_server.log') : profileLog);
  const logCandidates = env.AG_ANTI_ADDICTION_LOG
    ? [log]
    : [...new Set([log, profileLog, ...(platform === 'win32' ? [join(home, '.gemini', 'antigravity', 'logs', 'language_server.log')] : [])])];

  const data = env.ANTIGRAVITY_EXECUTABLE_DATA_DIR
    || join(home, '.gemini', 'antigravity', 'sidecar_data', 'anti-addiction', 'guardian', 'data');

  const appRoots = platform === 'win32'
    ? [join(local, 'Programs', 'antigravity', 'resources')]
    : platform === 'darwin'
      ? ['/Applications/Antigravity.app/Contents/Resources', join(home, 'Applications', 'Antigravity.app', 'Contents/Resources')]
      : ['/opt/Antigravity/resources', '/opt/antigravity/resources', '/usr/share/antigravity/resources'];

  if (env.AG_APP_RESOURCES) appRoots.unshift(env.AG_APP_RESOURCES);
  const exeNames = platform === 'win32'
    ? ['language_server.exe']
    : [
        'language_server',
        `language_server_${platform === 'darwin' ? 'macos' : 'linux'}_${arch === 'arm64' ? 'arm' : 'x'}64`,
        `language_server_${platform === 'darwin' ? 'macos' : 'linux'}`,
      ];

  const agentExecutables = env.ANTIGRAVITY_AGENTAPI_EXE
    ? [env.ANTIGRAVITY_AGENTAPI_EXE]
    : appRoots.flatMap(root => exeNames.map(name => join(root, 'bin', name)));

  return {
    home,
    config,
    local,
    profile,
    log,
    logCandidates,
    data,
    settings: join(data, 'settings.json'),
    pluginConfig: join(home, '.gemini', 'config', 'config.json'),
    agentExecutables,
  };
}

export function installedAgentExecutable(options) {
  const candidates = platformPaths(options).agentExecutables;
  const file = candidates.find(candidate => existsSync(candidate));
  if (!file) throw new Error('Bundled language server not found; set ANTIGRAVITY_AGENTAPI_EXE.');
  return file;
}

export function isPluginDisabledInConfig(pluginName = 'anti-addiction', options = {}) {
  try {
    const raw = readFileSync(platformPaths(options).pluginConfig, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return parsed?.plugins?.[pluginName]?.enabled === false;
  } catch {
    return false;
  }
}
