import {
  TYPES,
  normaliseName,
  isValidName,
  statusLabel,
  answers,
  compare,
  minTtl,
  maxTtl,
  toDig,
  typeCode,
} from './dns.js';

const RESOLVERS = [
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    note: '1.1.1.1',
    endpoint: 'https://cloudflare-dns.com/dns-query',
  },
  {
    id: 'google',
    label: 'Google',
    note: '8.8.8.8',
    endpoint: 'https://dns.google/resolve',
  },
];

const TIMEOUT_MS = 8000;

const form = document.getElementById('query-form');
const nameInput = document.getElementById('name');
const submitButton = form.querySelector('button[type="submit"]');
const results = document.getElementById('results');
const verdict = document.getElementById('verdict');
const rawPanel = document.getElementById('raw-panel');
const rawOutput = document.getElementById('raw');
const toggleRaw = document.getElementById('toggle-raw');
const copyRaw = document.getElementById('copy-raw');

/* ------------------------------------------------------------------ */
/* transport                                                          */
/* ------------------------------------------------------------------ */

/**
 * One DNS query over DNS-over-HTTPS. Returns a result object rather than
 * throwing, because a timeout on one resolver should not blank the other
 * one's answer — that comparison is the whole point of the page.
 */
async function ask(resolver, name, type) {
  const url = `${resolver.endpoint}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = performance.now();

  try {
    const response = await fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    const ms = Math.round(performance.now() - started);

    if (!response.ok) {
      return { resolver, ms, ok: false, error: `HTTP ${response.status}` };
    }

    return { resolver, ms, ok: true, body: await response.json() };
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    const message =
      error.name === 'AbortError'
        ? `timed out after ${TIMEOUT_MS / 1000}s`
        : error.message || 'network error';
    return { resolver, ms, ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* rendering                                                          */
/* ------------------------------------------------------------------ */

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function pillKind(result) {
  if (!result.ok) return 'bad';
  const code = result.body?.Status;
  if (code === 0) return answers(result).length ? 'ok' : 'muted';
  if (code === 3) return 'warn';
  return 'bad';
}

function renderCard(result) {
  const { resolver } = result;
  const list = answers(result);
  const kind = pillKind(result);
  const low = minTtl(result);
  const high = maxTtl(result);

  const ttlText =
    low === null ? '—' : low === high ? `${low}s` : `${low}–${high}s`;

  const meta = `
    <div class="card-meta">
      <span>query <b>${result.ms} ms</b></span>
      <span>answers <b>${result.error ? '—' : list.length}</b></span>
      <span>ttl <b>${ttlText}</b></span>
    </div>`;

  let body;
  if (result.error) {
    body = `<div class="card-error">${escapeHtml(result.error)}</div>`;
  } else if (list.length === 0) {
    body = `<div class="card-empty">No ${escapeHtml(currentType)} records in the answer.
      ${result.body?.Status === 3 ? 'The domain does not exist (NXDOMAIN).' : 'The name exists, but has nothing of this type.'}</div>`;
  } else {
    body = `
      <table class="records">
        <thead>
          <tr><th>Type</th><th>Name</th><th>TTL</th><th>Data</th></tr>
        </thead>
        <tbody>
          ${list
            .map(
              (record) => `
            <tr>
              <td class="type">${escapeHtml(typeCode(record.type))}</td>
              <td>${escapeHtml(normaliseName(record.name))}</td>
              <td class="ttl">${escapeHtml(record.TTL ?? '')}</td>
              <td>${escapeHtml(record.data)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`;
  }

  return `
    <article class="card">
      <div class="card-head">
        <h2 class="card-title">${escapeHtml(resolver.label)}</h2>
        <span class="card-note">${escapeHtml(resolver.note)}</span>
        <span class="pill" data-kind="${kind}">${escapeHtml(statusLabel(result))}</span>
      </div>
      ${meta}
      ${body}
    </article>`;
}

function renderVerdict(name, type, a, b) {
  const diff = compare(a, b);
  verdict.hidden = false;

  if (!a.ok || !b.ok) {
    const broken = [a, b].filter((r) => !r.ok).map((r) => r.resolver.label);
    verdict.dataset.state = 'error';
    verdict.innerHTML =
      `<span><strong>${escapeHtml(broken.join(' and '))}</strong> did not answer, ` +
      `so there is nothing to compare. The other resolver's answer is still below.</span>`;
    return;
  }

  if (diff.agree && diff.common.length > 0) {
    verdict.dataset.state = 'agree';
    verdict.innerHTML =
      `<span>Both resolvers returned <strong>the same ${diff.common.length} ` +
      `record${diff.common.length === 1 ? '' : 's'}</strong> for ` +
      `<code>${escapeHtml(normaliseName(name))} ${escapeHtml(type)}</code>.</span>`;
    return;
  }

  if (diff.agree && diff.common.length === 0) {
    verdict.dataset.state = 'empty';

    // NXDOMAIN and "the name exists but has nothing of this type" look the same
    // in an empty answer list and mean very different things. Say which is which.
    const nonexistent = a.body?.Status === 3 && b.body?.Status === 3;

    verdict.innerHTML = nonexistent
      ? `<span>Both resolvers say <strong><code>NXDOMAIN</code></strong>: ` +
        `<code>${escapeHtml(normaliseName(name))}</code> does not exist. ` +
        `No record of any type would be returned — the name is unregistered, ` +
        `expired, or mistyped.</span>`
      : `<span>Both resolvers agree: <code>${escapeHtml(normaliseName(name))}</code> exists ` +
        `and answered <strong><code>NOERROR</code></strong>, but it publishes no ` +
        `<code>${escapeHtml(type)}</code> records. That is not the same as the domain ` +
        `missing — the zone answered, it just has nothing of this type.</span>`;
    return;
  }

  verdict.dataset.state = 'disagree';
  verdict.innerHTML =
    `<span><strong>The resolvers disagree.</strong> ` +
    `${diff.onlyA.length} record${diff.onlyA.length === 1 ? '' : 's'} only from ` +
    `${escapeHtml(a.resolver.label)}, ` +
    `${diff.onlyB.length} only from ${escapeHtml(b.resolver.label)}, ` +
    `${diff.common.length} shared. That usually means a stale cache or a change ` +
    `that has not finished propagating.</span>`;
}

function renderRaw(name, type, a, b) {
  rawOutput.textContent = [
    `; resolve — ${normaliseName(name)} ${type}`,
    `; ${new Date().toISOString()}`,
    '',
    toDig(name, type, a.resolver.label, a),
    '',
    toDig(name, type, b.resolver.label, b),
    '',
    `;; ${a.resolver.label} ${a.ms}ms · ${b.resolver.label} ${b.ms}ms`,
  ].join('\n');
  rawPanel.hidden = false;
}

let currentType = 'A';

function renderSkeleton(name, type) {
  verdict.hidden = false;
  verdict.dataset.state = 'empty';
  verdict.innerHTML = `<span>Asking two resolvers about <code>${escapeHtml(normaliseName(name))} ${escapeHtml(type)}</code>…</span>`;
  results.innerHTML = RESOLVERS.map(
    (resolver) => `
      <article class="card">
        <div class="card-head">
          <h2 class="card-title">${escapeHtml(resolver.label)}</h2>
          <span class="card-note">${escapeHtml(resolver.note)}</span>
          <span class="pill" data-kind="muted">QUERYING</span>
        </div>
        <div class="skeleton">waiting for answer</div>
      </article>`
  ).join('');
  rawPanel.hidden = true;
}

function renderError(message) {
  verdict.hidden = false;
  verdict.dataset.state = 'error';
  verdict.innerHTML = `<span>${escapeHtml(message)}</span>`;
  results.innerHTML = '';
}

/* ------------------------------------------------------------------ */
/* run                                                                */
/* ------------------------------------------------------------------ */

async function run(name, type) {
  const clean = normaliseName(name);

  if (!isValidName(clean)) {
    renderError(`“${name}” is not a domain name. Try something like example.com.`);
    nameInput.focus();
    return;
  }

  if (!TYPES.includes(type)) type = 'A';
  currentType = type;

  history.replaceState(null, '', `?name=${encodeURIComponent(clean)}&type=${encodeURIComponent(type)}`);

  results.setAttribute('aria-busy', 'true');
  submitButton.disabled = true;
  renderSkeleton(clean, type);

  const started = performance.now();
  const [a, b] = await Promise.all(RESOLVERS.map((resolver) => ask(resolver, clean, type)));

  results.innerHTML = renderCard(a) + renderCard(b);
  renderVerdict(clean, type, a, b);
  renderRaw(clean, type, a, b);

  results.setAttribute('aria-busy', 'false');
  submitButton.disabled = false;

  // Useful when timing the two resolvers against each other.
  verdict.dataset.elapsed = String(Math.round(performance.now() - started));
}

/* ------------------------------------------------------------------ */
/* events                                                             */
/* ------------------------------------------------------------------ */

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const type = form.querySelector('input[name="type"]:checked')?.value ?? 'A';
  run(nameInput.value, type);
});

for (const button of document.querySelectorAll('.examples button')) {
  button.addEventListener('click', () => {
    nameInput.value = button.dataset.domain;
    const radio = form.querySelector(`input[name="type"][value="${button.dataset.type}"]`);
    if (radio) radio.checked = true;
    run(button.dataset.domain, button.dataset.type);
  });
}

toggleRaw.addEventListener('click', () => {
  const hidden = rawOutput.hasAttribute('hidden');
  if (hidden) {
    rawOutput.removeAttribute('hidden');
    toggleRaw.textContent = 'Hide';
  } else {
    rawOutput.setAttribute('hidden', '');
    toggleRaw.textContent = 'Show';
  }
});

copyRaw.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(rawOutput.textContent);
    copyRaw.textContent = 'Copied';
    setTimeout(() => (copyRaw.textContent = 'Copy'), 1400);
  } catch {
    copyRaw.textContent = 'Copy failed';
    setTimeout(() => (copyRaw.textContent = 'Copy'), 1400);
  }
});

// Deep links: ?name=example.com&type=MX
const params = new URLSearchParams(location.search);
const initialName = params.get('name') || nameInput.value;
const initialType = (params.get('type') || 'A').toUpperCase();

if (params.get('name')) nameInput.value = initialName;
const initialRadio = form.querySelector(`input[name="type"][value="${initialType}"]`);
if (initialRadio) initialRadio.checked = true;

run(initialName, TYPES.includes(initialType) ? initialType : 'A');
