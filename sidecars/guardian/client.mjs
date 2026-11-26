import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { platformPaths } from './paths.mjs';
import { discoverProcesses } from './discovery.mjs';

const SERVICE = '/exa.language_server_pb.LanguageServerService/';

export function parseLoopbackAddress(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let parsed;
  try {
    parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname.toLowerCase())) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { protocol: hasScheme ? parsed.protocol : null, port };
}

export function serverFromDiscovery(log, processes, env = {}) {
  const list = Array.isArray(processes) ? processes : [processes];
  const standalone = list.filter(p => /--standalone\b/.test(p?.CommandLine || ''));
  const envAddr = parseLoopbackAddress(env?.ANTIGRAVITY_LS_ADDRESS);
  const logPorts = typeof log === 'string'
    ? new Set([...log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)].map(m => Number(m[1])))
    : new Set();

  const hidden = !standalone.length
    ? list.filter(p => p && Number.isSafeInteger(p.ProcessId) && p.ProcessId > 0 && (p.CommandLine === null || p.CommandLine === ''))
    : [];
  const matchedHidden = hidden.filter(p => {
    const pPorts = new Set([p.Ports].flat().map(Number));
    return Boolean(envAddr && pPorts.has(envAddr.port)) || [...logPorts].some(lp => pPorts.has(lp));
  });
  const rows = standalone.length ? standalone : matchedHidden.length ? matchedHidden : hidden;
  if (rows.length !== 1) {
    throw new Error(rows.length ? '检测到多个 Antigravity 实例' : '未找到 Antigravity 后台进程');
  }
  const ports = new Set([rows[0].Ports].flat().map(Number));
  const envCsrf = typeof env?.ANTIGRAVITY_CSRF_TOKEN === 'string' && env.ANTIGRAVITY_CSRF_TOKEN.trim()
    ? env.ANTIGRAVITY_CSRF_TOKEN.trim()
    : null;
  const envMatchesProcess = Boolean(envAddr && ports.has(envAddr.port));
  const logPort = typeof log === 'string'
    ? [...log.matchAll(/listening on random port at (\d+) for HTTP(?:\s|$)/g)].reverse().map(m => Number(m[1])).find(p => ports.has(p))
    : null;
  const port = logPort || (envMatchesProcess && envAddr.protocol !== 'https:' ? envAddr.port : null);
  if (!port) throw new Error('等待 Antigravity 本地接口就绪');
  const cliCsrf = typeof rows[0].CommandLine === 'string'
    ? rows[0].CommandLine.match(/--csrf_token(?:=|\s+)"?([^\s"]+)/)?.[1]
    : null;
  const csrf = cliCsrf || (envMatchesProcess ? envCsrf : null);
  if (!csrf) throw new Error('未获取到本地 Language Server 凭据');
  return { port, csrf, pid: rows[0].ProcessId };
}

export class AntigravityClient {
  constructor({ paths = platformPaths, readLog = readFile, processes = discoverProcesses, now = Date.now, env = process.env } = {}) {
    this.paths = paths;
    this.readLog = readLog;
    this.processes = processes;
    this.now = now;
    this.env = env;
    this.server = null;
    this.discoveredAt = 0;
    this.discovering = null;
    this.lastScanAt = -Infinity;
    this.retryAt = 0;
    this.discoveryFailures = 0;
    this.discoveryError = null;
  }

  async discover(force = false) {
    if (!force && this.server && this.now() - this.discoveredAt < 15000) return this.server;
    if (this.discovering) return this.discovering;
    if (!force && this.discoveryError && this.now() < this.retryAt) throw this.discoveryError;
    this.lastScanAt = this.now();
    this.discovering = this.discoverNow()
      .then(server => {
        this.discoveredAt = this.now();
        this.discoveryFailures = 0;
        this.discoveryError = null;
        this.retryAt = 0;
        return server;
      })
      .catch(error => {
        this.discoveryError = error;
        this.discoveryFailures++;
        this.retryAt = this.now() + Math.min(30000, 3000 * (2 ** Math.min(4, this.discoveryFailures - 1)));
        throw error;
      })
      .finally(() => {
        this.discovering = null;
      });
    return this.discovering;
  }

  async discoverNow() {
    this.server = null;
    const parsed = await this.processes();
    if (!parsed || (Array.isArray(parsed) && !parsed.length)) {
      throw new Error('请先打开 Antigravity');
    }
    let foundLog = false;
    let lastError = null;
    const paths = this.paths();
    for (const file of paths.logCandidates || [paths.log]) {
      try {
        const log = await this.readLog(file, 'utf8');
        foundLog = true;
        this.server = serverFromDiscovery(log, parsed, this.env);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') lastError = error;
      }
    }
    if (!this.server && !foundLog && this.env?.ANTIGRAVITY_LS_ADDRESS) {
      try {
        this.server = serverFromDiscovery('', parsed, this.env);
      } catch {}
    }
    if (!this.server) {
      throw lastError || new Error(foundLog ? '等待 Antigravity 本地接口就绪' : '未找到语言服务日志');
    }
    this.discoveredAt = this.now();
    return this.server;
  }

  async call(method, body = {}, retry = true) {
    const server = await this.discover();
    try {
      return await new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = request(
          {
            hostname: '127.0.0.1',
            port: server.port,
            method: 'POST',
            path: SERVICE + method,
            headers: {
              'Content-Type': 'application/json',
              'Connect-Protocol-Version': '1',
              'x-codeium-csrf-token': server.csrf,
              'Content-Length': Buffer.byteLength(data),
            },
          },
          res => {
            let text = '';
            let bytes = 0;
            let failed = false;
            const fail = error => {
              if (failed) return;
              failed = true;
              reject(error);
              req.destroy();
            };
            res.setEncoding('utf8');
            res.on('error', error => {
              if (!failed) {
                failed = true;
                reject(error);
              }
            });
            res.on('data', chunk => {
              if (failed) return;
              bytes += Buffer.byteLength(chunk);
              if (bytes > 16 * 1024 * 1024) {
                fail(new Error('Response too large'));
                return;
              }
              text += chunk;
            });
            res.on('end', () => {
              if (failed) return;
              if (res.statusCode !== 200) {
                reject(Object.assign(new Error(`RPC ${method} failed (${res.statusCode})`), { status: res.statusCode }));
                return;
              }
              try {
                resolve(JSON.parse(text));
              } catch {
                reject(new Error(`Invalid JSON from ${method}`));
              }
            });
          },
        );
        req.on('error', reject);
        const failTimeout = () => {
          const err = new Error('Antigravity RPC timeout');
          reject(err);
          req.destroy();
        };
        req.setTimeout(10000, failTimeout);
        req.end(data);
      });
    } catch (error) {
      const endpointLost = [401, 403].includes(error.status)
        || ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(error.code);
      if (!endpointLost) throw error;
      if (this.server === server) {
        this.server = null;
        this.discoveryError = error;
        this.retryAt = Math.max(this.retryAt, this.lastScanAt + 3000);
      }
      if (retry) {
        await this.discover();
        return this.call(method, body, false);
      }
      throw error;
    }
  }
}
