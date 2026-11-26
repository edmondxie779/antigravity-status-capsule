import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDeckInjector } from './deck_injector.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WATCHED_FILES = [__filename, join(__dirname, 'deck_injector.mjs'), join(__dirname, 'bridge.mjs')];
const INITIAL_MTIMES = new Map(
  WATCHED_FILES.map((p) => {
    try {
      return [p, statSync(p).mtimeMs];
    } catch {
      return [p, 0];
    }
  })
);

// Exit cleanly when plugin source files are updated on disk so the sidecar
// supervisor ("restart_policy": "always") respawns with fresh code.
function startSelfReloadWatcher() {
  const timer = setInterval(() => {
    for (const [p, initMtime] of INITIAL_MTIMES.entries()) {
      try {
        if (initMtime > 0 && statSync(p).mtimeMs > initMtime + 50) {
          console.error('[deck] source file updated, restarting sidecar:', basename(p));
          process.exit(0);
        }
      } catch {}
    }
  }, 5000);
  if (typeof timer.unref === 'function') timer.unref();
}

const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');
const UI_VERSION = 21;

let cachedQuotaGroups = null;
let lastQuotaFetchMs = 0;
let quotaInFlight = null;
let lsConnFailures = 0;
const QUOTA_TTL_MS = 10000;

async function fetchQuotaGroups() {
  const now = Date.now();
  if (cachedQuotaGroups && now - lastQuotaFetchMs < QUOTA_TTL_MS) {
    return cachedQuotaGroups;
  }
  if (quotaInFlight) return quotaInFlight;

  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return cachedQuotaGroups || [];

  quotaInFlight = (async () => {
    try {
      const res = await fetch(
        `http://${lsAddr}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-codeium-csrf-token': csrf,
          },
          body: '{}',
        }
      );
      lsConnFailures = 0;
      if (!res.ok) return cachedQuotaGroups || [];
      const data = await res.json();
      const groups = data?.response?.groups || data?.groups || [];
      cachedQuotaGroups = groups;
      lastQuotaFetchMs = Date.now();
      return groups;
    } catch {
      lsConnFailures++;
      if (lsConnFailures >= 2) {
        process.exit(0);
      }
      return cachedQuotaGroups || [];
    } finally {
      quotaInFlight = null;
    }
  })();

  return quotaInFlight;
}

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(val), i];
    }
    shift += 7n;
  }
  return [Number(val), i];
}

function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function parseGenRow(idx, data) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? usage.get(2)[0] : 0;
  const cachedIn = usage.has(5) ? usage.get(5)[0] : 0;
  const totalGenField = usage.has(3) ? usage.get(3)[0] : 0;
  const thinkTokens = usage.has(9) ? usage.get(9)[0] : 0;
  let outTokens = usage.has(10) ? usage.get(10)[0] : 0;
  if (outTokens === 0 && thinkTokens === 0 && totalGenField > 0) {
    outTokens = totalGenField;
  }
  const contextTokens = uncachedIn + cachedIn;

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0];
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? kv.get(1)[0].toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  return {
    turn: idx,
    uncachedIn,
    cachedIn,
    contextTokens,
    outTokens,
    thinkTokens,
    maxContextTokens,
    lastStepIndex,
  };
}

function parseTimestampSec(buf) {
  if (!buf) return 0;
  const m = parsePbMap(buf);
  const sec = m.has(1) ? Number(m.get(1)[0]) : 0;
  const ns = m.has(2) ? Number(m.get(2)[0]) : 0;
  return sec > 0 ? sec + ns / 1e9 : 0;
}

// Per-conversation parsed DB cache keyed by convId, invalidated on .db / .db-wal mtime or size change.
const MAX_CONV_CACHE = 24;
const convDbCache = new Map(); // convId -> { fingerprint, snapshot }
let lastActiveConvId = null;

let cachedLatestConvId = '';
let lastDirScanMs = 0;
const DIR_SCAN_TTL_MS = 2500;

function resolveLatestConvId() {
  const now = Date.now();
  if (cachedLatestConvId && now - lastDirScanMs < DIR_SCAN_TTL_MS) {
    return cachedLatestConvId;
  }
  if (!existsSync(CONV_DIR)) return '';
  const files = readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({
      id: basename(f, '.db'),
      mtimeMs: statSync(join(CONV_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  lastDirScanMs = now;
  cachedLatestConvId = files.length > 0 ? files[0].id : '';
  return cachedLatestConvId;
}

function getDbFingerprint(dbPath) {
  try {
    const st = statSync(dbPath);
    let walPart = '0:0';
    const walPath = dbPath + '-wal';
    if (existsSync(walPath)) {
      const wst = statSync(walPath);
      walPart = `${wst.mtimeMs}:${wst.size}`;
    }
    return `${st.mtimeMs}:${st.size}:${walPart}`;
  } catch {
    return '';
  }
}

function readConversationSnapshot(convId, dbPath) {
  const fingerprint = getDbFingerprint(dbPath);
  if (!fingerprint) return null;

  const cached = convDbCache.get(convId);
  if (cached && cached.fingerprint === fingerprint) {
    // Refresh LRU order
    convDbCache.delete(convId);
    convDbCache.set(convId, cached);
    return cached.snapshot;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rawGenRows = [];
  let stepRows = [];
  try {
    rawGenRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    stepRows = db.prepare('SELECT idx, step_type, status, metadata FROM steps ORDER BY idx ASC').all();
  } finally {
    db.close();
  }

  // 1. Single pass over steps: timestamps, active execution intervals, compaction checkpoints, planner tok/s
  const cpIndices = [];
  let firstStepEpochMs = 0;
  let lastStepEpochMs = 0;
  let completedActiveMs = 0;
  let segStart = 0;
  let segEnd = 0;
  let userTurns = 0;

  let lastTps = 0;
  let lastPlannerDurationSec = 0;
  let sumPlannerGen = 0;
  let sumPlannerSec = 0;

  for (const s of stepRows) {
    if (s.step_type === 23) {
      cpIndices.push(s.idx);
    }
    if (s.step_type === 14) {
      userTurns++;
    }

    let t1Sec = 0;
    let t6Sec = 0;
    let t7Sec = 0;
    let sm = null;
    if (s.metadata) {
      sm = parsePbMap(Buffer.from(s.metadata));
      if (sm.has(1)) t1Sec = parseTimestampSec(sm.get(1)[0]);
      if (sm.has(6)) t6Sec = parseTimestampSec(sm.get(6)[0]);
      if (sm.has(7)) t7Sec = parseTimestampSec(sm.get(7)[0]);
    }

    const startMs = t1Sec > 0 ? Math.round(t1Sec * 1000) : 0;
    const endMs = Math.round(Math.max(t7Sec, t6Sec, t1Sec) * 1000);

    if (startMs > 0 && (firstStepEpochMs === 0 || startMs < firstStepEpochMs)) {
      firstStepEpochMs = startMs;
    }
    if (endMs > lastStepEpochMs) {
      lastStepEpochMs = endMs;
    }

    // Merge active agent/tool execution intervals (never bridging across user input step_type = 14)
    if (s.step_type === 14) {
      if (segStart > 0 && segEnd > segStart) {
        completedActiveMs += segEnd - segStart;
      }
      segStart = 0;
      segEnd = 0;
    } else if (startMs > 0 && endMs >= startMs) {
      if (segStart === 0) {
        segStart = startMs;
        segEnd = endMs;
      } else if (startMs <= segEnd + 2500) {
        if (endMs > segEnd) segEnd = endMs;
      } else {
        if (segEnd > segStart) completedActiveMs += segEnd - segStart;
        segStart = startMs;
        segEnd = endMs;
      }
    }

    // Planner throughput (step_type = 15)
    if (s.step_type === 15 && sm && t1Sec > 0 && t7Sec > t1Sec && sm.has(9)) {
      const dt = t7Sec - t1Sec;
      if (dt >= 0.05) {
        const usage = parsePbMap(sm.get(9)[0]);
        const th = usage.has(9) ? usage.get(9)[0] : 0;
        const ou = usage.has(10) ? usage.get(10)[0] : 0;
        const gen = th + ou || (usage.has(3) ? usage.get(3)[0] : 0);
        if (gen > 0) {
          lastTps = Math.round((gen / dt) * 10) / 10;
          lastPlannerDurationSec = Math.round(dt * 10) / 10;
          sumPlannerGen += gen;
          sumPlannerSec += dt;
        }
      }
    }
  }

  if (segStart > 0 && segEnd > segStart) {
    completedActiveMs += segEnd - segStart;
  }
  if (userTurns === 0 && stepRows.length > 0) {
    userTurns = 1;
  }

  const avgTps =
    sumPlannerSec >= 0.05 && sumPlannerGen > 0
      ? Math.round((sumPlannerGen / sumPlannerSec) * 10) / 10
      : 0;

  const tailStep = stepRows.length > 0 ? stepRows[stepRows.length - 1] : null;
  const tailStepStatus = tailStep ? tailStep.status : 0;
  const tailStepType = tailStep ? tailStep.step_type : 0;

  if (!lastStepEpochMs && stepRows.length > 0) {
    try {
      lastStepEpochMs = statSync(dbPath).mtimeMs;
    } catch {}
  }

  // 2. Parse gen_metadata: both active context turns AND full-session cumulative totals
  const turns = [];
  let maxContextTokens = 0;
  let sessionUncachedInputTokens = 0;
  let sessionCachedInputTokens = 0;
  let sessionThinkingTokens = 0;
  let sessionOutputTokens = 0;
  let sessionApiCalls = 0;

  for (const row of rawGenRows) {
    const parsed = parseGenRow(row.idx, row.data);
    if (!parsed) continue;
    if (parsed.maxContextTokens > 0) {
      maxContextTokens = parsed.maxContextTokens;
    }
    if (parsed.contextTokens > 0 || parsed.outTokens > 0 || parsed.thinkTokens > 0) {
      sessionUncachedInputTokens += parsed.uncachedIn;
      sessionCachedInputTokens += parsed.cachedIn;
      sessionThinkingTokens += parsed.thinkTokens;
      sessionOutputTokens += parsed.outTokens;
      sessionApiCalls++;
    }
    if (parsed.contextTokens === 0) continue;
    turns.push(parsed);
  }

  const sessionInputTokens = sessionUncachedInputTokens + sessionCachedInputTokens;
  const sessionGeneratedTokens = sessionThinkingTokens + sessionOutputTokens;
  const sessionTotalTokens = sessionInputTokens + sessionGeneratedTokens;

  // 3. Compaction-aware active context breakdown
  let epochStart = 0;
  let detectedCompactions = cpIndices.length;
  if (turns.length > 0) {
    for (let k = cpIndices.length - 1; k >= 0; k--) {
      const cpIdx = cpIndices[k];
      const postIdx = turns.findIndex((t) => t.lastStepIndex >= cpIdx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    let dropCount = 0;
    for (let i = epochStart + 1; i < turns.length; i++) {
      if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
        epochStart = i;
        dropCount++;
      }
    }
    if (detectedCompactions === 0 && dropCount > 0) {
      detectedCompactions = dropCount;
    }
  }

  const latest = turns[turns.length - 1] || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
    outTokens: 0,
    thinkTokens: 0,
  };

  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outTokens;
    rawThink += turns[i].thinkTokens;
  }

  const turn0Tokens = Math.min(turns[epochStart]?.contextTokens || 0, latest.contextTokens);
  const availGen = Math.max(0, latest.contextTokens - turn0Tokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const totalOutputTokens = Math.round(rawOut * genScale);
  const totalThinkingTokens = Math.round(rawThink * genScale);

  const hasContext = turns.length > 0 && latest.contextTokens > 0;

  const snapshot = {
    cachedIn: latest.cachedIn,
    uncachedIn: latest.uncachedIn,
    contextTokens: latest.contextTokens,
    maxContextTokens,
    hasContext,
    firstStepEpochMs,
    lastStepEpochMs: hasContext || stepRows.length > 0 ? lastStepEpochMs : 0,
    completedActiveMs,
    tailStepStatus,
    tailStepType,
    userTurns,
    compactionCount: detectedCompactions,
    turn0Tokens,
    totalOutputTokens,
    totalThinkingTokens,
    lastTps: hasContext ? lastTps : 0,
    avgTps: hasContext ? avgTps : 0,
    lastPlannerDurationSec: hasContext ? lastPlannerDurationSec : 0,
    sessionTotalTokens,
    sessionInputTokens,
    sessionCachedInputTokens,
    sessionUncachedInputTokens,
    sessionThinkingTokens,
    sessionOutputTokens,
    sessionGeneratedTokens,
    sessionApiCalls,
  };

  if (convDbCache.size >= MAX_CONV_CACHE) {
    const oldestKey = convDbCache.keys().next().value;
    if (oldestKey !== undefined) convDbCache.delete(oldestKey);
  }
  convDbCache.set(convId, { fingerprint, snapshot });
  return snapshot;
}

async function makeEmptyContextResult() {
  return {
    uiVersion: UI_VERSION,
    cachedIn: 0,
    uncachedIn: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    firstStepEpochMs: 0,
    lastStepEpochMs: 0,
    isRunning: false,
    sessionSpanSec: 0,
    activeWorkSec: 0,
    userTurns: 0,
    compactionCount: 0,
    turn0Tokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    lastTps: 0,
    avgTps: 0,
    lastPlannerDurationSec: 0,
    sessionTotalTokens: 0,
    sessionInputTokens: 0,
    sessionCachedInputTokens: 0,
    sessionUncachedInputTokens: 0,
    sessionThinkingTokens: 0,
    sessionOutputTokens: 0,
    sessionGeneratedTokens: 0,
    sessionApiCalls: 0,
    quotaGroups: await fetchQuotaGroups(),
  };
}

async function inspectConversation(convId, exact = false) {
  let targetId = '';
  if (exact) {
    lastActiveConvId = convId || '';
    if (!convId || !existsSync(join(CONV_DIR, `${convId}.db`))) {
      return await makeEmptyContextResult();
    }
    targetId = convId;
  } else {
    if (convId && existsSync(join(CONV_DIR, `${convId}.db`))) {
      targetId = convId;
    } else if (lastActiveConvId !== null) {
      if (!lastActiveConvId || !existsSync(join(CONV_DIR, `${lastActiveConvId}.db`))) {
        return await makeEmptyContextResult();
      }
      targetId = lastActiveConvId;
    } else {
      targetId = resolveLatestConvId();
    }
    if (!targetId) {
      return await makeEmptyContextResult();
    }
  }

  const dbPath = join(CONV_DIR, `${targetId}.db`);
  const snap = readConversationSnapshot(targetId, dbPath);
  if (!snap) {
    return await makeEmptyContextResult();
  }

  const nowMs = Date.now();
  const isTailActiveStatus = snap.tailStepStatus === 1 || snap.tailStepStatus === 2;
  const isJustSubmittedInput =
    snap.tailStepType === 14 && snap.lastStepEpochMs > 0 && nowMs - snap.lastStepEpochMs < 30000;
  const isRunning = Boolean(
    (isTailActiveStatus && snap.lastStepEpochMs > 0 && nowMs - snap.lastStepEpochMs < 600000) ||
      isJustSubmittedInput
  );

  const effectiveEndMs = isRunning ? Math.max(snap.lastStepEpochMs, nowMs) : snap.lastStepEpochMs;
  const sessionSpanSec =
    snap.firstStepEpochMs > 0 && effectiveEndMs >= snap.firstStepEpochMs
      ? Math.max(0, Math.floor((effectiveEndMs - snap.firstStepEpochMs) / 1000))
      : 0;
  const liveExtraMs =
    isRunning && snap.lastStepEpochMs > 0 ? Math.max(0, nowMs - snap.lastStepEpochMs) : 0;
  const rawActiveSec =
    snap.firstStepEpochMs > 0
      ? Math.max(0, Math.floor((snap.completedActiveMs + liveExtraMs) / 1000))
      : 0;
  const activeWorkSec = Math.min(rawActiveSec, sessionSpanSec);

  const quotaGroups = await fetchQuotaGroups();

  return {
    uiVersion: UI_VERSION,
    cachedIn: snap.cachedIn,
    uncachedIn: snap.uncachedIn,
    contextTokens: snap.contextTokens,
    maxContextTokens: snap.maxContextTokens,
    firstStepEpochMs: snap.firstStepEpochMs,
    lastStepEpochMs: snap.hasContext ? snap.lastStepEpochMs : 0,
    isRunning,
    sessionSpanSec,
    activeWorkSec,
    userTurns: snap.userTurns,
    compactionCount: snap.compactionCount,
    turn0Tokens: snap.turn0Tokens,
    totalOutputTokens: snap.totalOutputTokens,
    totalThinkingTokens: snap.totalThinkingTokens,
    lastTps: snap.lastTps,
    avgTps: snap.avgTps,
    lastPlannerDurationSec: snap.lastPlannerDurationSec,
    sessionTotalTokens: snap.sessionTotalTokens,
    sessionInputTokens: snap.sessionInputTokens,
    sessionCachedInputTokens: snap.sessionCachedInputTokens,
    sessionUncachedInputTokens: snap.sessionUncachedInputTokens,
    sessionThinkingTokens: snap.sessionThinkingTokens,
    sessionOutputTokens: snap.sessionOutputTokens,
    sessionGeneratedTokens: snap.sessionGeneratedTokens,
    sessionApiCalls: snap.sessionApiCalls,
    quotaGroups,
  };
}

const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agy-capsule</title>
  <script src="/preload.js"></script>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px 14px;
      font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      background: var(--background, #141414);
      color: var(--foreground, #ebebeb);
      font-size: 13.5px;
      line-height: 1.35;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .panel { width: 100%; max-width: 212px; padding: 4px 2px; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 6px; font-variant-numeric: tabular-nums; }
    .title { font-weight: 600; color: color-mix(in srgb, var(--foreground, #18181b) 88%, transparent); }
    .muted { color: var(--muted-foreground, #8e8e93); }
    .divider { height: 1px; background: rgba(142, 142, 147, 0.18); margin: 10px 0; }
  </style>
</head>
<body>
  <div class="panel" id="panel">加载中…</div>
  <script>
    function fmtK(n) {
      const num = Number(n || 0);
      if (num < 1000) return String(num);
      if (num >= 10000000) return (num / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
      if (num >= 1000000) return (num / 1000000).toFixed(2).replace(/\\.?0+$/, '') + 'M';
      return (num / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    }
    function fmtDur(sec) {
      const s = Math.max(0, Math.floor(Number(sec || 0)));
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
      const h = Math.floor(m / 60);
      if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
      return Math.floor(h / 24) + 'd ' + String(h % 24).padStart(2, '0') + 'h';
    }
    async function refresh() {
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || '';
        const convId = window.sidecar?.conversationId || urlParams.get('conversationId') || '';
        const qs = new URLSearchParams();
        if (convId) qs.set('conversationId', convId);
        if (token) qs.set('token', token);
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetch('/api/context' + (qs.toString() ? '?' + qs.toString() : ''), { headers });
        const d = await res.json();
        if (d.error) return;
        const hasMax = d.maxContextTokens > 0;
        const pct = hasMax ? Math.round((d.contextTokens / d.maxContextTokens) * 100) + '%' : '0%';
        const dur = d.firstStepEpochMs > 0 ? fmtDur(d.sessionSpanSec) : '--';
        document.getElementById('panel').innerHTML =
          '<div class="row"><span class="title">已用 ' + pct + '</span><span class="muted">' + fmtK(d.contextTokens) + ' / ' + (hasMax ? fmtK(d.maxContextTokens) : '--') + '</span></div>' +
          '<div class="divider"></div>' +
          '<div class="row"><span class="muted">累计消耗</span><span class="title">' + fmtK(d.sessionTotalTokens) + '</span></div>' +
          '<div class="row"><span class="muted">对话时长</span><span class="muted">' + dur + ' (AI ' + (d.firstStepEpochMs > 0 ? fmtDur(d.activeWorkSec) : '--') + ')</span></div>' +
          '<div class="row"><span class="muted">生成速度</span><span class="muted">' + (d.lastTps > 0 ? d.lastTps.toFixed(1) + ' tok/s' : '--') + '</span></div>';
      } catch {}
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;

export { inspectConversation };

if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => UI_HTML);
  app.page('/ui.html', () => UI_HTML);
  app.api('/api/context', (data) => inspectConversation(data?.conversationId || app.config.conversationId), 'GET');
  app.run();
}
if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  startSelfReloadWatcher();
  startDeckInjector(inspectConversation);
}
