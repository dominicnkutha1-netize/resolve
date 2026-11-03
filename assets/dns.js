/**
 * Pure DNS helpers.
 *
 * Kept separate from the browser glue so the interesting parts — normalising
 * names, comparing two resolvers' answers, building dig-style output — can be
 * tested in node without a DOM or a network.
 */

export const TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA', 'SRV'];

const TYPE_CODES = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  6: 'SOA',
  12: 'PTR',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
  33: 'SRV',
  257: 'CAA',
};

export const RCODES = {
  0: 'NOERROR',
  1: 'FORMERR',
  2: 'SERVFAIL',
  3: 'NXDOMAIN',
  4: 'NOTIMP',
  5: 'REFUSED',
};

/**
 * DNS names are case-insensitive and the root label may or may not be spelled
 * out. Both resolvers differ here: Google returns "example.com." while
 * Cloudflare returns "example.com", so comparing raw strings would report a
 * disagreement on every single query.
 */
export function normaliseName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '');
}

export function isValidName(name) {
  const value = normaliseName(name);
  if (!value || value.length > 253) return false;
  if (/\s/.test(value)) return false;
  if (value === 'localhost') return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value);
}

export function typeCode(code) {
  return TYPE_CODES[code] ?? `TYPE${code}`;
}

/**
 * A resolver's verdict, in words. "No answers" and "no such domain" are very
 * different outcomes and it is easy to present them as the same thing.
 */
export function statusLabel(result) {
  if (!result) return 'NO RESPONSE';
  if (result.error) return result.error.toUpperCase();
  const code = result.body?.Status ?? -1;
  const label = RCODES[code] ?? `RCODE${code}`;
  if (label === 'NOERROR' && (result.body?.Answer ?? []).length === 0) return 'NOERROR (NO ANSWERS)';
  return label;
}

/** One answer record, normalised enough to compare across resolvers. */
export function answerKey(record) {
  return `${typeCode(record.type)}|${normaliseName(record.name)}|${String(record.data).trim().toLowerCase()}`;
}

export function answers(result) {
  return result?.ok && !result.error ? result.body?.Answer ?? [] : [];
}

export function answerSet(result) {
  return new Set(answers(result).map(answerKey));
}

/**
 * Where the two resolvers differ.
 *
 * An empty diff is the interesting, boring case: it means both caches agree,
 * which is what you want from a healthy zone. A non-empty diff means one of
 * them is serving something the other is not — stale cache, split horizon,
 * or propagation in progress.
 */
export function compare(a, b) {
  const setA = answerSet(a);
  const setB = answerSet(b);
  const onlyA = [...setA].filter((key) => !setB.has(key));
  const onlyB = [...setB].filter((key) => !setA.has(key));
  const common = [...setA].filter((key) => setB.has(key));

  return {
    onlyA,
    onlyB,
    common,
    agree: onlyA.length === 0 && onlyB.length === 0,
    comparable: answers(a).length > 0 || answers(b).length > 0,
  };
}

export function minTtl(result) {
  const ttls = answers(result)
    .map((record) => record.TTL)
    .filter((ttl) => typeof ttl === 'number');
  return ttls.length ? Math.min(...ttls) : null;
}

export function maxTtl(result) {
  const ttls = answers(result)
    .map((record) => record.TTL)
    .filter((ttl) => typeof ttl === 'number');
  return ttls.length ? Math.max(...ttls) : null;
}

/** Split an MX/SRV style record into preference and target, for display. */
export function splitPreference(record) {
  const data = String(record?.data ?? '');
  const match = data.match(/^(\d+)\s+(.+)$/);
  if (!match) return { preference: null, target: data };
  return { preference: Number(match[1]), target: match[2] };
}

/**
 * dig-style plain text, for copying into a ticket or a terminal.
 */
export function toDig(name, type, label, result) {
  const lines = [];
  lines.push(`;; ${label}`);
  if (!result || result.error) {
    lines.push(`;; error: ${result?.error ?? 'no response'}`);
    return lines.join('\n');
  }
  const body = result.body ?? {};
  lines.push(`;; status: ${RCODES[body.Status] ?? body.Status}  query: ${result.ms}ms`);
  if (body.Comment) lines.push(`;; ${body.Comment}`);

  const records = answers(result);
  if (records.length === 0) {
    lines.push(`;; no ${type} records returned`);
    return lines.join('\n');
  }

  for (const record of records) {
    const ttl = String(record.TTL ?? '').padStart(6);
    const kind = typeCode(record.type).padEnd(6);
    lines.push(`${normaliseName(record.name).padEnd(32)} ${ttl}  IN  ${kind} ${record.data}`);
  }
  return lines.join('\n');
}

/** The header line of a dig answer, useful in the UI too. */
export function answerHeadline(name, type) {
  return `${normaliseName(name)}  IN  ${type}`;
}
