const { ipcRenderer } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
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
const USAGE_REFRESH_MS = 60_000;
const usageCache = new Map(); // account -> { data, error, fetchedAt }

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
  await Promise.all(
    accounts.map(async (account) => {
      const result = await fetchAccountUsage(account);
      usageCache.set(account, { ...result, fetchedAt: Date.now() });
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
  const accounts = [...usageCache.keys()].sort();

  if (accounts.length === 0) {
    container.innerHTML = '<div class="limit-empty">nenhuma conta encontrada</div>';
    return;
  }

  container.innerHTML = accounts
    .map((account) => {
      const entry = usageCache.get(account) || {};
      if (entry.error) {
        return `<div class="limit-account"><div class="limit-account-name">${account}</div><div class="limit-empty">indisponível: ${entry.error}</div></div>`;
      }
      const u = entry.data;
      if (!u) return `<div class="limit-account"><div class="limit-account-name">${account}</div><div class="limit-empty">carregando...</div></div>`;

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
        </div>`;
    })
    .join('');
}

async function tick() {
  try {
    await Promise.all([updateSystem(), updateAgentProcesses()]);
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
setInterval(() => refreshUsageAll().then(renderLimits), USAGE_REFRESH_MS);
