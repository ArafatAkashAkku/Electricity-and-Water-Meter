// DESCO + NESCO prepaid meters and Dhaka + Chattogram WASA bills — one site, zero dependencies.
// Run: node server.js   then open http://localhost:3002

const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;

// DESCO and Dhaka WASA don't send their intermediate certificates, so Node can't
// verify them on its own. Add the public intermediates in certs/ to the trust list.
const CERTS = path.join(__dirname, 'certs');
const CA = [
  ...tls.rootCertificates,
  ...fs.readdirSync(CERTS).filter((f) => f.endsWith('.pem')).map((f) => fs.readFileSync(path.join(CERTS, f), 'utf8')),
];

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function request(url, { method = 'GET', headers = {}, body, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.request(url, { method, headers: { 'User-Agent': UA, ...headers }, ca: CA, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('Upstream timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- DESCO ----
// Official JSON API used by https://prepaid.desco.org.bd

const DESCO_API = 'https://prepaid.desco.org.bd/api/tkdes/customer';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// DESCO rate-limits bursts ("RateLimiter 'simpleRateLimit' does not permit
// further calls"), so calls go one at a time with a retry when limited.
async function descoGet(endpoint, params, { tries = 3, timeout } = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await request(`${DESCO_API}/${endpoint}?${qs}`, { headers: { Accept: 'application/json' }, timeout });
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`DESCO returned an unexpected response (HTTP ${res.status})`);
  }
  if (/RateLimiter/i.test(json.desc || '') && tries > 1) {
    await sleep(1500);
    return descoGet(endpoint, params, { tries: tries - 1, timeout });
  }
  return json;
}

const ymd = (d) => d.toISOString().slice(0, 10);
const ym = (d) => d.toISOString().slice(0, 7);
const ok = (r) => (r && r.code === 200 ? r.data : null);

async function lookupDesco(no) {
  // DESCO account numbers are 8 digits; anything longer is a meter number.
  const key = no.length <= 8 ? 'accountNo' : 'meterNo';
  const bal = await descoGet('getBalance', { [key]: no });
  if (bal.code !== 200 || !bal.data) throw new Error(bal.desc || 'Not found on DESCO');

  const b = bal.data;
  const accountNo = b.accountNo || (key === 'accountNo' ? no : '');
  const meterNo = b.meterNo || (key === 'meterNo' ? no : '');

  const to = new Date();
  const yearAgo = new Date(to);
  yearAgo.setMonth(yearAgo.getMonth() - 11);

  const safe = (p) => p.catch(() => null);
  const c = ok(await safe(descoGet('getCustomerInfo', { accountNo }))) || {};
  const monthly = ok(await safe(descoGet('getCustomerMonthlyConsumption', { accountNo, meterNo, monthFrom: ym(yearAgo), monthTo: ym(to) })));

  const details = {
    'Feeder': c.feederName,
    'Sales & Distribution': c.SDName,
    'Tariff': c.tariffSolution,
    'Sanctioned load': c.sanctionLoad,
    'Phase': c.phaseType,
    'Meter model': c.meterModel,
    'Installed': c.installationDate,
    'This month usage (৳)': b.currentMonthConsumption,
  };

  const usage = (Array.isArray(monthly) ? monthly : [])
    .map((m) => ({ month: m.month, taka: m.consumedTaka, unit: m.consumedUnit, maxDemand: m.maximumDemand }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return {
    provider: 'DESCO',
    name: c.customerName || '',
    address: c.installationAddress || '',
    phone: c.contactNo || '',
    accountNo,
    meterNo,
    balance: b.balance,
    balanceTime: b.readingTime || '',
    details: clean(details),
    // DESCO's recharge-history endpoint can take up to a minute, so the page asks for
    // it separately (see descoRecharges) instead of holding up the balance.
    rechargesPending: true,
    usage,
  };
}

async function descoRecharges(accountNo, meterNo) {
  const to = new Date();
  const from = new Date(to);
  from.setMonth(from.getMonth() - 6);
  const hist = await descoGet('getRechargeHistory', { accountNo, meterNo, dateFrom: ymd(from), dateTo: ymd(to) }, { timeout: 90000 });
  if (hist.code !== 200) throw new Error(hist.desc || 'Could not load DESCO recharge history');
  return (hist.data || []).map((r) => ({
    date: r.rechargeDate,
    amount: r.totalAmount,
    energy: r.energyAmount,
    vat: r.VAT,
    rebate: r.rebate,
    charges: (r.chargeItems || []).map((x) => `${x.chargeItemName}: ${x.chargeAmount}`).join(', '),
    token: r.tokenNo,
    method: r.rechargeOperator,
    status: r.orderStatus,
  }));
}

// ---------------------------------------------------------------- NESCO ----
// No public API: https://customer.nesco.gov.bd/pre/panel is a Laravel form,
// so we fetch a CSRF token + session cookie, submit it, and read the HTML.

const NESCO_PANEL = 'https://customer.nesco.gov.bd/pre/panel';

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const num = (s) => parseFloat(String(s).replace(/[^\d.-]/g, '')) || 0;
const text = (html) =>decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseNesco(html) {
  // Each field is a <label>Title</label> followed by a disabled <input value="...">.
  const fields = {};
  const labelRe = /<label[^>]*>([\s\S]*?)<\/label>/g;
  let m;
  let balanceTime = '';
  while ((m = labelRe.exec(html))) {
    const rawLabel = m[1];
    const title = text(rawLabel.split('<small')[0]);
    const rest = html.slice(labelRe.lastIndex);
    const nextLabel = rest.search(/<label/);
    const scope = nextLabel === -1 ? rest : rest.slice(0, nextLabel);
    const input = scope.match(/<input[^>]*value=["']([^"']*)["']/);
    if (title && input) fields[title] = decode(input[1]).trim();
    if (title.startsWith('অবশিষ্ট ব্যালেন্স')) {
      const t = rawLabel.match(/<span>([\s\S]*?)<\/span>/);
      if (t) balanceTime = text(t[1]);
    }
  }

  // Recharge history table
  const recharges = [];
  const table = html.match(/<thead[\s\S]*?<\/thead>[\s\S]*?<tbody[^>]*>([\s\S]*?)<\/tbody>/);
  if (table) {
    const head = [...table[0].match(/<thead[\s\S]*?<\/thead>/)[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => text(x[1]));
    for (const row of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => text(x[1]));
      if (!cells.length) continue;
      const col = (name) => cells[head.findIndex((h) => h.startsWith(name))] ?? '';
      const charges = [['Meter rent', 'মিটার রেন্ট'], ['Demand charge', 'ডিমান্ড চার্জ'], ['PFC', 'পিএফসি চার্জ'], ['Arrears', 'পরিশোধিত বকেয়া']]
        .map(([label, bn]) => [label, col(bn)])
        .filter(([, v]) => v && num(v) !== 0)
        .map(([label, v]) => `${label}: ${v}`)
        .join(', ');
      recharges.push({
        date: col('রিচার্জের তারিখ'),
        amount: col('রিচার্জের পরিমাণ'),
        energy: col('বিদ্যুৎ'),
        vat: col('ভ্যাট'),
        rebate: col('রেয়াত'),
        charges,
        token: col('টোকেন নম্বর'),
        method: col('রিচার্জের মাধ্যম'),
        status: col('রিমোট রিচার্জ স্ট্যাটাস'),
      });
    }
  }
  return { fields, balanceTime, recharges };
}

async function lookupNesco(no) {
  const page = await request(NESCO_PANEL);
  const token = (page.body.match(/name="_token" value="([^"]+)"/) || [])[1];
  if (!token) throw new Error('Could not open the NESCO portal (no CSRF token)');
  const cookie = (page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const form = new URLSearchParams({ _token: token, cust_no: no, submit: 'রিচার্জ হিস্ট্রি' }).toString();
  const res = await request(NESCO_PANEL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form),
      Cookie: cookie,
      Referer: NESCO_PANEL,
      Origin: 'https://customer.nesco.gov.bd',
    },
    body: form,
  });
  if (res.status !== 200) throw new Error(`NESCO returned HTTP ${res.status}`);

  const { fields: f, balanceTime, recharges } = parseNesco(res.body);
  const name = f['গ্রাহকের নাম'] || '';
  const balanceKey = Object.keys(f).find((k) => k.startsWith('অবশিষ্ট ব্যালেন্স'));
  const balance = balanceKey ? f[balanceKey] : '';
  if (!balance && !f['মিটার নম্বর']) {
    throw new Error('Not found on NESCO — check the customer / meter number');
  }

  return {
    provider: 'NESCO',
    name,
    address: f['ঠিকানা'] || '',
    phone: f['মোবাইল'] || '',
    accountNo: f['কনজ্যুমার নম্বর'] || no,
    meterNo: f['মিটার নম্বর'] || '',
    balance,
    balanceTime,
    details: clean({
      "Father/Husband": f['পিতা/স্বামীর নাম'],
      'Office': f['সংশ্লিষ্ট বিদ্যুৎ অফিস'],
      'Feeder': f['ফিডারের নাম'],
      'Sanctioned load (kW)': f['অনুমোদিত লোড (কি.ও)'],
      'Tariff': f['অনুমোদিত ট্যারিফ'],
      'Meter type': f['মিটারের ধরণ'],
      'Meter status': f['মিটার স্ট্যাটাস'],
      'Installed': f['মিটার স্থাপনের তারিখ'],
      'Minimum recharge (৳)': f['মিনিমাম রিচার্জের পরিমাণ (টাকা)'],
    }),
    recharges,
  };
}

// ------------------------------------------------------ Chattogram WASA ----
// http://ebill.cwasabd.org/ebill/ is public. The bill is a Crystal Reports page:
// absolutely positioned divs inside a JS string, printed twice (CWASA copy and
// consumer copy), so we read the first copy and pair labels with values by position.

const CWASA_BILL = 'http://ebill.cwasabd.org/ebill/monthlybillrun.aspx';
const CWASA_COPY_END = 505; // px: where the consumer copy begins
const CWASA_STATIC = /:$|^(PRESENT|PREVIOUS|AMOUNT|VAT|NET PAYABLE|SURCHARGE|@|ARREAR|\(Not|Payable|বিঃদ্রঃ|NB:|Seal|Officer|CWASA COPY|CONSUMER COPY|Chief|Source)/;

function parseCwasa(html) {
  const src = html.replace(/\\r\\n/g, ' ').replace(/\\\//g, '/').replace(/\\"/g, '"');
  const items = [];
  for (const m of src.matchAll(/<div\b[^>]*?style="[^"]*?top:(\d+)px;left:(\d+)px;[^"]*"[^>]*>([\s\S]*?)<\/div>/g)) {
    const value = text(m[3]);
    if (value && +m[1] < CWASA_COPY_END) items.push({ top: +m[1], left: +m[2], value, label: CWASA_STATIC.test(value) });
  }

  const sameRow = (a, b) => Math.abs(a.top - b.top) <= 10;
  const get = (name) => {
    const label = items.find((i) => i.label && i.value.startsWith(name));
    if (!label) return '';
    const right = items.filter((i) => sameRow(i, label) && i.left > label.left).sort((a, b) => a.left - b.left);
    const stop = right.findIndex((i) => i.label);
    return (stop === -1 ? right : right.slice(0, stop)).map((i) => i.value).join(' · ');
  };
  return { found: items.some((i) => !i.label), get };
}

async function lookupCwasa(no, month) {
  // Without a chosen month, walk back to the newest bill that has been issued.
  const now = new Date();
  const months = month
    ? [month]
    : [0, 1, 2, 3].map((back) => ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))));

  for (const m of months) {
    const [year, mon] = m.split('-').map(Number);
    const qs = new URLSearchParams({ Account: no, Year: year, Month: mon }).toString();
    const res = await request(`${CWASA_BILL}?${qs}`, { timeout: 30000 });
    if (res.status !== 200) throw new Error(`Chattogram WASA returned HTTP ${res.status}`);

    const { found, get } = parseCwasa(res.body);
    if (!found) continue;

    return {
      provider: 'CWASA',
      postpaid: true,
      name: get('NAME'),
      address: get('ADDRESS'),
      phone: get('CONTACT'),
      accountNo: get('A/C NO') || no,
      meterNo: get('METER NO'),
      balance: get('NET PAYABLE'),
      balanceLabel: 'Net payable',
      billPeriod: `Bill for ${m}`,
      details: clean({
        'Bill no.': get('BILL NO'),
        'Issue date': get('ISSUE DATE'),
        'Due date': get('DUE DATE OF PAYMENT'),
        'Ward': get('WARD NO'),
        'Area': get('AREA'),
        'Size': get('SIZE'),
        'Category': get('CATEGORY'),
        'Present reading': get('PRESENT READING-DATE'),
        'Previous reading': get('PREVIOUS READING-DATE'),
        'Consumption': get('CONSUMPTION'),
        'Amount': get('AMOUNT'),
        'VAT': get('VAT'),
        'Surcharge 5%': get('@05%'),
        'Surcharge 10%': get('@10'),
        'Surcharge 15%': get('@15%'),
        'Arrears (not included)': get('ARREAR'),
      }),
    };
  }
  throw new Error('No bill found on Chattogram WASA for that account');
}

// ----------------------------------------------------------- Dhaka WASA ----
// https://consumer-portal.dhakawasa.org needs a customer login, so the password
// comes from the person using the page. It is forwarded once to the portal and
// never logged or stored.

const DWASA_LOGIN = 'https://consumer-portal.dhakawasa.org/index.php?type_name=member&page_name=acc_index&panel_index=1';

const isDwasaLogin = (html) => /name=["']userId["']/i.test(html);
const stripCode = (html) => html.replace(/<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');

// "Label: value" cells become fields; rows starting with a bill number form the statement.
function parseDwasa(html) {
  const fields = {};
  const rows = [];
  let columns = [];
  for (const row of stripCode(html).matchAll(/<tr\b[^>]*>((?:(?!<tr\b|<table\b)[\s\S])*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(
      (c) => text(c[1]) || attr((c[1].match(/<input\b[^>]*>/i) || [''])[0], 'value'),
    );
    if (/^bill no/i.test(cells[0] || '')) {
      if (!columns.length) columns = cells;
    } else if (/^\d{9,}$/.test(cells[0] || '')) {
      rows.push(cells);
    } else {
      for (const cell of cells) {
        const m = cell.match(/^(.{2,40}?)\s*:\s*(.*)$/);
        if (m && m[2] && !(m[1] in fields)) fields[m[1]] = m[2];
      }
    }
  }
  const width = columns.findLastIndex(Boolean) + 1 || undefined;
  return { fields, columns: columns.slice(0, width), rows: rows.map((r) => r.slice(0, width)) };
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decode(m[1] ?? m[2] ?? m[3]) : '';
};
const DMY = /^\d{2}-\d{2}-\d{4}$/;
const toDmy = (iso) => iso.split('-').reverse().join('-');

// Finds the statement's From/To form on the logged-in page, so the field names
// and action come from the portal itself.
function dwasaSearchForm(html, base) {
  for (const f of stripCode(html).matchAll(/<form\b([^>]*)>([\s\S]*?)(?:<\/form>|$)/gi)) {
    const inputs = [...f[2].matchAll(/<(?:input|button)\b[^>]*>/gi)]
      .map((m) => ({ tag: m[0], name: attr(m[0], 'name'), value: attr(m[0], 'value'), type: attr(m[0], 'type').toLowerCase() }))
      .filter((i) => i.name);
    const typed = inputs.filter((i) => !['hidden', 'submit', 'button', 'image', 'reset', 'checkbox', 'radio', 'password'].includes(i.type));
    let [from, to] = typed.filter((i) => DMY.test(i.value));
    if (!to) [from, to] = typed.filter((i) => /date/i.test(i.name)); // date1, date2: empty until searched
    if (!from || !to) continue;

    const fields = {};
    for (const i of inputs) if (i.type === 'hidden') fields[i.name] = i.value;
    const submit = inputs.find((i) => i.type === 'submit' || (/^<button/i.test(i.tag) && i.type !== 'button' && i.type !== 'reset'));
    if (submit) fields[submit.name] = submit.value;
    return {
      action: new URL(attr(`<form ${f[1]}>`, 'action') || base, base).href,
      method: attr(`<form ${f[1]}>`, 'method').toLowerCase() === 'post' ? 'post' : 'get',
      fields,
      fromName: from.name,
      toName: to.name,
      fromValue: from.value,
    };
  }
  return null;
}

function dwasaBills(columns, rows) {
  const col = (name) => columns.findIndex((c) => c.toLowerCase().startsWith(name));
  const latest = rows[rows.length - 1];
  const pick = (name) => (latest && col(name) !== -1 ? latest[col(name)] : '');
  return {
    balance: pick('total bill'),
    balanceLabel: 'Latest bill',
    billPeriod: [pick('bill month'), pick('status')].filter(Boolean).join(' · '),
    columns,
    rows: [...rows].reverse(),
  };
}

// Logged-in portal sessions, kept in memory so changing dates doesn't need the
// password again. Only the portal's cookie is held, never the password.
const dwasaSessions = new Map();
const DWASA_SESSION_MS = 10 * 60 * 1000;
const DWASA_SEARCH_MS = 5 * 60 * 1000; // the portal can take minutes to build a statement

async function dwasaFetch(session, url, options = {}) {
  const keep = (res) =>
    (res.headers['set-cookie'] || []).forEach((c) => {
      const [pair] = c.split(';');
      session.cookies.set(pair.split('=')[0], pair);
    });
  const cookie = () => [...session.cookies.values()].join('; ');

  let res = await request(url, { ...options, headers: { ...options.headers, Cookie: cookie() } });
  keep(res);
  for (let hops = 0; hops < 3 && res.status >= 300 && res.status < 400 && res.headers.location; hops++) {
    url = new URL(res.headers.location, url).href;
    res = await request(url, { headers: { Cookie: cookie() }, timeout: options.timeout });
    keep(res);
  }
  if (res.status !== 200) throw new Error(`Dhaka WASA returned HTTP ${res.status}`);
  return { html: res.body, url };
}

async function dwasaSearch(session, from, to) {
  const { form } = session;
  const data = new URLSearchParams({ ...form.fields, [form.fromName]: toDmy(from), [form.toName]: toDmy(to) }).toString();
  const { html, url } = await (form.method === 'post'
    ? dwasaFetch(session, form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), Referer: session.url },
        body: data,
        timeout: DWASA_SEARCH_MS,
      })
    : dwasaFetch(session, `${form.action}${form.action.includes('?') ? '&' : '?'}${data}`, { timeout: DWASA_SEARCH_MS }));
  if (isDwasaLogin(html)) return null;
  session.url = url;
  session.form = dwasaSearchForm(html, url) || form;
  return parseDwasa(html);
}

async function lookupDwasa(no, password) {
  const session = { cookies: new Map() };
  await dwasaFetch(session, DWASA_LOGIN);

  const form = new URLSearchParams({ userId: no, password, bill_page_ref: '1', Submit: ' LogIn ' }).toString();
  const { html, url } = await dwasaFetch(session, DWASA_LOGIN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form), Referer: DWASA_LOGIN },
    body: form,
  });
  if (isDwasaLogin(html)) throw new Error('Dhaka WASA login failed — check the account number and password');

  const page = parseDwasa(html);
  session.url = url;
  session.form = dwasaSearchForm(html, url);
  const f = page.fields;
  const value = (re) => f[Object.keys(f).find((k) => re.test(k))] || '';
  const profile = {
    provider: 'DWASA',
    postpaid: true,
    name: value(/^(consumer )?name$/i),
    address: value(/^address$/i),
    phone: value(/^cell no/i),
    accountNo: no,
    meterNo: value(/^meter no/i),
    details: clean(Object.fromEntries(Object.entries(f).filter(([k]) =>
      !/^((consumer )?name|address|tel|cell no.*|meter no.*|account (no|number).*|account statement.*|date format.*|categoty|total)$/i.test(k)))),
  };

  // The portal shows no bills until a date range is searched, and that can be
  // slow, so the page asks for the statement separately after login.
  const to = ymd(new Date());
  const from = session.form && DMY.test(session.form.fromValue) ? toDmy(session.form.fromValue) : `${new Date().getFullYear() - 2}-01-01`;

  for (const [t, s] of dwasaSessions) if (s.expires < Date.now()) dwasaSessions.delete(t);
  const token = crypto.randomBytes(24).toString('hex');
  Object.assign(session, { profile, columns: page.columns, expires: Date.now() + DWASA_SESSION_MS });
  dwasaSessions.set(token, session);

  return { ...profile, ...dwasaBills(page.columns, page.rows), session: token, searchable: !!session.form, statementPending: !!session.form, from, to };
}

async function dwasaStatement(token, from, to) {
  const session = dwasaSessions.get(token);
  const expired = 'Your Dhaka WASA session has expired — enter the password and click Check again';
  if (!session || session.expires < Date.now()) {
    dwasaSessions.delete(token);
    throw new Error(expired);
  }
  session.expires = Date.now() + DWASA_SESSION_MS + DWASA_SEARCH_MS;
  const found = await dwasaSearch(session, from, to).catch((e) => {
    throw e.message === 'Upstream timed out' ? new Error('Dhaka WASA took too long to answer — try a shorter date range') : e;
  });
  if (!found) {
    dwasaSessions.delete(token);
    throw new Error(expired);
  }
  session.expires = Date.now() + DWASA_SESSION_MS;
  return { ...session.profile, ...dwasaBills(found.columns.length ? found.columns : session.columns, found.rows), session: token, searchable: true, from, to };
}

function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== ''));
}

// --------------------------------------------------------------- server ----

const LOOKUP = { desco: lookupDesco, nesco: lookupNesco };

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > limit) req.destroy(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid request'));
      }
    });
    req.on('error', reject);
  });
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/desco/recharges') {
      const account = (url.searchParams.get('account') || '').replace(/\D/g, '');
      const meter = (url.searchParams.get('meter') || '').replace(/\D/g, '');
      if (!account) return send(res, 400, 'application/json', JSON.stringify({ error: 'Missing account number' }));
      try {
        return send(res, 200, 'application/json', JSON.stringify(await descoRecharges(account, meter)));
      } catch (e) {
        return send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/api/cwasa') {
      // Chattogram account numbers can contain letters (max 9 characters).
      const no = (url.searchParams.get('no') || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      const month = url.searchParams.get('month') || '';
      if (!no || no.length > 9) return send(res, 400, 'application/json', JSON.stringify({ error: 'Enter a valid account number (up to 9 characters)' }));
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid month' }));
      try {
        return send(res, 200, 'application/json', JSON.stringify(await lookupCwasa(no, month)));
      } catch (e) {
        return send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    }

    // POST so the password never appears in a URL or access log.
    if (url.pathname === '/api/dwasa' && req.method === 'POST') {
      const { no, password } = await readJson(req).catch(() => ({}));
      const account = String(no || '').replace(/\D/g, '');
      if (account.length < 6 || account.length > 20 || !password) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Enter the account number and password' }));
      }
      try {
        return send(res, 200, 'application/json', JSON.stringify(await lookupDwasa(account, String(password))));
      } catch (e) {
        return send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/api/dwasa/statement' && req.method === 'POST') {
      const { session, from, to } = await readJson(req).catch(() => ({}));
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      if (!session || !iso.test(from) || !iso.test(to) || from > to) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Choose a valid From and To date' }));
      }
      try {
        return send(res, 200, 'application/json', JSON.stringify(await dwasaStatement(String(session), from, to)));
      } catch (e) {
        return send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    }

    const match = url.pathname.match(/^\/api\/(desco|nesco)$/);

    if (match) {
      const no = (url.searchParams.get('no') || '').replace(/\D/g, '');
      if (no.length < 6 || no.length > 20) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'Enter a valid account / meter number' }));
      }
      try {
        const data = await LOOKUP[match[1]](no);
        return send(res, 200, 'application/json', JSON.stringify(data));
      } catch (e) {
        return send(res, 502, 'application/json', JSON.stringify({ error: e.message }));
      }
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    send(res, 404, 'text/plain', 'Not found');
  })
  .listen(PORT, () => console.log(`Bidyut lookup running on http://localhost:${PORT}`));
