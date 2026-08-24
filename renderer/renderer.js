const { ipcRenderer, clipboard } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const si = require('systeminformation');

document.getElementById('btn-close').addEventListener('click', () => {
  ipcRenderer.send('widget:close');
});

const CLAUDE_STATS_PATH = path.join(os.homedir(), '.claude', 'stats-cache.json');
const AGENTS_CONSUMPTION_PATH = path.join(
  os.homedir(),
  '.local',
  'share',
  'central-agentes',
  'consumo-workspaces.json'
);
const AGENT_PROCESS_RE = /claude|codex|gemini|central-agent/i;

const CLAUDE_ACCOUNTS_DIR = path.join(os.homedir(), '.config', 'central-agentes', 'contas', 'claude');
const USAGE_CHECK_INTERVAL_MS = 30_000; // só verifica se já é hora de tentar de novo
const USAGE_BASE_REFRESH_MS = 5 * 60_000; // dado muda pouco; não precisa mais que isso
const USAGE_BASE_BACKOFF_MS = 5 * 60_000; // 1a espera após 429
const USAGE_MAX_BACKOFF_MS = 30 * 60_000; // teto do backoff (429 desse endpoint é conhecido por travar por horas)
const usageState = new Map(); // account -> { data, error, fetchedAt, nextAttemptAt, backoffMs }

const SLACK_CONFIG_PATH = path.join(os.homedir(), '.config', 'orange-monitor', 'slack.json');
const SLACK_REFRESH_MS = 20_000;
let slackConfig = readJson(SLACK_CONFIG_PATH);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function fmtTokens(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtGB(bytes) {
  return (bytes / 1024 ** 3).toFixed(1) + 'G';
}

function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function setBar(id, pct) {
  document.getElementById(id).style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

async function updateSystem() {
  const [load, mem, fsSize] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize()
  ]);

  const cpuPct = load.currentLoad;
  document.getElementById('cpu-val').textContent = `${cpuPct.toFixed(0)}%`;
  setBar('cpu-bar', cpuPct);

  const ramPct = (mem.active / mem.total) * 100;
  document.getElementById('ram-val').textContent = `${fmtGB(mem.active)} / ${fmtGB(mem.total)}`;
  setBar('ram-bar', ramPct);

  const home = os.homedir();
  const disk =
    fsSize.filter((d) => home.startsWith(d.mount)).sort((a, b) => b.mount.length - a.mount.length)[0] ||
    fsSize[0];

  if (disk) {
    const freeBytes = disk.size - disk.used;
    document.getElementById('disk-val').textContent = `${fmtGB(freeBytes)} livre`;
    setBar('disk-bar', disk.use);
  }
}

function updateClaudeTokens() {
  const stats = readJson(CLAUDE_STATS_PATH);
  if (!stats) return;

  const daily = Array.isArray(stats.dailyModelTokens) ? stats.dailyModelTokens : [];
  const today = daily.find((d) => d.date === todayStr());
  const todayTotal = today
    ? Object.values(today.tokensByModel || {}).reduce((a, b) => a + b, 0)
    : 0;

  const usage = stats.modelUsage || {};
  const grandTotal = Object.values(usage).reduce(
    (sum, m) =>
      sum +
      (m.inputTokens || 0) +
      (m.outputTokens || 0) +
      (m.cacheReadInputTokens || 0) +
      (m.cacheCreationInputTokens || 0),
    0
  );

  document.getElementById('claude-today').textContent = fmtTokens(todayTotal);
  document.getElementById('claude-total').textContent = fmtTokens(grandTotal);
}

function updateAgentsConsumption() {
  const data = readJson(AGENTS_CONSUMPTION_PATH);
  const accountsEl = document.getElementById('agents-accounts');
  const listEl = document.getElementById('agents-list');
  accountsEl.innerHTML = '';
  listEl.innerHTML = '';

  if (!data || !data.workspaces) {
    document.getElementById('agents-tokens').textContent = '0';
    return;
  }

  let total = 0;
  const perWorkspace = [];
  const perAccount = new Map();

  for (const ws of Object.values(data.workspaces)) {
    let wsTokens = 0;
    const wsAccounts = new Set();

    for (const rec of Object.values(ws.records || {})) {
      const tokens = rec.tokens || 0;
      wsTokens += tokens;
      const acc = rec.account || '?';
      wsAccounts.add(acc);
      perAccount.set(acc, (perAccount.get(acc) || 0) + tokens);
    }

    if (wsTokens > 0) {
      perWorkspace.push({ name: ws.name, tokens: wsTokens, accounts: [...wsAccounts] });
    }
    total += wsTokens;
  }

  perWorkspace.sort((a, b) => b.tokens - a.tokens);

  document.getElementById('agents-tokens').textContent = fmtTokens(total);

  const accounts = [...perAccount.entries()].sort((a, b) => b[1] - a[1]);
  for (const [account, tokens] of accounts) {
    const badge = document.createElement('div');
    badge.className = 'account-badge';
    badge.innerHTML = `<span>${account}</span><b>${fmtTokens(tokens)}</b>`;
    accountsEl.appendChild(badge);
  }

  for (const ws of perWorkspace.slice(0, 6)) {
    const item = document.createElement('div');
    item.className = 'agent-item';
    item.innerHTML = `<span>${ws.name} <i>(${ws.accounts.join(', ')})</i></span><b>${fmtTokens(ws.tokens)}</b>`;
    listEl.appendChild(item);
  }
}

async function updateAgentProcesses() {
  const processes = await si.processes();
  const matches = processes.list.filter((p) => AGENT_PROCESS_RE.test(p.name || p.command || ''));

  const cpuSum = matches.reduce((sum, p) => sum + (p.cpu || 0), 0);

  document.getElementById('agents-procs').textContent = String(matches.length);
  document.getElementById('agents-cpu').textContent = `${cpuSum.toFixed(0)}%`;
}

const SPOTIFY_DEST = 'org.mpris.MediaPlayer2.spotify';
const SPOTIFY_PATH = '/org/mpris/MediaPlayer2';

function dbusSend(args) {
  return new Promise((resolve) => {
    execFile('dbus-send', args, { timeout: 3000 }, (err, stdout) => {
      resolve({ ok: !err, stdout: stdout || '' });
    });
  });
}

function extractQuotedAfter(text, key) {
  const re = new RegExp(`string "${key}"[\\s\\S]*?string "([^"]*)"`);
  const m = text.match(re);
  return m ? m[1] : null;
}

function lastQuotedString(text) {
  const all = [...text.matchAll(/string "([^"]*)"/g)];
  return all.length ? all[all.length - 1][1] : null;
}

async function spotifyControl(method) {
  await dbusSend(['--print-reply', `--dest=${SPOTIFY_DEST}`, SPOTIFY_PATH, `org.mpris.MediaPlayer2.Player.${method}`]);
  setTimeout(updateSpotify, 400);
}

async function updateSpotify() {
  const titleEl = document.getElementById('spotify-title');
  const artistEl = document.getElementById('spotify-artist');
  const btnPlay = document.getElementById('spotify-playpause');

  const statusRes = await dbusSend([
    '--print-reply',
    `--dest=${SPOTIFY_DEST}`,
    SPOTIFY_PATH,
    'org.freedesktop.DBus.Properties.Get',
    'string:org.mpris.MediaPlayer2.Player',
    'string:PlaybackStatus'
  ]);

  if (!statusRes.ok) {
    titleEl.textContent = 'Spotify não está aberto';
    artistEl.textContent = '';
    btnPlay.textContent = '▶';
    return;
  }

  const status = lastQuotedString(statusRes.stdout) || 'Stopped';
  btnPlay.textContent = status === 'Playing' ? '⏸' : '▶';

  const metaRes = await dbusSend([
    '--print-reply',
    `--dest=${SPOTIFY_DEST}`,
    SPOTIFY_PATH,
    'org.freedesktop.DBus.Properties.Get',
    'string:org.mpris.MediaPlayer2.Player',
    'string:Metadata'
  ]);

  if (metaRes.ok) {
    titleEl.textContent = extractQuotedAfter(metaRes.stdout, 'xesam:title') || '--';
    artistEl.textContent = extractQuotedAfter(metaRes.stdout, 'xesam:artist') || '';
  }
}

document.getElementById('spotify-prev').addEventListener('click', () => spotifyControl('Previous'));
document.getElementById('spotify-playpause').addEventListener('click', () => spotifyControl('PlayPause'));
document.getElementById('spotify-next').addEventListener('click', () => spotifyControl('Next'));

function slackApi(method, params) {
  return new Promise((resolve) => {
    const body = new URLSearchParams(params).toString();
    const req = https.request(
      {
        hostname: 'slack.com',
        path: `/api/${method}`,
        method: 'POST',
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${slackConfig.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, error: 'resposta inválida' });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, error: 'network_error' }));
    req.end(body);
  });
}

function fmtSlackTime(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

const slackFilesRegistry = new Map(); // idx -> { url, name }

function downloadDestPath(name) {
  const downloadsDir = fs.existsSync(path.join(os.homedir(), 'Downloads'))
    ? path.join(os.homedir(), 'Downloads')
    : os.homedir();
  const safeName = name.replace(/[/\\]/g, '_');
  let dest = path.join(downloadsDir, safeName);
  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(downloadsDir, `${base} (${n})${ext}`);
    n += 1;
  }
  return dest;
}

function downloadSlackFile(url, name) {
  return new Promise((resolve, reject) => {
    const dest = downloadDestPath(name);
    const file = fs.createWriteStream(dest);
    https
      .get(url, { headers: { Authorization: `Bearer ${slackConfig.token}` } }, (res) => {
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(dest, () => {});
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
      })
      .on('error', reject);
  });
}

document.getElementById('slack-messages').addEventListener('click', async (e) => {
  const chip = e.target.closest('.slack-file-chip');
  if (!chip) return;
  const entry = slackFilesRegistry.get(chip.dataset.fileIdx);
  if (!entry) return;

  const originalLabel = chip.textContent;
  chip.textContent = '⏳ baixando...';
  try {
    const dest = await downloadSlackFile(entry.url, entry.name);
    clipboard.writeText(dest);
    chip.textContent = '✓ copiado!';
  } catch {
    chip.textContent = '✗ falhou';
  }
  setTimeout(() => {
    chip.textContent = originalLabel;
  }, 1800);
});

async function updateSlack() {
  if (!slackConfig) return;

  const listEl = document.getElementById('slack-messages');
  const result = await slackApi('conversations.history', {
    channel: slackConfig.contact.channelId,
    limit: 8
  });

  if (!result.ok) {
    listEl.innerHTML = `<div class="limit-empty">indisponível: ${result.error}</div>`;
    return;
  }

  slackFilesRegistry.clear();
  let fileIdx = 0;

  const messages = [...result.messages].reverse();
  listEl.innerHTML = messages
    .map((m) => {
      const mine = m.user === slackConfig.selfUserId;
      const who = mine ? 'você' : slackConfig.contact.name;

      const filesHtml = (m.files || [])
        .map((f) => {
          const idx = String(fileIdx++);
          slackFilesRegistry.set(idx, { url: f.url_private_download || f.url_private, name: f.name });
          const safeName = (f.name || 'arquivo').replace(/</g, '&lt;');
          return `<div class="slack-file-chip" data-file-idx="${idx}" title="baixar e copiar caminho">📄 ${safeName}</div>`;
        })
        .join('');

      const textHtml = m.text ? `<div class="slack-msg-text">${m.text.replace(/</g, '&lt;')}</div>` : '';

      return `<div class="slack-msg ${mine ? 'slack-msg-mine' : ''}"><div class="slack-msg-head"><span>${who}</span><span>${fmtSlackTime(m.ts)}</span></div>${textHtml}${filesHtml}</div>`;
    })
    .join('');
  listEl.scrollTop = listEl.scrollHeight;
}

async function sendSlackReply() {
  if (!slackConfig) return;
  const input = document.getElementById('slack-input');
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  const result = await slackApi('chat.postMessage', {
    channel: slackConfig.contact.channelId,
    text
  });
  input.disabled = false;

  if (result.ok) {
    input.value = '';
    updateSlack();
  }
}

if (slackConfig) {
  document.getElementById('slack-panel').classList.remove('hidden');
  document.getElementById('slack-contact-name').textContent = slackConfig.contact.name;
  document.getElementById('slack-send').addEventListener('click', sendSlackReply);
  document.getElementById('slack-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendSlackReply();
  });
}

function listClaudeAccounts() {
  try {
    return fs
      .readdirSync(CLAUDE_ACCOUNTS_DIR)
      .filter((name) => fs.existsSync(path.join(CLAUDE_ACCOUNTS_DIR, name, '.credentials.json')));
  } catch {
    return [];
  }
}

function fetchAccountUsage(account) {
  return new Promise((resolve) => {
    let token;
    try {
      const cred = readJson(path.join(CLAUDE_ACCOUNTS_DIR, account, '.credentials.json'));
      token = cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken;
    } catch {
      token = null;
    }
    if (!token) return resolve({ error: 'sem token' });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        timeout: 8000,
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-cli/2.0.1 (external, cli)'
        }
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve({ error: `HTTP ${res.statusCode}` });
          try {
            resolve({ data: JSON.parse(body) });
          } catch {
            resolve({ error: 'resposta inválida' });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', (err) => resolve({ error: err.message }));
    req.end();
  });
}

async function refreshUsageAll() {
  const accounts = listClaudeAccounts();
  const now = Date.now();

  await Promise.all(
    accounts.map(async (account) => {
      const prev = usageState.get(account);
      if (prev && now < prev.nextAttemptAt) return; // ainda em backoff, não bate na API

      const result = await fetchAccountUsage(account);

      if (result.data) {
        usageState.set(account, {
          data: result.data,
          error: null,
          fetchedAt: now,
          nextAttemptAt: now + USAGE_BASE_REFRESH_MS,
          backoffMs: USAGE_BASE_BACKOFF_MS
        });
        return;
      }

      const isRateLimited = result.error === 'HTTP 429';
      const wasAlreadyRateLimited = prev && prev.error === 'HTTP 429';
      const prevBackoff = (prev && prev.backoffMs) || USAGE_BASE_BACKOFF_MS;
      const backoffMs =
        isRateLimited && wasAlreadyRateLimited
          ? Math.min(prevBackoff * 2, USAGE_MAX_BACKOFF_MS)
          : USAGE_BASE_BACKOFF_MS;

      usageState.set(account, {
        data: prev && prev.data, // mantém o último dado bom conhecido
        error: result.error,
        fetchedAt: now,
        nextAttemptAt: now + backoffMs,
        backoffMs
      });
    })
  );
}

function fmtCountdown(resetsAtIso) {
  if (!resetsAtIso) return '--';
  const diffMs = new Date(resetsAtIso).getTime() - Date.now();
  if (diffMs <= 0) return 'agora';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${String(mins % 60).padStart(2, '0')}`;
  return `${Math.floor(hours / 24)}d`;
}

function fmtMoney(amountMinor, currency, exponent) {
  const value = amountMinor / 10 ** exponent;
  return `${currency} ${value.toFixed(2)}`;
}

function renderLimitRow(label, pct, resetsAtIso) {
  const safePct = Math.max(0, Math.min(100, pct || 0));
  return `
    <div class="limit-row">
      <div class="limit-head"><span>${label}</span><span>${safePct.toFixed(0)}% · reinicia em ${fmtCountdown(resetsAtIso)}</span></div>
      <div class="bar"><div class="fill" style="width:${safePct}%"></div></div>
    </div>`;
}

function renderLimits() {
  const container = document.getElementById('limits-container');
  const accounts = listClaudeAccounts();

  if (accounts.length === 0) {
    container.innerHTML = '<div class="limit-empty">nenhuma conta encontrada</div>';
    return;
  }

  container.innerHTML = accounts
    .map((account) => {
      const entry = usageState.get(account);
      const u = entry && entry.data;

      const errorNote =
        entry && entry.error
          ? `<div class="limit-empty">${
              entry.error === 'HTTP 429' ? 'limite da API' : entry.error
            } · tenta de novo em ${fmtCountdown(new Date(entry.nextAttemptAt).toISOString())}</div>`
          : '';

      if (!u) {
        return `<div class="limit-account"><div class="limit-account-name">${account}</div>${
          errorNote || '<div class="limit-empty">carregando...</div>'
        }</div>`;
      }

      const fiveHour = u.five_hour || {};
      const weekly = u.seven_day || {};
      const scoped = (u.limits || []).find((l) => l.kind === 'weekly_scoped');
      const scopedName = scoped && scoped.scope && scoped.scope.model ? scoped.scope.model.display_name : null;

      let creditsHtml = '';
      if (u.spend && u.spend.enabled) {
        const used = fmtMoney(u.spend.used.amount_minor, u.spend.used.currency, u.spend.used.exponent);
        const limit = fmtMoney(u.spend.limit.amount_minor, u.spend.limit.currency, u.spend.limit.exponent);
        creditsHtml = `<div class="limit-head"><span>Créditos</span><span>${used} / ${limit}</span></div>`;
      }

      return `
        <div class="limit-account">
          <div class="limit-account-name">${account}</div>
          ${renderLimitRow('5 horas', fiveHour.utilization, fiveHour.resets_at)}
          ${renderLimitRow('Semanal', weekly.utilization, weekly.resets_at)}
          ${scopedName ? renderLimitRow(`Semanal · ${scopedName}`, scoped.percent, scoped.resets_at) : ''}
          ${creditsHtml}
          ${errorNote}
        </div>`;
    })
    .join('');
}

async function tick() {
  try {
    await Promise.all([updateSystem(), updateAgentProcesses(), updateSpotify()]);
    updateClaudeTokens();
    updateAgentsConsumption();
    renderLimits();
    document.getElementById('updated').textContent = new Date().toLocaleTimeString('pt-BR');
  } catch (err) {
    document.getElementById('updated').textContent = 'erro: ' + err.message;
  }
}

tick();
setInterval(tick, 3000);

refreshUsageAll().then(renderLimits);
setInterval(() => refreshUsageAll().then(renderLimits), USAGE_CHECK_INTERVAL_MS);

if (slackConfig) {
  updateSlack();
  setInterval(updateSlack, SLACK_REFRESH_MS);
}
