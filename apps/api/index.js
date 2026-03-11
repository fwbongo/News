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
let webPush;
try {
  webPush = require('web-push');
} catch (error) {
  webPush = null;
}
let resendClient;
try {
  const { Resend } = require('resend');
  resendClient = Resend;
} catch (error) {
  resendClient = null;
}

const app = express();

const PORT = process.env.PORT || 4000;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const ALERT_POLL_MS = Number(process.env.ALERT_POLL_MS || 3 * 60 * 1000);
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const RESEND_FROM = process.env.RESEND_FROM || 'Trading News <noreply@example.com>';
const RESEND_REPLY_TO = process.env.RESEND_REPLY_TO || '';
const resend = resendClient && RESEND_API_KEY ? new resendClient(RESEND_API_KEY) : null;

app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('dev'));

const cache = {
  news: { fetchedAt: 0, data: [] },
  calendar: { fetchedAt: 0, data: [] },
  forex: new Map(),
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
  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS price_alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    pair TEXT NOT NULL,
    type TEXT NOT NULL,
    direction TEXT NOT NULL,
    value REAL NOT NULL,
    window_days INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    last_sent_key TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS web_push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    subscription_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, endpoint),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
`);

try {
  db.prepare('ALTER TABLE users ADD COLUMN email_alerts INTEGER NOT NULL DEFAULT 0').run();
} catch (error) {
  // Column already exists.
}

function now() {
  return Date.now();
}

function isFresh(entry) {
  return entry.fetchedAt && now() - entry.fetchedAt < CACHE_TTL_MS;
}

function getForexCacheKey(pair, days) {
  return `${pair}:${days}`;
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
    if (href.includes('/hit')) return;
    if (href.includes('#')) return;
    if (/^from\s/i.test(title)) return;
    if (/\bcomments?\b/i.test(title)) return;
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

function isAdminEmail(email) {
  return ADMIN_EMAIL && email && email.toLowerCase() === ADMIN_EMAIL;
}

function createToken(user, isAdmin) {
  return jwt.sign(
    { sub: user.id, email: user.email, isAdmin: Boolean(isAdmin) },
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
    req.isAdmin = Boolean(payload.isAdmin) || isAdminEmail(user.email);
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
}

async function getForexSeries(pair, days = 30) {
  const normalizedPair = String(pair || '').toUpperCase();
  const [base, quote] = normalizedPair.split('/');
  if (!base || !quote) {
    throw new Error('Invalid pair');
  }
  const safeDays = Math.max(5, Math.min(120, Number(days) || 30));
  const key = getForexCacheKey(normalizedPair, safeDays);
  const existing = cache.forex.get(key);
  if (existing && isFresh(existing)) return existing.data;

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - safeDays);
  const formatDate = (date) => date.toISOString().slice(0, 10);
  const start = formatDate(startDate);
  const end = formatDate(endDate);

  const url = `https://api.frankfurter.dev/v1/${start}..${end}?base=${base}&symbols=${quote}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch forex data');
  }
  const payload = await response.json();
  const points = Object.entries(payload.rates || {})
    .map(([date, rateObj]) => ({
      date,
      timestamp: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000),
      value: rateObj[quote],
    }))
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => (a.date > b.date ? 1 : -1));

  if (!points.length) {
    throw new Error('No forex data available');
  }

  const data = {
    pair: normalizedPair,
    base,
    quote,
    start_date: payload.start_date,
    end_date: payload.end_date,
    points,
  };

  cache.forex.set(key, { fetchedAt: now(), data });
  return data;
}

async function getIntradaySeries(pair, interval, outputsize = 120) {
  const normalizedPair = String(pair || '').toUpperCase();
  const [base, quote] = normalizedPair.split('/');
  if (!base || !quote) {
    throw new Error('Invalid pair');
  }
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('Intraday feed not configured');
  }
  const safeOutput = Math.max(10, Math.min(500, Number(outputsize) || 120));
  const safeInterval = String(interval || '1h');
  const cacheKey = getForexCacheKey(normalizedPair, `${safeInterval}:${safeOutput}`);
  const existing = cache.forex.get(cacheKey);
  if (existing && isFresh(existing)) return existing.data;

  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    `${base}/${quote}`
  )}&interval=${encodeURIComponent(safeInterval)}&outputsize=${safeOutput}&timezone=UTC&format=JSON&apikey=${TWELVE_DATA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch intraday data');
  }
  const payload = await response.json();
  if (payload?.status === 'error') {
    throw new Error(payload?.message || 'Failed to fetch intraday data');
  }

  const points = (payload.values || [])
    .map((item) => {
      const dateTime = String(item.datetime || '');
      const iso = dateTime.includes('T') ? dateTime : dateTime.replace(' ', 'T');
      const timestamp = Math.floor(Date.parse(`${iso}Z`) / 1000);
      return {
        datetime: dateTime,
        timestamp,
        value: Number(item.close),
      };
    })
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp);

  if (!points.length) {
    throw new Error('No intraday data available');
  }

  const data = {
    pair: normalizedPair,
    base,
    quote,
    interval: safeInterval,
    points,
  };

  cache.forex.set(cacheKey, { fetchedAt: now(), data });
  return data;
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

app.get('/api/forex/rates', async (req, res) => {
  try {
    const { pair, days } = req.query || {};
    const data = await getForexSeries(pair, days);
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch forex rates' });
  }
});

app.get('/api/forex/candles', async (req, res) => {
  try {
    const { pair, interval, outputsize } = req.query || {};
    const data = await getIntradaySeries(pair, interval, outputsize);
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch intraday rates' });
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

async function sendWebPush(subscriptions, title, body, data = {}) {
  if (!webPush || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({ title, body, data });

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, payload);
      } catch (error) {
        // Remove invalid subscriptions.
        if (error?.statusCode === 410 || error?.statusCode === 404) {
          db.prepare('DELETE FROM web_push_subscriptions WHERE endpoint = ?').run(
            subscription.endpoint
          );
        }
      }
    })
  );
}

async function sendEmailAlert(to, subject, html) {
  if (!resend || !RESEND_API_KEY || !RESEND_FROM) return;
  await resend.emails.send({
    from: RESEND_FROM,
    to,
    subject,
    html,
    replyTo: RESEND_REPLY_TO || undefined,
  });
}

async function runAlertChecks() {
  try {
    const alerts = db
      .prepare('SELECT * FROM alerts WHERE active = 1')
      .all();
    const priceAlerts = db
      .prepare('SELECT * FROM price_alerts WHERE active = 1')
      .all();

    if (!alerts.length && !priceAlerts.length) return;

    const news = await getForexFactoryNews();
    const calendar = await getForexFactoryCalendar();

    const userTokens = new Map();
    const userWebSubs = new Map();
    const getUserTokens = (userId) => {
      if (!userTokens.has(userId)) {
        userTokens.set(
          userId,
          db
            .prepare('SELECT token FROM push_tokens WHERE user_id = ?')
            .all(userId)
            .map((row) => row.token)
        );
      }
      return userTokens.get(userId);
    };
    const getUserWebSubs = (userId) => {
      if (!userWebSubs.has(userId)) {
        userWebSubs.set(
          userId,
          db
            .prepare('SELECT subscription_json FROM web_push_subscriptions WHERE user_id = ?')
            .all(userId)
            .map((row) => JSON.parse(row.subscription_json))
        );
      }
      return userWebSubs.get(userId);
    };

    for (const alert of alerts) {
      const tokens = db
        .prepare('SELECT token FROM push_tokens WHERE user_id = ?')
        .all(alert.user_id)
        .map((row) => row.token);
      const webSubs = db
        .prepare('SELECT subscription_json FROM web_push_subscriptions WHERE user_id = ?')
        .all(alert.user_id)
        .map((row) => JSON.parse(row.subscription_json));

      const user = getUserById(alert.user_id);
      const emailEnabled = Boolean(user?.email_alerts);
      if (!tokens.length && !webSubs.length && !emailEnabled) continue;

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
          await sendWebPush(
            webSubs,
            'News alert',
            match.title,
            { url: match.url }
          );
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              `News alert: ${match.title}`,
              `<p>${match.title}</p><p><a href="${match.url}">Read source</a></p>`
            );
          }
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
          await sendWebPush(
            webSubs,
            'Calendar alert',
            `${match.currency || ''} ${match.event}`.trim(),
            { event: match.event }
          );
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Calendar alert',
              `<p>${match.currency || ''} ${match.event}</p><p>Impact: ${match.impact || 'n/a'}</p>`
            );
          }
        }
      }
    }

    for (const alert of priceAlerts) {
      const tokens = getUserTokens(alert.user_id);
      const webSubs = getUserWebSubs(alert.user_id);
      const user = getUserById(alert.user_id);
      const emailEnabled = Boolean(user?.email_alerts);
      if (!tokens.length && !webSubs.length && !emailEnabled) continue;

      const windowDays = Number(alert.window_days || 1);
      let series;
      try {
        series = await getForexSeries(alert.pair, Math.max(2, windowDays));
      } catch (error) {
        continue;
      }
      const points = series.points || [];
      if (points.length < 2) continue;

      const last = points[points.length - 1].value;
      const first = points[0].value;

      if (alert.type === 'price') {
        const hit =
          (alert.direction === 'above' && last >= alert.value) ||
          (alert.direction === 'below' && last <= alert.value);
        if (hit) {
          const key = `${alert.pair}:${last}`;
          if (alert.last_sent_key === key) continue;
          db.prepare('UPDATE price_alerts SET last_sent_key = ? WHERE id = ?').run(
            key,
            alert.id
          );
          const message = `${alert.pair} is ${alert.direction} ${alert.value}`;
          await sendExpoPush(tokens, 'Price alert', message, { pair: alert.pair });
          await sendWebPush(webSubs, 'Price alert', message, { pair: alert.pair });
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Price alert',
              `<p>${message}</p>`
            );
          }
        }
      }

      if (alert.type === 'percent') {
        const changePct = ((last - first) / first) * 100;
        const threshold = Number(alert.value);
        const hit =
          (alert.direction === 'above' && changePct >= threshold) ||
          (alert.direction === 'below' && changePct <= -threshold);
        if (hit) {
          const key = `${alert.pair}:${changePct.toFixed(2)}`;
          if (alert.last_sent_key === key) continue;
          db.prepare('UPDATE price_alerts SET last_sent_key = ? WHERE id = ?').run(
            key,
            alert.id
          );
          const message = `${alert.pair} moved ${changePct.toFixed(2)}% over ${windowDays}d`;
          await sendExpoPush(tokens, 'Percent alert', message, { pair: alert.pair });
          await sendWebPush(webSubs, 'Percent alert', message, { pair: alert.pair });
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Percent alert',
              `<p>${message}</p>`
            );
          }
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
  if (isAdminEmail(email)) {
    return res.status(403).json({ error: 'Admin account must be created by the server.' });
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
    'INSERT INTO users (id, email, name, password_hash, created_at, email_alerts) VALUES (?, ?, ?, ?, ?, 0)'
  ).run(user.id, user.email, user.name, user.password_hash, user.created_at);

  const token = createToken(user, false);

  return res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name, isAdmin: false, emailAlerts: false },
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const normalized = String(email || '').toLowerCase();
  const isAdmin = isAdminEmail(normalized);
  if (isAdmin) {
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    let user = getUserByEmail(normalized);
    if (!user) {
      const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      user = {
        id: crypto.randomUUID(),
        email: normalized,
        name: normalized.split('@')[0],
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      };
      db.prepare(
        'INSERT INTO users (id, email, name, password_hash, created_at, email_alerts) VALUES (?, ?, ?, ?, ?, 0)'
      ).run(user.id, user.email, user.name, user.password_hash, user.created_at);
    }
    const token = createToken(user, true);
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: true,
        emailAlerts: Boolean(user.email_alerts),
      },
    });
  }

  const user = getUserByEmail(normalized);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  const token = createToken(user, false);
  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: false,
      emailAlerts: Boolean(user.email_alerts),
    },
  });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = req.user;
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: Boolean(req.isAdmin),
      emailAlerts: Boolean(user.email_alerts),
    },
  });
});

app.patch('/api/users/me', requireAuth, (req, res) => {
  const { emailAlerts } = req.body || {};
  if (typeof emailAlerts !== 'boolean') {
    return res.status(400).json({ error: 'emailAlerts must be boolean.' });
  }
  db.prepare('UPDATE users SET email_alerts = ? WHERE id = ?').run(emailAlerts ? 1 : 0, req.user.id);
  const user = getUserById(req.user.id);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: Boolean(req.isAdmin),
      emailAlerts: Boolean(user.email_alerts),
    },
  });
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

app.get('/api/push/vapid-public-key', (_req, res) => {
  if (!VAPID_PUBLIC_KEY) {
    return res.status(500).json({ error: 'VAPID not configured.' });
  }
  return res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/push/web/subscribe', requireAuth, (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Subscription endpoint required.' });
  }
  try {
    db.prepare(
      'INSERT INTO web_push_subscriptions (id, user_id, endpoint, subscription_json, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
      crypto.randomUUID(),
      req.user.id,
      subscription.endpoint,
      JSON.stringify(subscription),
      new Date().toISOString()
    );
  } catch (error) {
    // Ignore duplicates.
  }
  return res.json({ ok: true });
});

app.get('/api/announcements', (_req, res) => {
  const rows = db
    .prepare('SELECT id, title, body, created_at FROM announcements WHERE active = 1 ORDER BY created_at DESC')
    .all();
  res.json({ announcements: rows });
});

app.post('/api/announcements', requireAuth, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const { title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO announcements (id, title, body, active, created_at) VALUES (?, ?, ?, 1, ?)'
  ).run(id, title.trim(), body.trim(), new Date().toISOString());
  res.json({ ok: true, id });
});

app.delete('/api/announcements/:id', requireAuth, (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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

app.get('/api/price-alerts', requireAuth, (req, res) => {
  const rows = db
    .prepare('SELECT id, pair, type, direction, value, window_days, created_at FROM price_alerts WHERE user_id = ?')
    .all(req.user.id);
  res.json({ alerts: rows });
});

app.post('/api/price-alerts', requireAuth, (req, res) => {
  const { pair, type, direction, value, windowDays } = req.body || {};
  if (!pair || !type || !direction || !value) {
    return res.status(400).json({ error: 'pair, type, direction, value are required.' });
  }
  if (!['price', 'percent'].includes(type)) {
    return res.status(400).json({ error: 'Invalid alert type.' });
  }
  if (!['above', 'below'].includes(direction)) {
    return res.status(400).json({ error: 'Invalid direction.' });
  }
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO price_alerts (id, user_id, pair, type, direction, value, window_days, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'
  ).run(
    id,
    req.user.id,
    String(pair).toUpperCase(),
    type,
    direction,
    Number(value),
    Number(windowDays || 1),
    new Date().toISOString()
  );
  res.json({ ok: true, id });
});

app.delete('/api/price-alerts/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM price_alerts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});

setInterval(runAlertChecks, ALERT_POLL_MS);
