// Operator console: Alerts (channels, dedup, history), Logs (fleet log search), Rules (what alerts).
(() => {
  const KEY_STORAGE = 'notification-demo-operator-key';
  const $ = (id) => document.getElementById(id);
  let apiUrl = '';

  const LABELS = {
    email: { title: 'Email', icon: '✉️', note: 'Amazon SES · addresses are fixed at deploy time · includes log links' },
    slack: { title: 'Slack', icon: '💬', note: 'Incoming webhook · includes log links' },
    sms: { title: 'SMS', icon: '📱', note: 'Amazon SNS · simulate mode logs instead of sending' },
    website: { title: 'Website', icon: '🌐', note: 'Publishes to the public notices page' },
  };
  const LOG_TYPE_LABELS = {
    'php-error': 'PHP errors',
    'apache-access': 'Apache access',
    'windows-application': 'Windows Application',
    'windows-system': 'Windows System',
    'windows-security': 'Windows Security',
  };
  let logTypes = Object.keys(LOG_TYPE_LABELS);

  const storage = {
    get() { try { return localStorage.getItem(KEY_STORAGE) || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem(KEY_STORAGE, v); } catch { /* private mode */ } },
    clear() { try { localStorage.removeItem(KEY_STORAGE); } catch { /* ignore */ } },
  };
  let operatorKey = storage.get();

  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.className = 'toast'), 3500);
  }

  async function api(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-operator-key': operatorKey },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      lock('That key was not accepted.');
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }
  const report = (err) => { if (err.message !== 'unauthorized') toast(err.message, true); };

  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return e;
  }
  const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

  function ago(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 90) return `${Math.max(s, 0)}s ago`;
    if (s < 5400) return `${Math.round(s / 60)}m ago`;
    if (s < 172800) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  // ======================= Tabs / routing =======================

  const TABS = ['alerts', 'logs', 'rules'];
  let loaded = {};

  function route() {
    const [name, query] = location.hash.replace(/^#/, '').split('?');
    const tab = TABS.includes(name) ? name : 'alerts';
    for (const t of TABS) {
      $(`panel-${t}`).hidden = t !== tab;
      document.querySelector(`.tab[data-tab="${t}"]`).setAttribute('aria-selected', String(t === tab));
    }
    if (tab === 'logs') {
      if (!loaded.hosts) { loaded.hosts = true; loadHosts().catch(report); }
      if (query) applyLogParams(new URLSearchParams(query));
    }
    if (tab === 'rules' && !loaded.rules) { loaded.rules = true; loadRules().catch(report); }
  }

  // ======================= Alerts tab =======================

  async function save(name, body, successMsg) {
    try {
      await api('PUT', `/channels/${name}`, body);
      toast(successMsg);
    } catch (err) {
      report(err);
    }
    await loadChannels().catch(report);
  }

  function channelCard(name, ch) {
    const meta = LABELS[name] || { title: name, icon: '•', note: '' };
    const toggle = el('input', {
      type: 'checkbox',
      role: 'switch',
      checked: ch.enabled,
      'aria-label': `${meta.title} enabled`,
      onchange: (e) => save(name, { enabled: e.target.checked }, `${meta.title} ${e.target.checked ? 'enabled' : 'disabled'}`),
    });
    const body = el('div', { class: 'card-body' });

    if (name === 'email') {
      body.append(el('dl', {},
        el('dt', {}, 'From'), el('dd', {}, ch.config.fromAddress || '—'),
        el('dt', {}, 'To'), el('dd', {}, (ch.config.toAddresses || []).join(', ') || '—')));
    }
    if (name === 'slack') {
      const url = ch.config.webhookUrl || '';
      const placeholder = !url || url.includes('REPLACE_ME');
      const input = el('input', { type: 'url', value: placeholder ? '' : url, placeholder: 'https://hooks.slack.com/services/…', 'aria-label': 'Slack webhook URL' });
      body.append(
        placeholder ? el('p', { class: 'warn' }, 'No webhook set. Slack deliveries are skipped.') : null,
        el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); save('slack', { config: { webhookUrl: input.value.trim() } }, 'Slack webhook saved'); } },
          input, el('button', { type: 'submit' }, 'Save')),
      );
    }
    if (name === 'sms') {
      const sim = el('input', { type: 'checkbox', checked: ch.config.simulate !== false,
        onchange: (e) => save('sms', { config: { simulate: e.target.checked } }, `SMS simulate ${e.target.checked ? 'on' : 'off'}`) });
      const phone = el('input', { type: 'tel', value: ch.config.phoneNumber || '', placeholder: '+15551234567', 'aria-label': 'SMS phone number' });
      body.append(
        el('label', { class: 'check' }, sim, ' Simulate (log only)'),
        el('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); save('sms', { config: { phoneNumber: phone.value.trim() } }, 'Phone number saved'); } },
          phone, el('button', { type: 'submit' }, 'Save')),
      );
    }
    if (name === 'website') {
      body.append(el('p', { class: 'muted' }, el('a', { href: 'notices.html', target: '_blank', rel: 'noopener' }, 'View public notices ↗')));
    }

    return el('article', { class: `card channel${ch.enabled ? ' on' : ''}` },
      el('div', { class: 'channel-head' },
        el('div', {}, el('h3', {}, `${meta.icon} ${meta.title}`), el('p', { class: 'muted small' }, meta.note)),
        el('label', { class: 'switch' }, toggle, el('span', { class: 'slider', 'aria-hidden': 'true' }))),
      body);
  }

  async function loadChannels() {
    const data = await api('GET', '/channels');
    $('channels').replaceChildren(...Object.entries(data.channels).map(([n, c]) => channelCard(n, c)));
    $('dedup-window').value = data.dedupWindowMinutes;
  }

  const STATUS_CLASS = {
    SENT: 'ok', SIMULATED: 'info', DISABLED: 'muted', SKIPPED_DUPLICATE: 'muted', SKIPPED_GUARDRAIL: 'warn',
    SKIPPED_MISCONFIGURED: 'warn', NOT_DELIVERED: 'warn', FAILED: 'bad',
  };
  const badge = (s) => el('span', { class: `badge ${STATUS_CLASS[s] || ''}` }, s.replace(/_/g, ' ').toLowerCase());

  async function loadHistory() {
    const { items } = await api('GET', '/history?limit=50');
    $('history-empty').hidden = items.length > 0;
    $('history').replaceChildren(...items.map((m) => el('tr', {},
      el('td', { class: 'nowrap' }, new Date(m.createdAt).toLocaleString()),
      el('td', {}, (m.sourceId || '').replace(/^host:/, '')),
      el('td', {}, m.alarmName || m.eventType, el('br'), el('span', { class: 'muted small' }, m.severity)),
      el('td', {}, badge(m.status || 'UNKNOWN'), m.aiFallback ? el('div', { class: 'muted small' }, 'template (no AI)') : null),
      el('td', {}, Object.values(m.channels || {}).map((c) => el('div', { class: 'small' }, `${c.channel}: `, badge(c.status)))),
      el('td', { class: 'summary' }, m.summary || m.guardrailReason || m.error || '—'),
      el('td', { class: 'nowrap' }, m.logs ? el('a', { href: `#logs?${scopeToParams(m.logs)}` }, 'View logs') : null),
    )));
  }

  // ======================= Logs tab =======================

  let hosts = [];
  const selectedHosts = new Set();
  const selectedTypes = new Set(logTypes);
  let queryRun = 0;

  function renderTypeChips() {
    $('type-list').replaceChildren(...logTypes.map((t) => chip(LOG_TYPE_LABELS[t] || t, selectedTypes.has(t), (on) => {
      if (on) selectedTypes.add(t); else selectedTypes.delete(t);
      previewQuery();
    })));
  }

  function chip(label, checked, onChange, title) {
    const input = el('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
    return el('label', { class: 'chip', title }, input, el('span', {}, label));
  }

  function renderHostChips() {
    if (!hosts.length) {
      $('host-list').replaceChildren(el('span', { class: 'muted small' }, 'No servers have shipped logs yet. Hosts appear a few minutes after they boot.'));
      return;
    }
    $('host-list').replaceChildren(...hosts.map((h) => {
      const stale = Date.now() - h.lastEventAt > 30 * 60_000;
      const c = chip(h.host, selectedHosts.has(h.host), (on) => {
        if (on) selectedHosts.add(h.host); else selectedHosts.delete(h.host);
        previewQuery();
      }, `${h.logTypes.join(', ')} · last log ${ago(h.lastEventAt)}`);
      c.append(el('span', { class: `muted small${stale ? ' stale' : ''}` }, ` · ${ago(h.lastEventAt)}`));
      return c;
    }));
  }

  async function loadHosts() {
    const data = await api('GET', '/logs/hosts');
    hosts = data.hosts;
    if (Array.isArray(data.logTypes)) logTypes = data.logTypes;
    renderHostChips();
  }

  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function setCustomVisible(on) {
    for (const e of document.querySelectorAll('.custom-time')) e.hidden = !on;
  }

  function currentScope() {
    const range = $('logs-range').value;
    let from, to;
    if (range === 'custom') {
      from = new Date($('logs-from').value);
      to = new Date($('logs-to').value);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('Pick a custom From and To time');
    } else {
      to = new Date();
      from = new Date(to.getTime() - Number(range) * 60_000);
    }
    return {
      hosts: [...selectedHosts],
      logTypes: [...selectedTypes],
      terms: splitList($('logs-terms').value),
      problemsOnly: $('logs-problems').checked,
      from: from.toISOString(),
      to: to.toISOString(),
    };
  }

  function scopeToParams(s) {
    const p = new URLSearchParams();
    for (const h of s.hosts || []) p.append('host', h);
    for (const t of s.logTypes || []) p.append('type', t);
    for (const t of s.terms || []) p.append('term', t);
    if (s.problemsOnly) p.set('problems', '1');
    if (s.from) p.set('from', s.from);
    if (s.to) p.set('to', s.to);
    return p.toString();
  }

  /** Prefill the Logs form from a deep link (e.g. a notification's "View logs") and run it. */
  function applyLogParams(p) {
    selectedHosts.clear();
    for (const h of p.getAll('host')) selectedHosts.add(h);
    const types = p.getAll('type').filter((t) => logTypes.includes(t));
    selectedTypes.clear();
    for (const t of types.length ? types : logTypes) selectedTypes.add(t);
    $('logs-terms').value = p.getAll('term').join(', ');
    $('logs-problems').checked = p.get('problems') === '1';
    if (p.get('from') && p.get('to')) {
      $('logs-range').value = 'custom';
      $('logs-from').value = toLocalInput(p.get('from'));
      $('logs-to').value = toLocalInput(p.get('to'));
      setCustomVisible(true);
    }
    // Hosts from a link may not be in the list yet (or have stopped logging); show them anyway.
    for (const h of selectedHosts) if (!hosts.some((x) => x.host === h)) hosts.push({ host: h, logTypes: [], lastEventAt: 0 });
    renderHostChips();
    renderTypeChips();
    history.replaceState(null, '', '#logs'); // don't re-run on refresh/back
    runSearch().catch(report);
  }

  // Client-side preview of the generated query (the API builds the real one the same way).
  function previewQuery() {
    try {
      const s = currentScope();
      const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      const lines = ['fields @timestamp, @log, @logStream, @message'];
      if (s.hosts.length) lines.push(`| filter @logStream in [${s.hosts.map((h) => JSON.stringify(h)).join(', ')}]`);
      if (s.terms.length) lines.push(`| filter @message like /(?i)(${s.terms.map(esc).join('|')})/`);
      if (s.problemsOnly) lines.push('| filter @message like /<problem lines>/');
      lines.push('| sort @timestamp desc', '| limit 200');
      if (!$('query-details').open) $('logs-query').value = lines.join('\n');
    } catch { /* incomplete custom range */ }
  }

  async function runSearch(rawQuery) {
    const run = ++queryRun;
    const scope = currentScope();
    if (!scope.logTypes.length) throw new Error('Pick at least one log type');
    $('logs-status').textContent = 'Starting query…';
    $('logs-empty').hidden = true;
    $('logs-rows').replaceChildren();
    const started = await api('POST', '/logs/query', rawQuery ? { ...scope, query: rawQuery } : scope);
    $('logs-query').value = started.query;
    $('console-link').href = started.consoleUrl;
    $('console-link').hidden = false;

    const t0 = Date.now();
    for (;;) {
      if (run !== queryRun) return; // superseded by a newer search
      const res = await api('GET', `/logs/query/${encodeURIComponent(started.queryId)}`);
      renderRows(res.rows);
      const scanned = res.stats ? ` · ${Number(res.stats.recordsScanned || 0).toLocaleString()} lines scanned` : '';
      if (res.status === 'Complete') {
        $('logs-status').textContent = `${res.rows.length} result${res.rows.length === 1 ? '' : 's'}${scanned} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
        $('logs-empty').hidden = res.rows.length > 0;
        $('logs-empty').textContent = 'No matching log lines in this time range.';
        return;
      }
      if (['Failed', 'Cancelled', 'Timeout'].includes(res.status)) throw new Error(`Query ${res.status.toLowerCase()}`);
      $('logs-status').textContent = `Running… ${res.rows.length} so far${scanned}`;
      if (Date.now() - t0 > 60_000) throw new Error('Query took longer than 60s; narrow the time range or open it in CloudWatch');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const PROBLEM_RE = /\b(fatal|error|critical|warn|warning|fail|failed|failure|denied)\b|\[(ERROR|WARNING|CRITICAL)\]|" [45]\d\d /i;

  function renderRows(rows) {
    $('logs-rows').replaceChildren(...rows.map((r) => {
      const ts = r['@timestamp'] ? new Date(r['@timestamp'].replace(' ', 'T') + 'Z') : null;
      const msg = r['@message'] || '';
      return el('tr', { class: PROBLEM_RE.test(msg) ? 'problem' : '' },
        el('td', { class: 'nowrap' }, ts ? ts.toLocaleString() : '—'),
        el('td', { class: 'nowrap' }, r['@logStream'] || '—'),
        el('td', { class: 'nowrap' }, LOG_TYPE_LABELS[r.logType] || r.logType || '—'),
        el('td', { class: 'msg' }, msg));
    }));
  }

  // ======================= Rules tab =======================

  let rules = [];
  let editing = null; // rule id being edited, or null for new

  function describeRule(r) {
    const parts = [];
    if (r.minLevel) parts.push(`level ≥ ${r.minLevel}`);
    if (r.terms?.length) parts.push(`contains ${r.terms.map((t) => `“${t}”`).join(' or ')}`);
    if (r.eventIds?.length) parts.push(`event ID ${r.eventIds.join(' / ')}`);
    return parts.join(' and ');
  }

  function ruleScope(r) {
    const terms = r.terms?.length ? r.terms : (r.eventIds || []).map((id) => `[${id}]`);
    return { hosts: [], logTypes: r.logTypes, terms, problemsOnly: !terms.length && Boolean(r.minLevel) };
  }

  async function loadRules() {
    const data = await api('GET', '/rules');
    rules = data.rules;
    if (Array.isArray(data.logTypes)) logTypes = data.logTypes;
    $('rules-empty').hidden = rules.length > 0;
    $('rules-rows').replaceChildren(...rules.map((r) => {
      const toggle = el('input', {
        type: 'checkbox', role: 'switch', checked: r.enabled, 'aria-label': `${r.name} enabled`,
        onchange: async (e) => {
          try {
            const { id, ...body } = { ...r, enabled: e.target.checked };
            await api('PUT', `/rules/${id}`, body);
            toast(`${r.name} ${e.target.checked ? 'enabled' : 'disabled'}`);
          } catch (err) { report(err); }
          loadRules().catch(report);
        },
      });
      const del = el('button', { class: 'ghost danger', onclick: async (e) => {
        if (e.target.dataset.armed !== '1') {
          e.target.dataset.armed = '1';
          e.target.textContent = 'Confirm delete';
          setTimeout(() => { e.target.dataset.armed = ''; e.target.textContent = 'Delete'; }, 4000);
          return;
        }
        try { await api('DELETE', `/rules/${r.id}`); toast(`Deleted ${r.name}`); } catch (err) { report(err); }
        loadRules().catch(report);
      } }, 'Delete');
      return el('tr', { class: r.enabled ? '' : 'off' },
        el('td', {}, el('label', { class: 'switch' }, toggle, el('span', { class: 'slider', 'aria-hidden': 'true' }))),
        el('td', {}, el('strong', {}, r.name), el('br'), el('span', { class: 'muted small' }, r.id)),
        el('td', { class: 'small' }, r.logTypes.map((t) => LOG_TYPE_LABELS[t] || t).join(', ')),
        el('td', { class: 'small' }, describeRule(r)),
        el('td', { class: 'nowrap small' }, `${r.threshold} in ${r.windowMinutes} min`, el('br'), el('span', { class: 'muted' }, 'per server')),
        el('td', {}, el('span', { class: `badge ${r.severity === 'HIGH' ? 'bad' : r.severity === 'MEDIUM' ? 'warn' : 'info'}` }, r.severity)),
        el('td', { class: 'nowrap' },
          el('a', { href: `#logs?${scopeToParams({ ...ruleScope(r), from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() })}` }, 'Matches'),
          ' ',
          el('button', { class: 'ghost', onclick: () => openRule(r) }, 'Edit'),
          ' ',
          del));
    }));
  }

  const ruleTypes = new Set();
  function openRule(r) {
    editing = r ? r.id : null;
    $('rule-dialog-title').textContent = r ? `Edit rule: ${r.name}` : 'New rule';
    $('rule-name').value = r?.name || '';
    $('rule-id').value = r?.id || '';
    $('rule-id').readOnly = Boolean(r);
    ruleTypes.clear();
    for (const t of r?.logTypes || []) ruleTypes.add(t);
    $('rule-types').replaceChildren(...logTypes.map((t) => chip(LOG_TYPE_LABELS[t] || t, ruleTypes.has(t), (on) => {
      if (on) ruleTypes.add(t); else ruleTypes.delete(t);
    })));
    $('rule-level').value = r?.minLevel || '';
    $('rule-terms').value = (r?.terms || []).join(', ');
    $('rule-events').value = (r?.eventIds || []).join(', ');
    $('rule-threshold').value = r?.threshold ?? 5;
    $('rule-window').value = r?.windowMinutes ?? 5;
    $('rule-severity').value = r?.severity || 'MEDIUM';
    $('rule-enabled').checked = r ? r.enabled : true;
    $('rule-error').textContent = '';
    $('rule-dialog').showModal();
  }

  function ruleFromForm() {
    const eventIds = splitList($('rule-events').value).map(Number);
    if (eventIds.some((n) => !Number.isInteger(n))) throw new Error('Event IDs must be whole numbers');
    const body = {
      name: $('rule-name').value.trim(),
      enabled: $('rule-enabled').checked,
      logTypes: [...ruleTypes],
      terms: splitList($('rule-terms').value),
      eventIds,
      threshold: Number($('rule-threshold').value),
      windowMinutes: Number($('rule-window').value),
      severity: $('rule-severity').value,
    };
    if ($('rule-level').value) body.minLevel = $('rule-level').value;
    return body;
  }

  $('rule-new').addEventListener('click', () => openRule(null));
  $('rule-cancel').addEventListener('click', () => $('rule-dialog').close());
  $('rule-name').addEventListener('input', () => {
    if (editing) return;
    $('rule-id').value = $('rule-name').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  });
  $('rule-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = ruleFromForm();
      const id = editing || $('rule-id').value.trim();
      if (!editing && rules.some((r) => r.id === id)) throw new Error(`A rule with ID "${id}" already exists`);
      await api('PUT', `/rules/${encodeURIComponent(id)}`, body);
      $('rule-dialog').close();
      toast(`Saved ${body.name}`);
      await loadRules();
    } catch (err) {
      if (err.message !== 'unauthorized') $('rule-error').textContent = err.message;
    }
  });
  $('rule-preview').addEventListener('click', () => {
    try {
      const r = ruleFromForm();
      if (!r.logTypes.length) throw new Error('Pick at least one log type');
      $('rule-dialog').close();
      location.hash = `#logs?${scopeToParams({ ...ruleScope(r), from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() })}`;
    } catch (err) {
      $('rule-error').textContent = err.message;
    }
  });

  // ======================= Auth / wiring =======================

  function lock(message) {
    operatorKey = '';
    storage.clear();
    loaded = {};
    $('app').hidden = true;
    $('auth').hidden = false;
    $('auth-error').textContent = message || '';
  }

  async function unlock() {
    try {
      await Promise.all([loadChannels(), loadHistory()]);
      $('auth').hidden = true;
      $('app').hidden = false;
      renderTypeChips();
      previewQuery();
      route();
    } catch (err) {
      if (err.message !== 'unauthorized') lock(err.message);
    }
  }

  $('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    operatorKey = $('key-input').value.trim();
    storage.set(operatorKey);
    unlock();
  });
  $('lock').addEventListener('click', () => lock());
  $('refresh').addEventListener('click', () => loadHistory().then(() => toast('History refreshed')).catch(report));
  $('dedup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PUT', '/settings/dedup', { windowMinutes: Number($('dedup-window').value) });
      toast('Dedup window saved');
    } catch (err) {
      report(err);
    }
  });

  $('hosts-refresh').addEventListener('click', () => loadHosts().then(() => toast('Servers refreshed')).catch(report));
  $('logs-range').addEventListener('change', (e) => {
    const custom = e.target.value === 'custom';
    if (custom && !$('logs-from').value) {
      $('logs-from').value = toLocalInput(new Date(Date.now() - 3600_000).toISOString());
      $('logs-to').value = toLocalInput(new Date().toISOString());
    }
    setCustomVisible(custom);
    previewQuery();
  });
  for (const id of ['logs-terms', 'logs-problems', 'logs-from', 'logs-to']) $(id).addEventListener('input', previewQuery);
  $('logs-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch().catch((err) => { report(err); $('logs-status').textContent = ''; });
  });
  $('run-raw').addEventListener('click', () => {
    runSearch($('logs-query').value).catch((err) => { report(err); $('logs-status').textContent = ''; });
  });

  window.addEventListener('hashchange', () => { if (!$('app').hidden) route(); });
  setInterval(() => { if (!$('app').hidden && !$('panel-alerts').hidden) loadHistory().catch(() => {}); }, 30000);

  fetch('config.json', { cache: 'no-store' })
    .then((r) => r.json())
    .then((cfg) => {
      apiUrl = cfg.apiUrl.replace(/\/$/, '');
      if (operatorKey) unlock(); else lock();
    })
    .catch(() => lock('Could not load config.json. Was the stack deployed?'));
})();
