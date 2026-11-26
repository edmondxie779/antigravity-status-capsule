// Flag-free transport.
//
// When Antigravity was launched without --remote-debugging-port there is no
// DevToolsActivePort and no CDP endpoint. Instead of asking the user to
// relaunch, we:
//   1. locate the Electron main process (the Antigravity app itself),
//   2. verify from the app binary's Electron fuse wire that the Node inspector
//      can be activated by signal (otherwise SIGUSR1 could kill the app),
//   3. activate the main process's Node inspector for a moment,
//   4. install a tiny token-protected 127.0.0.1 bridge inside the main
//      process (list pages / executeJavaScript), and
//   5. close the inspector again.
// The bridge lives as long as the app; restarted sidecars just reuse it.
//
// Run `node bridge.mjs --diagnose` to see what would happen, without
// signalling anything.
import { readFileSync, existsSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_VER = 1;
const INSPECTOR_PORT = 9229;
const BOOTSTRAP_RETRY_MS = 30000;
const REQUEST_TIMEOUT_MS = 3000;
// Same filter the CDP path uses for agent pages.
const PAGE_URL_PATTERN = '^https?://127\\.0\\.0\\.1';

// Electron fuse wire: sentinel, version byte, length byte, then one byte per fuse.
// Index 3 = EnableNodeCliInspectArguments ('1' enabled, '0' disabled, 'r' removed).
const FUSE_SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
const FUSE_NODE_CLI_INSPECT = 3;

// ---------------------------------------------------------------------------
// Locating the Antigravity main process
// ---------------------------------------------------------------------------

function processTable() {
  if (process.platform === 'win32') {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 64 << 20 }
    );
    return JSON.parse(out).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      exe: p.ExecutablePath || '',
      cmd: p.CommandLine || '',
    }));
  }
  const out = execFileSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 64 << 20,
  });
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), exe: '', cmd: m[3] });
  }
  return rows;
}

function executablePath(proc) {
  if (proc.exe) return proc.exe;
  if (process.platform === 'linux') {
    try {
      return realpathSync(`/proc/${proc.pid}/exe`);
    } catch {}
  }
  if (process.platform === 'darwin') {
    const m = proc.cmd.match(/^(.*?\.app\/Contents\/MacOS\/[^/]+?)(?=\s+-|$)/);
    if (m) return m[1];
  }
  return proc.cmd.split(/\s+/)[0] || '';
}

function looksLikeAppMain(proc) {
  if (!proc.cmd || /--type=/.test(proc.cmd)) return false; // renderer/gpu/utility helpers
  const exe = executablePath(proc);
  return /^(antigravity|electron)(\.exe)?$/i.test(basename(exe));
}

export function findAppMainProcess() {
  const override = Number(process.env.AGY_CAPSULE_MAIN_PID);
  const table = processTable();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  if (override) {
    const p = byPid.get(override);
    return p ? { ...p, exe: executablePath(p), via: 'env' } : null;
  }
  // Prefer an ancestor: the sidecar is spawned (directly or indirectly) by the app.
  let cur = byPid.get(process.pid);
  for (let depth = 0; cur && depth < 16; depth++) {
    if (cur.pid !== process.pid && looksLikeAppMain(cur)) return { ...cur, exe: executablePath(cur), via: 'ancestor' };
    cur = byPid.get(cur.ppid);
  }
  // Fallback (e.g. --diagnose from a terminal): a single unambiguous candidate.
  const candidates = table.filter((p) => p.pid !== process.pid && looksLikeAppMain(p));
  if (candidates.length === 1) return { ...candidates[0], exe: executablePath(candidates[0]), via: 'scan' };
  return null;
}

// ---------------------------------------------------------------------------
// Fuse check
// ---------------------------------------------------------------------------

function fuseBinaryFor(exe) {
  if (process.platform === 'darwin') {
    const m = exe.match(/^(.*?\.app)\/Contents\/MacOS\//);
    if (m) {
      const fw = join(m[1], 'Contents', 'Frameworks', 'Electron Framework.framework');
      for (const p of [join(fw, 'Electron Framework'), join(fw, 'Versions', 'Current', 'Electron Framework'), join(fw, 'Versions', 'A', 'Electron Framework')]) {
        if (existsSync(p)) return p;
      }
    }
  }
  return exe;
}

const fuseCache = new Map();

export function readInspectFuse(exe) {
  const bin = fuseBinaryFor(exe);
  let key;
  try {
    key = bin + ':' + statSync(bin).mtimeMs;
  } catch {
    return { state: 'unknown', bin, reason: 'binary not readable' };
  }
  if (fuseCache.has(key)) return fuseCache.get(key);

  let result = { state: 'unknown', bin, reason: 'fuse wire not found' };
  const fd = openSync(bin, 'r');
  try {
    const CHUNK = 8 << 20;
    const overlap = FUSE_SENTINEL.length + 64;
    const buf = Buffer.alloc(CHUNK + overlap);
    let pos = 0;
    let carry = 0;
    for (;;) {
      const n = readSync(fd, buf, carry, CHUNK, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, carry + n);
      const idx = view.indexOf(FUSE_SENTINEL);
      if (idx >= 0 && idx + FUSE_SENTINEL.length + 2 + FUSE_NODE_CLI_INSPECT < view.length) {
        const base = idx + FUSE_SENTINEL.length;
        const len = view[base + 1];
        if (len > FUSE_NODE_CLI_INSPECT) {
          const b = String.fromCharCode(view[base + 2 + FUSE_NODE_CLI_INSPECT]);
          result = { state: b === '1' ? 'enabled' : b === '0' ? 'disabled' : b === 'r' ? 'removed' : 'unknown', bin };
        }
        break;
      }
      pos += n;
      carry = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - carry);
    }
  } finally {
    closeSync(fd);
  }
  fuseCache.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// Code that runs inside the Electron main process (via the inspector).
// Must be self-contained: it is stringified.
// ---------------------------------------------------------------------------

async function installBridgeInMain(opts) {
  /* global require */
  const req =
    typeof require === 'function'
      ? require
      : process.mainModule
        ? process.mainModule.require.bind(process.mainModule)
        : null;
  if (!req) throw new Error('require unavailable in main process');
  const { app, webContents } = req('electron');
  const http = req('http');
  const fs = req('fs');
  const path = req('path');
  const crypto = req('crypto');

  const finish = (status) => {
    if (opts.closeInspector) {
      setTimeout(() => {
        try {
          req('inspector').close();
        } catch {}
      }, 200);
    }
    return status;
  };
  const writeFile = (s) => {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
    fs.writeFileSync(opts.file, JSON.stringify({ ver: s.ver, pid: process.pid, port: s.port, token: s.token }), { mode: 0o600 });
  };

  const prev = globalThis.__agyCapsuleBridge;
  if (prev && prev.ver === opts.ver && prev.server.listening) {
    writeFile(prev);
    return finish('reused');
  }
  if (prev) {
    try {
      prev.server.close();
    } catch {}
  }

  const token = crypto.randomBytes(24).toString('hex');
  const pageRe = new RegExp(opts.pagePattern);
  const listPages = () =>
    webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && pageRe.test(wc.getURL()))
      .map((wc) => ({ id: String(wc.id), url: wc.getURL() }));

  const server = http.createServer((rq, rs) => {
    const send = (code, obj) => {
      rs.writeHead(code, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(obj));
    };
    // Browsers always send Origin on cross-origin requests; the sidecar never does.
    if (rq.headers['x-agy-capsule-token'] !== token || rq.headers.origin) return send(403, { error: 'forbidden' });
    if (rq.method === 'GET' && rq.url === '/pages') return send(200, listPages());
    if (rq.method === 'POST' && rq.url === '/eval') {
      let body = '';
      rq.setEncoding('utf8');
      rq.on('data', (c) => {
        body += c;
        if (body.length > 8 << 20) rq.destroy();
      });
      rq.on('end', async () => {
        try {
          const { id, expr } = JSON.parse(body);
          const wc = webContents.fromId(Number(id));
          if (!wc || wc.isDestroyed()) return send(404, { error: 'page gone' });
          const value = await Promise.race([
            wc.executeJavaScript(String(expr)),
            new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), 3000)),
          ]);
          send(200, { value });
        } catch (e) {
          send(500, { error: String((e && e.message) || e) });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();

  const state = { ver: opts.ver, server, token, port: server.address().port };
  globalThis.__agyCapsuleBridge = state;
  writeFile(state);
  app.once('will-quit', () => {
    try {
      fs.unlinkSync(opts.file);
    } catch {}
  });
  return finish('installed');
}

// ---------------------------------------------------------------------------
// Inspector bootstrap (sidecar side)
// ---------------------------------------------------------------------------

async function inspectorTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${INSPECTOR_PORT}/json/list`, { signal: AbortSignal.timeout(1000) });
    return await res.json();
  } catch {
    return null;
  }
}

function inspectorEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error('inspector timeout'));
    }, 10000);
    const calls = new Map();
    let nextId = 1;
    const call = (method, params) =>
      new Promise((res) => {
        const id = nextId++;
        calls.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        calls.get(msg.id)?.(msg);
        calls.delete(msg.id);
      } catch {}
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('inspector ws error'));
    };
    ws.onopen = async () => {
      try {
        const results = [];
        for (const expr of [].concat(expression)) {
          const msg = await call('Runtime.evaluate', {
            expression: expr,
            includeCommandLineAPI: true,
            awaitPromise: true,
            returnByValue: true,
          });
          const r = msg.result;
          if (msg.error || r?.exceptionDetails) {
            throw new Error(msg.error?.message || r.exceptionDetails.exception?.description || r.exceptionDetails.text);
          }
          results.push(r?.result?.value);
        }
        clearTimeout(timer);
        ws.close();
        resolve(results);
      } catch (e) {
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        reject(e);
      }
    };
  });
}

async function bootstrap(bridgeFile) {
  const main = findAppMainProcess();
  if (!main) return { ok: false, fatal: true, reason: 'Antigravity main process not found' };

  let targets = await inspectorTargets();
  const openedByUs = !targets;
  if (!targets) {
    const fuse = readInspectFuse(main.exe);
    if (fuse.state !== 'enabled') {
      return { ok: false, fatal: true, reason: `inspector fuse ${fuse.state} (${fuse.reason || fuse.bin})` };
    }
    try {
      process._debugProcess(main.pid);
    } catch (e) {
      return { ok: false, fatal: true, reason: 'signal failed: ' + e.message };
    }
    for (let i = 0; i < 30 && !targets; i++) {
      await new Promise((r) => setTimeout(r, 100));
      targets = await inspectorTargets();
    }
    if (!targets) return { ok: false, reason: 'inspector did not come up on port ' + INSPECTOR_PORT };
  }

  const target = targets.find((t) => t.webSocketDebuggerUrl);
  if (!target) return { ok: false, reason: 'no inspector target' };

  const opts = { ver: BRIDGE_VER, file: bridgeFile, pagePattern: PAGE_URL_PATTERN, closeInspector: openedByUs };
  // First make sure we're talking to the right process, then install.
  const [pid] = await inspectorEval(target.webSocketDebuggerUrl, 'process.pid');
  if (pid !== main.pid) return { ok: false, fatal: true, reason: `port ${INSPECTOR_PORT} belongs to pid ${pid}, not ${main.pid}` };
  const [status] = await inspectorEval(
    target.webSocketDebuggerUrl,
    `(${installBridgeInMain.toString()})(${JSON.stringify(opts)})`
  );
  return { ok: true, status, pid: main.pid };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createBridgeTransport({ bridgeFile, log }) {
  let conn = null; // { port, token }
  let lastBootstrapMs = 0;
  let disabledReason = '';

  async function request(path, body) {
    const res = await fetch(`http://127.0.0.1:${conn.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-agy-capsule-token': conn.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: res.status, data: await res.json() };
  }

  async function tryFile() {
    try {
      const info = JSON.parse(readFileSync(bridgeFile, 'utf8'));
      if (info.ver !== BRIDGE_VER) return null;
      conn = { port: info.port, token: info.token };
      const { status, data } = await request('/pages');
      if (status === 200) return data;
    } catch {}
    conn = null;
    return null;
  }

  async function listPages() {
    if (conn) {
      try {
        const { status, data } = await request('/pages');
        if (status === 200) return data;
      } catch {}
      conn = null;
    }
    const pages = await tryFile();
    if (pages) return pages;

    if (disabledReason || Date.now() - lastBootstrapMs < BOOTSTRAP_RETRY_MS) return null;
    lastBootstrapMs = Date.now();
    try {
      const r = await bootstrap(bridgeFile);
      if (!r.ok) {
        if (r.fatal) disabledReason = r.reason;
        log('bridge unavailable: ' + r.reason);
        return null;
      }
      console.log('[deck] flag-free bridge ' + r.status + ' in pid ' + r.pid);
    } catch (e) {
      log('bridge bootstrap failed: ' + e.message);
      return null;
    }
    return tryFile();
  }

  async function evaluate(id, expr) {
    if (!conn) return undefined;
    try {
      const { status, data } = await request('/eval', { id, expr });
      return status === 200 ? data.value : undefined;
    } catch {
      conn = null;
      return undefined;
    }
  }

  return { name: 'bridge', listPages, evaluate };
}

// ---------------------------------------------------------------------------
// Diagnostics: node bridge.mjs --diagnose
// ---------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]) && process.argv.includes('--diagnose')) {
  const main = findAppMainProcess();
  if (!main) {
    console.log('✗ 未找到 Antigravity 主进程（请先打开 Antigravity；也可用 AGY_CAPSULE_MAIN_PID=<pid> 指定）');
    process.exit(1);
  }
  console.log(`✓ 主进程: pid ${main.pid} (${main.via})\n  ${main.exe}`);
  const fuse = readInspectFuse(main.exe);
  console.log(`${fuse.state === 'enabled' ? '✓' : '✗'} EnableNodeCliInspectArguments fuse: ${fuse.state}\n  ${fuse.bin}`);
  console.log(
    fuse.state === 'enabled'
      ? '→ 可以免启动参数运行。'
      : '→ 此版本无法免参数，将继续使用 --remote-debugging-port=0 方式。'
  );
}
