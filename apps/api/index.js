const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cheerio = require('cheerio');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');

const app = express();

const PORT = process.env.PORT || 4000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 3 * 60 * 1000);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const cache = {
  news: { fetchedAt: 0, data: [] },
  calendar: { fetchedAt: 0, data: [] },
};

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, symbol),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS push_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    platform TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, token),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    query TEXT,
    impact TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_key TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

function now() {
  return Date.now();
}

function isFresh(entry) {
  return entry.fetchedAt && now() - entry.fetchedAt < CACHE_TTL_MS;
}

async function fetchHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'TradingNewsApp/0.1 (compatible; bot) AppleWebKit/537.36 (KHTML, like Gecko)',
      Accept: 'text/html',
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.text();
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseNewsFromJsonLd($) {
  const scripts = $('script[type="application/ld+json"]');
  const items = [];

  scripts.each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const json = JSON.parse(raw);
      const list = Array.isArray(json) ? json : [json];
      list.forEach((entry) => {
        if (!entry) return;
        if (entry['@type'] === 'NewsArticle') {
          items.push(entry);
        }
        if (entry['@type'] === 'ItemList' && Array.isArray(entry.itemListElement)) {
          entry.itemListElement.forEach((item) => {
            if (item && item.item && item.item['@type'] === 'NewsArticle') {
              items.push(item.item);
            }
          });
        }
      });
    } catch (error) {
      // Ignore malformed JSON-LD blocks.
    }
  });

  return items
    .map((item) => ({
      title: normalizeText(item.headline || item.name),
      url: item.url,
      publishedAt: item.datePublished || null,
      source: 'Forex Factory',
    }))
    .filter((item) => item.title && item.url);
}

function parseNewsFallback($) {
  const items = [];
  const seen = new Set();

  $('a[href^="/news/"]').each((_, el) => {
    const href = $(el).attr('href');
    const title = normalizeText($(el).text());
    if (!href || !title) return;
    if (seen.has(href)) return;
    seen.add(href);
    items.push({
      title,
      url: `https://www.forexfactory.com${href}`,
      publishedAt: null,
      source: 'Forex Factory',
    });
  });

  return items;
}

async function getForexFactoryNews() {
  if (isFresh(cache.news)) return cache.news.data;

  const html = await fetchHtml('https://www.forexfactory.com/news');
  const $ = cheerio.load(html);

  let items = parseNewsFromJsonLd($);
  if (!items.length) {
    items = parseNewsFallback($);
  }

  cache.news = {
    fetchedAt: now(),
    data: items.slice(0, 50),
  };

  return cache.news.data;
}

async function getForexFactoryCalendar() {
  if (isFresh(cache.calendar)) return cache.calendar.data;

  const html = await fetchHtml('https://www.forexfactory.com/calendar');
  const $ = cheerio.load(html);
  const rows = [];

  $('tr.calendar__row').each((_, el) => {
    const row = $(el);
    const time = normalizeText(row.find('.calendar__time').text());
    const currency = normalizeText(row.find('.calendar__currency').text());
    const impact = normalizeText(row.find('.calendar__impact span').attr('title'));
    const event = normalizeText(row.find('.calendar__event').text());
    const actual = normalizeText(row.find('.calendar__actual').text());
    const forecast = normalizeText(row.find('.calendar__forecast').text());
    const previous = normalizeText(row.find('.calendar__previous').text());

    if (!event) return;

    rows.push({
      time: time || null,
      currency: currency || null,
      impact: impact || null,
      event,
      actual: actual || null,
      forecast: forecast || null,
      previous: previous || null,
      source: 'Forex Factory',
    });
  });

  cache.calendar = {
    fetchedAt: now(),
    data: rows,
  };

  return cache.calendar.data;
}

function createToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function getUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = getUserById(payload.sub);
    if (!user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/forex-factory/news', async (_req, res) => {
  try {
    const items = await getForexFactoryNews();
    res.json({ items, cachedAt: cache.news.fetchedAt });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch news', detail: error.message });
  }
});

app.get('/api/forex-factory/calendar', async (_req, res) => {
  try {
    const items = await getForexFactoryCalendar();
    res.json({ items, cachedAt: cache.calendar.fetchedAt });
  } catch (error) {
    res.status(502).json({ error: 'Failed to fetch calendar', detail: error.message });
  }
});

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

async function sendExpoPush(tokens, title, body, data = {}) {
  if (!tokens.length) return;
  const messages = tokens.map((token) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
  }));

  await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(messages),
  });
}

async function runAlertChecks() {
  try {
    const alerts = db
      .prepare('SELECT * FROM alerts WHERE active = 1')
      .all();

    if (!alerts.length) return;

    const news = await getForexFactoryNews();
    const calendar = await getForexFactoryCalendar();

    for (const alert of alerts) {
      const tokens = db
        .prepare('SELECT token FROM push_tokens WHERE user_id = ?')
        .all(alert.user_id)
        .map((row) => row.token);

      if (!tokens.length) continue;

      if (alert.type === 'news_keyword') {
        const keyword = normalizeKey(alert.query);
        if (!keyword) continue;
        const match = news.find((item) =>
          normalizeKey(item.title).includes(keyword)
        );
        if (match) {
          const key = match.url || match.title;
          if (alert.last_sent_key === key) continue;
          db.prepare('UPDATE alerts SET last_sent_key = ? WHERE id = ?').run(key, alert.id);
          await sendExpoPush(
            tokens,
            'News alert',
            match.title,
            { url: match.url }
          );
        }
      }

      if (alert.type === 'calendar_impact') {
        const impact = normalizeKey(alert.impact);
        if (!impact) continue;
        const match = calendar.find((item) =>
          normalizeKey(item.impact).includes(impact)
        );
        if (match) {
          const key = `${match.event}-${match.time || ''}`;
          if (alert.last_sent_key === key) continue;
          db.prepare('UPDATE alerts SET last_sent_key = ? WHERE id = ?').run(key, alert.id);
          await sendExpoPush(
            tokens,
            'Calendar alert',
            `${match.currency || ''} ${match.event}`.trim(),
            { event: match.event }
          );
        }
      }
    }
  } catch (error) {
    // Avoid crashing the server on polling errors.
    console.error('Alert poll failed:', error.message);
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (getUserByEmail(email)) {
    return res.status(409).json({ error: 'Account already exists.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = {
    id: crypto.randomUUID(),
    email,
    name: name || email.split('@')[0],
    password_hash: passwordHash,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    'INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(user.id, user.email, user.name, user.password_hash, user.created_at);

  const token = createToken(user);

  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = getUserByEmail(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = createToken(user);
  return res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = req.user;
  return res.json({ user: { id: user.id, email: user.email, name: user.name } });
});

app.get('/api/watchlist', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT symbol FROM watchlist WHERE user_id = ? ORDER BY created_at DESC')
    .all(req.user.id);
  res.json({ symbols: rows.map((row) => row.symbol) });
});

app.post('/api/watchlist', requireAuth, (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required.' });
  }
  const normalized = String(symbol).toUpperCase();
  try {
    db.prepare(
      'INSERT INTO watchlist (id, user_id, symbol, created_at) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), req.user.id, normalized, new Date().toISOString());
  } catch (error) {
    return res.status(409).json({ error: 'Already added.' });
  }
  return res.json({ ok: true, symbol: normalized });
});

app.delete('/api/watchlist/:symbol', requireAuth, (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  db.prepare('DELETE FROM watchlist WHERE user_id = ? AND symbol = ?').run(
    req.user.id,
    symbol
  );
  return res.json({ ok: true });
});

app.post('/api/push/register', requireAuth, (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !platform) {
    return res.status(400).json({ error: 'Token and platform are required.' });
  }

  try {
    db.prepare(
      'INSERT INTO push_tokens (id, user_id, token, platform, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(crypto.randomUUID(), req.user.id, token, platform, new Date().toISOString());
  } catch (error) {
    // Ignore duplicates.
  }

  return res.json({ ok: true });
});

app.get('/api/alerts', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, type, query, impact, active, created_at FROM alerts WHERE user_id = ?')
    .all(req.user.id);
  res.json({ alerts: rows });
});

app.post('/api/alerts', requireAuth, (req, res) => {
  const { type, query, impact } = req.body || {};
  if (!type || !['news_keyword', 'calendar_impact'].includes(type)) {
    return res.status(400).json({ error: 'Invalid alert type.' });
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO alerts (id, user_id, type, query, impact, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'
  ).run(id, req.user.id, type, query || null, impact || null, new Date().toISOString());
  res.json({ ok: true, id });
});

app.delete('/api/alerts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});

setInterval(runAlertChecks, ALERT_POLL_MS);
