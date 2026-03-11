const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cheerio = require('cheerio');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

async function dbGet(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

async function dbAll(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function dbRun(sql, params = []) {
  await pool.query(sql, params);
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL not set');
  }
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      email_alerts INTEGER NOT NULL DEFAULT 0
    );`,
    `CREATE TABLE IF NOT EXISTS watchlist (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, symbol)
    );`,
    `CREATE TABLE IF NOT EXISTS push_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, token)
    );`,
    `CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      query TEXT,
      impact TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      last_sent_key TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS announcements (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS price_alerts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      pair TEXT NOT NULL,
      type TEXT NOT NULL,
      direction TEXT NOT NULL,
      value REAL NOT NULL,
      window_days INTEGER,
      active INTEGER NOT NULL DEFAULT 1,
      last_sent_key TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      subscription_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, endpoint)
    );`,
    `CREATE TABLE IF NOT EXISTS referral_codes (
      user_id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      referrer_user_id TEXT NOT NULL,
      referred_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(referrer_user_id, referred_user_id)
    );`,
    `CREATE TABLE IF NOT EXISTS alert_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      channel TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS calendar_reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL,
      time TEXT NOT NULL,
      currency TEXT,
      minutes_before INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      last_sent_key TEXT,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS community_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS community_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS forum_threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      tags TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS forum_replies (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE TABLE IF NOT EXISTS trade_journal (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      entry_price REAL,
      exit_price REAL,
      size REAL,
      pnl REAL,
      reasoning TEXT,
      created_at TEXT NOT NULL
    );`,
  ];

  for (const statement of statements) {
    await pool.query(statement);
  }
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

async function getUserByEmail(email) {
  return dbGet('SELECT * FROM users WHERE email = $1', [email]);
}

async function getUserById(id) {
  return dbGet('SELECT * FROM users WHERE id = $1', [id]);
}

async function getReferralCode(userId) {
  const row = await dbGet('SELECT code FROM referral_codes WHERE user_id = $1', [userId]);
  return row?.code || null;
}

async function getUserIdByReferralCode(code) {
  const row = await dbGet('SELECT user_id FROM referral_codes WHERE code = $1', [code]);
  return row?.user_id || null;
}

function createReferralCode(user) {
  const base = `${user.email}:${user.id}`;
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = (hash * 31 + base.charCodeAt(i)) % 1000000;
  }
  return `fx${Math.abs(hash).toString(36)}`;
}

async function ensureReferralCode(user) {
  const existing = await getReferralCode(user.id);
  if (existing) return existing;
  const code = createReferralCode(user);
  try {
    await dbRun(
      'INSERT INTO referral_codes (user_id, code, created_at) VALUES ($1, $2, $3)',
      [user.id, code, new Date().toISOString()]
    );
  } catch (error) {
    return await getReferralCode(user.id);
  }
  return code;
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await getUserById(payload.sub);
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

async function getLatestPrice(pair) {
  const normalizedPair = String(pair || '').toUpperCase();
  const [base, quote] = normalizedPair.split('/');
  if (!base || !quote) {
    throw new Error('Invalid pair');
  }
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('Price feed not configured');
  }
  const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(
    `${base}/${quote}`
  )}&apikey=${TWELVE_DATA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch price');
  }
  const payload = await response.json();
  if (payload?.status === 'error') {
    throw new Error(payload?.message || 'Failed to fetch price');
  }
  const value = Number(payload?.price);
  if (!Number.isFinite(value)) {
    throw new Error('No price available');
  }
  return { pair: normalizedPair, value, timestamp: Math.floor(Date.now() / 1000) };
}

async function getQuotes(symbols) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('Price feed not configured');
  }
  const list = String(symbols || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!list.length) {
    throw new Error('No symbols provided');
  }
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(
    list.join(',')
  )}&apikey=${TWELVE_DATA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch quotes');
  }
  const payload = await response.json();
  if (payload?.status === 'error') {
    throw new Error(payload?.message || 'Failed to fetch quotes');
  }
  const normalize = (entry) => ({
    symbol: entry.symbol,
    price: Number(entry.price),
    change: Number(entry.change),
    percent_change: Number(entry.percent_change),
    timestamp: entry.timestamp || null,
  });
  if (Array.isArray(payload)) {
    return payload.map(normalize).filter((item) => Number.isFinite(item.price));
  }
  if (payload && payload.symbol) {
    return [normalize(payload)].filter((item) => Number.isFinite(item.price));
  }
  return Object.values(payload || {}).map(normalize).filter((item) => Number.isFinite(item.price));
}

async function getCryptoFearGreed() {
  const response = await fetch('https://api.alternative.me/fng/?limit=1');
  if (!response.ok) {
    throw new Error('Failed to fetch fear & greed');
  }
  const payload = await response.json();
  const data = payload?.data?.[0];
  if (!data) {
    throw new Error('No fear & greed data');
  }
  return {
    value: Number(data.value),
    value_classification: data.value_classification,
    timestamp: data.timestamp,
  };
}

async function getTimeSeries(symbol, interval = '1h', outputsize = 24) {
  if (!TWELVE_DATA_API_KEY) {
    throw new Error('Price feed not configured');
  }
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    symbol
  )}&interval=${encodeURIComponent(interval)}&outputsize=${outputsize}&timezone=UTC&format=JSON&apikey=${TWELVE_DATA_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch time series');
  }
  const payload = await response.json();
  if (payload?.status === 'error') {
    throw new Error(payload?.message || 'Failed to fetch time series');
  }
  const points = (payload.values || [])
    .map((item) => ({
      datetime: item.datetime,
      value: Number(item.close),
    }))
    .filter((point) => Number.isFinite(point.value))
    .reverse();
  return { symbol, points };
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

app.get('/api/forex/price', async (req, res) => {
  try {
    const { pair } = req.query || {};
    const data = await getLatestPrice(pair);
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch latest price' });
  }
});

app.get('/api/market/quotes', async (req, res) => {
  try {
    const { symbols } = req.query || {};
    const data = await getQuotes(symbols);
    res.json({ items: data });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch quotes' });
  }
});

app.get('/api/market/series', async (req, res) => {
  try {
    const { symbols, interval, outputsize } = req.query || {};
    const list = String(symbols || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!list.length) {
      return res.status(400).json({ error: 'No symbols provided' });
    }
    const data = await Promise.all(
      list.map((symbol) =>
        getTimeSeries(symbol, String(interval || '1h'), Number(outputsize) || 24)
          .catch(() => ({ symbol, points: [] }))
      )
    );
    res.json({ items: data });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch market series' });
  }
});

app.get('/api/crypto/fear-greed', async (_req, res) => {
  try {
    const data = await getCryptoFearGreed();
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Failed to fetch fear & greed' });
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
          await dbRun('DELETE FROM web_push_subscriptions WHERE endpoint = $1', [
            subscription.endpoint,
          ]);
        }
      }
    })
  );
}

async function recordAlertEvent(userId, type, title, detail, channel) {
  try {
    await dbRun(
      'INSERT INTO alert_events (id, user_id, type, title, detail, channel, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [
        crypto.randomUUID(),
        userId,
        type,
        title,
        detail || null,
        channel || null,
        new Date().toISOString(),
      ]
    );
  } catch (error) {
    // Ignore event logging errors.
  }
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
    const alerts = await dbAll('SELECT * FROM alerts WHERE active = 1');
    const priceAlerts = await dbAll('SELECT * FROM price_alerts WHERE active = 1');
    const calendarReminders = await dbAll('SELECT * FROM calendar_reminders WHERE active = 1');

    if (!alerts.length && !priceAlerts.length && !calendarReminders.length) return;

    const news = await getForexFactoryNews();
    const calendar = await getForexFactoryCalendar();

    const userTokens = new Map();
    const userWebSubs = new Map();
    const getUserTokens = async (userId) => {
      if (!userTokens.has(userId)) {
        const rows = await dbAll('SELECT token FROM push_tokens WHERE user_id = $1', [userId]);
        userTokens.set(userId, rows.map((row) => row.token));
      }
      return userTokens.get(userId);
    };
    const getUserWebSubs = async (userId) => {
      if (!userWebSubs.has(userId)) {
        const rows = await dbAll(
          'SELECT subscription_json FROM web_push_subscriptions WHERE user_id = $1',
          [userId]
        );
        userWebSubs.set(userId, rows.map((row) => JSON.parse(row.subscription_json)));
      }
      return userWebSubs.get(userId);
    };

    for (const alert of alerts) {
      const tokens = await getUserTokens(alert.user_id);
      const webSubs = await getUserWebSubs(alert.user_id);

      const user = await getUserById(alert.user_id);
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
          await dbRun('UPDATE alerts SET last_sent_key = $1 WHERE id = $2', [key, alert.id]);
          await sendExpoPush(
            tokens,
            'News alert',
            match.title,
            { url: match.url }
          );
          if (tokens.length) {
            await recordAlertEvent(
              alert.user_id,
              'news',
              match.title,
              match.url || '',
              'push'
            );
          }
          await sendWebPush(
            webSubs,
            'News alert',
            match.title,
            { url: match.url }
          );
          if (webSubs.length) {
            await recordAlertEvent(
              alert.user_id,
              'news',
              match.title,
              match.url || '',
              'web'
            );
          }
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              `News alert: ${match.title}`,
              `<p>${match.title}</p><p><a href="${match.url}">Read source</a></p>`
            );
            await recordAlertEvent(
              alert.user_id,
              'news',
              match.title,
              match.url || '',
              'email'
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
          await dbRun('UPDATE alerts SET last_sent_key = $1 WHERE id = $2', [key, alert.id]);
          const title = `${match.currency || ''} ${match.event}`.trim();
          await sendExpoPush(
            tokens,
            'Calendar alert',
            title,
            { event: match.event }
          );
          if (tokens.length) {
            await recordAlertEvent(
              alert.user_id,
              'calendar',
              title,
              match.impact || '',
              'push'
            );
          }
          await sendWebPush(
            webSubs,
            'Calendar alert',
            title,
            { event: match.event }
          );
          if (webSubs.length) {
            await recordAlertEvent(
              alert.user_id,
              'calendar',
              title,
              match.impact || '',
              'web'
            );
          }
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Calendar alert',
              `<p>${title}</p><p>Impact: ${match.impact || 'n/a'}</p>`
            );
            await recordAlertEvent(
              alert.user_id,
              'calendar',
              title,
              match.impact || '',
              'email'
            );
          }
        }
      }
    }

    for (const reminder of calendarReminders) {
      const user = await getUserById(reminder.user_id);
      const emailEnabled = Boolean(user?.email_alerts);
      const tokens = await getUserTokens(reminder.user_id);
      const webSubs = await getUserWebSubs(reminder.user_id);
      if (!tokens.length && !webSubs.length && !emailEnabled) continue;

      const time = String(reminder.time || '');
      if (!time || time.toLowerCase().includes('all')) continue;
      const match = time.match(/(\\d{1,2}):(\\d{2})/);
      if (!match) continue;
      const now = new Date();
      const target = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        Number(match[1]),
        Number(match[2]),
        0
      );
      const trigger = new Date(target.getTime() - Number(reminder.minutes_before) * 60000);
      const diff = trigger.getTime() - now.getTime();
      if (diff > 60 * 1000 || diff < -2 * 60 * 1000) continue;

      const key = `${reminder.event}-${reminder.time}-${reminder.minutes_before}`;
      if (reminder.last_sent_key === key) continue;
      await dbRun('UPDATE calendar_reminders SET last_sent_key = $1 WHERE id = $2', [
        key,
        reminder.id,
      ]);

      const title = `${reminder.currency || ''} ${reminder.event}`.trim();
      const message = `${title} in ${reminder.minutes_before}m`;
      await sendExpoPush(tokens, 'Calendar reminder', message, { event: reminder.event });
      if (tokens.length) {
        await recordAlertEvent(reminder.user_id, 'calendar_reminder', message, '', 'push');
      }
      await sendWebPush(webSubs, 'Calendar reminder', message, { event: reminder.event });
      if (webSubs.length) {
        await recordAlertEvent(reminder.user_id, 'calendar_reminder', message, '', 'web');
      }
      if (emailEnabled && user?.email) {
        await sendEmailAlert(user.email, 'Calendar reminder', `<p>${message}</p>`);
        await recordAlertEvent(reminder.user_id, 'calendar_reminder', message, '', 'email');
      }
    }

    for (const alert of priceAlerts) {
      const tokens = await getUserTokens(alert.user_id);
      const webSubs = await getUserWebSubs(alert.user_id);
      const user = await getUserById(alert.user_id);
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
          await dbRun('UPDATE price_alerts SET last_sent_key = $1 WHERE id = $2', [
            key,
            alert.id,
          ]);
          const message = `${alert.pair} is ${alert.direction} ${alert.value}`;
          await sendExpoPush(tokens, 'Price alert', message, { pair: alert.pair });
          await sendWebPush(webSubs, 'Price alert', message, { pair: alert.pair });
          if (tokens.length) {
            await recordAlertEvent(alert.user_id, 'price', message, '', 'push');
          }
          if (webSubs.length) {
            await recordAlertEvent(alert.user_id, 'price', message, '', 'web');
          }
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Price alert',
              `<p>${message}</p>`
            );
            await recordAlertEvent(alert.user_id, 'price', message, '', 'email');
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
          await dbRun('UPDATE price_alerts SET last_sent_key = $1 WHERE id = $2', [
            key,
            alert.id,
          ]);
          const message = `${alert.pair} moved ${changePct.toFixed(2)}% over ${windowDays}d`;
          await sendExpoPush(tokens, 'Percent alert', message, { pair: alert.pair });
          await sendWebPush(webSubs, 'Percent alert', message, { pair: alert.pair });
          if (tokens.length) {
            await recordAlertEvent(alert.user_id, 'percent', message, '', 'push');
          }
          if (webSubs.length) {
            await recordAlertEvent(alert.user_id, 'percent', message, '', 'web');
          }
          if (emailEnabled && user?.email) {
            await sendEmailAlert(
              user.email,
              'Percent alert',
              `<p>${message}</p>`
            );
            await recordAlertEvent(alert.user_id, 'percent', message, '', 'email');
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
  const { email, password, name, refCode } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (isAdminEmail(email)) {
    return res.status(403).json({ error: 'Admin account must be created by the server.' });
  }
  if (await getUserByEmail(email)) {
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

  await dbRun(
    'INSERT INTO users (id, email, name, password_hash, created_at, email_alerts) VALUES ($1, $2, $3, $4, $5, 0)',
    [user.id, user.email, user.name, user.password_hash, user.created_at]
  );

  const userCode = await ensureReferralCode(user);
  if (refCode) {
    const referrerId = await getUserIdByReferralCode(String(refCode).trim());
    if (referrerId && referrerId !== user.id) {
      try {
        await dbRun(
          'INSERT INTO referrals (id, referrer_user_id, referred_user_id, created_at) VALUES ($1, $2, $3, $4)',
          [crypto.randomUUID(), referrerId, user.id, new Date().toISOString()]
        );
      } catch (error) {
        // Ignore duplicate referrals.
      }
    }
  }

  const token = createToken(user, false);

  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: false,
      emailAlerts: false,
      referralCode: userCode,
    },
  });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const normalized = String(email || '').toLowerCase();
  const isAdmin = isAdminEmail(normalized);
  if (isAdmin) {
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    let user = await getUserByEmail(normalized);
    if (!user) {
      const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
      user = {
        id: crypto.randomUUID(),
        email: normalized,
        name: normalized.split('@')[0],
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      };
      await dbRun(
        'INSERT INTO users (id, email, name, password_hash, created_at, email_alerts) VALUES ($1, $2, $3, $4, $5, 0)',
        [user.id, user.email, user.name, user.password_hash, user.created_at]
      );
    }
    const code = await ensureReferralCode(user);
    const token = createToken(user, true);
    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: true,
        emailAlerts: Boolean(user.email_alerts),
        referralCode: code,
      },
    });
  }

  const user = await getUserByEmail(normalized);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }
  const token = createToken(user, false);
  const code = await ensureReferralCode(user);
  return res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: false,
      emailAlerts: Boolean(user.email_alerts),
      referralCode: code,
    },
  });
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  const user = req.user;
  const code = await ensureReferralCode(user);
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: Boolean(req.isAdmin),
      emailAlerts: Boolean(user.email_alerts),
      referralCode: code,
    },
  });
});

app.patch('/api/users/me', requireAuth, async (req, res) => {
  const { emailAlerts } = req.body || {};
  if (typeof emailAlerts !== 'boolean') {
    return res.status(400).json({ error: 'emailAlerts must be boolean.' });
  }
  await dbRun('UPDATE users SET email_alerts = $1 WHERE id = $2', [
    emailAlerts ? 1 : 0,
    req.user.id,
  ]);
  const user = await getUserById(req.user.id);
  const code = await ensureReferralCode(user);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      isAdmin: Boolean(req.isAdmin),
      emailAlerts: Boolean(user.email_alerts),
      referralCode: code,
    },
  });
});

app.get('/api/referrals/me', requireAuth, async (req, res) => {
  const code = await ensureReferralCode(req.user);
  const totalRow = await dbGet(
    'SELECT COUNT(*) as count FROM referrals WHERE referrer_user_id = $1',
    [req.user.id]
  );
  const activeRow = await dbGet(
    `SELECT COUNT(DISTINCT r.referred_user_id) as count
     FROM referrals r
     JOIN watchlist w ON w.user_id = r.referred_user_id
     WHERE r.referrer_user_id = $1`,
    [req.user.id]
  );
  res.json({
    code,
    total: Number(totalRow?.count || 0),
    active: Number(activeRow?.count || 0),
  });
});

app.get('/api/watchlist', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT symbol FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ symbols: rows.map((row) => row.symbol) });
});

app.post('/api/watchlist', requireAuth, async (req, res) => {
  const { symbol } = req.body || {};
  if (!symbol) {
    return res.status(400).json({ error: 'Symbol is required.' });
  }
  const normalized = String(symbol).toUpperCase();
  try {
    await dbRun(
      'INSERT INTO watchlist (id, user_id, symbol, created_at) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), req.user.id, normalized, new Date().toISOString()]
    );
  } catch (error) {
    return res.status(409).json({ error: 'Already added.' });
  }
  return res.json({ ok: true, symbol: normalized });
});

app.delete('/api/watchlist/:symbol', requireAuth, async (req, res) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  await dbRun('DELETE FROM watchlist WHERE user_id = $1 AND symbol = $2', [
    req.user.id,
    symbol,
  ]);
  return res.json({ ok: true });
});

app.post('/api/push/register', requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || !platform) {
    return res.status(400).json({ error: 'Token and platform are required.' });
  }

  try {
    await dbRun(
      'INSERT INTO push_tokens (id, user_id, token, platform, created_at) VALUES ($1, $2, $3, $4, $5)',
      [crypto.randomUUID(), req.user.id, token, platform, new Date().toISOString()]
    );
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

app.post('/api/push/web/subscribe', requireAuth, async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription?.endpoint) {
    return res.status(400).json({ error: 'Subscription endpoint required.' });
  }
  try {
    await dbRun(
      'INSERT INTO web_push_subscriptions (id, user_id, endpoint, subscription_json, created_at) VALUES ($1, $2, $3, $4, $5)',
      [
        crypto.randomUUID(),
        req.user.id,
        subscription.endpoint,
        JSON.stringify(subscription),
        new Date().toISOString(),
      ]
    );
  } catch (error) {
    // Ignore duplicates.
  }
  return res.json({ ok: true });
});

app.get('/api/announcements', async (_req, res) => {
  const rows = await dbAll(
    'SELECT id, title, body, created_at FROM announcements WHERE active = 1 ORDER BY created_at DESC'
  );
  res.json({ announcements: rows });
});

app.post('/api/announcements', requireAuth, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const { title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO announcements (id, title, body, active, created_at) VALUES ($1, $2, $3, 1, $4)',
    [id, title.trim(), body.trim(), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.delete('/api/announcements/:id', requireAuth, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  await dbRun('DELETE FROM announcements WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/alerts', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT id, type, query, impact, active, created_at FROM alerts WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ alerts: rows });
});

app.post('/api/alerts', requireAuth, async (req, res) => {
  const { type, query, impact } = req.body || {};
  if (!type || !['news_keyword', 'calendar_impact'].includes(type)) {
    return res.status(400).json({ error: 'Invalid alert type.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO alerts (id, user_id, type, query, impact, active, created_at) VALUES ($1, $2, $3, $4, $5, 1, $6)',
    [id, req.user.id, type, query || null, impact || null, new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.delete('/api/alerts/:id', requireAuth, async (req, res) => {
  await dbRun('DELETE FROM alerts WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

app.get('/api/calendar-reminders', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT id, event, time, currency, minutes_before, created_at FROM calendar_reminders WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ reminders: rows });
});

app.post('/api/calendar-reminders', requireAuth, async (req, res) => {
  const { event, time, currency, minutesBefore } = req.body || {};
  if (!event || !time || !minutesBefore) {
    return res.status(400).json({ error: 'event, time, minutesBefore are required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO calendar_reminders (id, user_id, event, time, currency, minutes_before, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, 1, $7)',
    [
      id,
      req.user.id,
      String(event),
      String(time),
      currency ? String(currency) : null,
      Number(minutesBefore),
      new Date().toISOString(),
    ]
  );
  res.json({ ok: true, id });
});

app.delete('/api/calendar-reminders/:id', requireAuth, async (req, res) => {
  await dbRun('DELETE FROM calendar_reminders WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

app.get('/api/community/posts', async (_req, res) => {
  const posts = await dbAll(
    `SELECT p.id, p.title, p.body, p.created_at, u.name as author
     FROM community_posts p
     JOIN users u ON u.id = p.user_id
     ORDER BY p.created_at DESC`
  );
  res.json({ posts });
});

app.post('/api/community/posts', requireAuth, async (req, res) => {
  const { title, body } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO community_posts (id, user_id, title, body, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, req.user.id, String(title), String(body), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.get('/api/community/posts/:id/comments', async (req, res) => {
  const rows = await dbAll(
    `SELECT c.id, c.body, c.created_at, u.name as author
     FROM community_comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1
     ORDER BY c.created_at DESC`,
    [req.params.id]
  );
  res.json({ comments: rows });
});

app.post('/api/community/posts/:id/comments', requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body) {
    return res.status(400).json({ error: 'Body is required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO community_comments (id, post_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, req.params.id, req.user.id, String(body), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.get('/api/forum/threads', async (_req, res) => {
  const rows = await dbAll(
    `SELECT t.id, t.title, t.body, t.tags, t.pinned, t.created_at, u.name as author
     FROM forum_threads t
     JOIN users u ON u.id = t.user_id
     ORDER BY t.pinned DESC, t.created_at DESC`
  );
  res.json({ threads: rows });
});

app.post('/api/forum/threads', requireAuth, async (req, res) => {
  const { title, body, tags } = req.body || {};
  if (!title || !body) {
    return res.status(400).json({ error: 'Title and body are required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO forum_threads (id, user_id, title, body, tags, pinned, created_at) VALUES ($1, $2, $3, $4, $5, 0, $6)',
    [id, req.user.id, String(title), String(body), String(tags || ''), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.patch('/api/forum/threads/:id/pin', requireAuth, async (req, res) => {
  if (!req.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const { pinned } = req.body || {};
  if (typeof pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be boolean.' });
  }
  await dbRun('UPDATE forum_threads SET pinned = $1 WHERE id = $2', [
    pinned ? 1 : 0,
    req.params.id,
  ]);
  res.json({ ok: true });
});

app.get('/api/forum/threads/:id/replies', async (req, res) => {
  const rows = await dbAll(
    `SELECT r.id, r.body, r.created_at, u.name as author
     FROM forum_replies r
     JOIN users u ON u.id = r.user_id
     WHERE r.thread_id = $1
     ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json({ replies: rows });
});

app.post('/api/forum/threads/:id/replies', requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body) {
    return res.status(400).json({ error: 'Body is required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO forum_replies (id, thread_id, user_id, body, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, req.params.id, req.user.id, String(body), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.get('/api/chat/messages', async (_req, res) => {
  const rows = await dbAll(
    `SELECT m.id, m.body, m.created_at, u.name as author
     FROM chat_messages m
     JOIN users u ON u.id = m.user_id
     ORDER BY m.created_at DESC
     LIMIT 100`
  );
  res.json({ messages: rows.reverse() });
});

app.post('/api/chat/messages', requireAuth, async (req, res) => {
  const { body } = req.body || {};
  if (!body) {
    return res.status(400).json({ error: 'Body is required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO chat_messages (id, user_id, body, created_at) VALUES ($1, $2, $3, $4)',
    [id, req.user.id, String(body), new Date().toISOString()]
  );
  res.json({ ok: true, id });
});

app.get('/api/trades', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT id, symbol, entry_price, exit_price, size, pnl, reasoning, created_at FROM trade_journal WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json({ trades: rows });
});

app.post('/api/trades', requireAuth, async (req, res) => {
  const { symbol, entryPrice, exitPrice, size, pnl, reasoning } = req.body || {};
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required.' });
  }
  const id = crypto.randomUUID();
  await dbRun(
    'INSERT INTO trade_journal (id, user_id, symbol, entry_price, exit_price, size, pnl, reasoning, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [
      id,
      req.user.id,
      String(symbol).toUpperCase(),
      entryPrice ? Number(entryPrice) : null,
      exitPrice ? Number(exitPrice) : null,
      size ? Number(size) : null,
      pnl ? Number(pnl) : null,
      reasoning ? String(reasoning) : null,
      new Date().toISOString(),
    ]
  );
  res.json({ ok: true, id });
});

app.delete('/api/trades/:id', requireAuth, async (req, res) => {
  await dbRun('DELETE FROM trade_journal WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

app.get('/api/price-alerts', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT id, pair, type, direction, value, window_days, created_at FROM price_alerts WHERE user_id = $1',
    [req.user.id]
  );
  res.json({ alerts: rows });
});

app.get('/api/alert-events', requireAuth, async (req, res) => {
  const limit = Math.max(10, Math.min(200, Number(req.query?.limit) || 50));
  const rows = await dbAll(
    'SELECT id, type, title, detail, channel, created_at FROM alert_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
    [req.user.id, limit]
  );
  res.json({ events: rows });
});

app.get('/api/recap/weekly', requireAuth, async (req, res) => {
  const rows = await dbAll(
    'SELECT symbol FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  const pairs = rows.map((row) => row.symbol);
  const movers = [];
  for (const pair of pairs) {
    try {
      const series = await getForexSeries(pair, 7);
      const points = series.points || [];
      if (points.length < 2) continue;
      const first = points[0].value;
      const last = points[points.length - 1].value;
      const changePct = ((last - first) / first) * 100;
      movers.push({ pair, changePct });
    } catch (error) {
      // skip
    }
  }
  movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  res.json({ movers: movers.slice(0, 5) });
});

app.post('/api/price-alerts', requireAuth, async (req, res) => {
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
  await dbRun(
    'INSERT INTO price_alerts (id, user_id, pair, type, direction, value, window_days, active, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8)',
    [
      id,
      req.user.id,
      String(pair).toUpperCase(),
      type,
      direction,
      Number(value),
      Number(windowDays || 1),
      new Date().toISOString(),
    ]
  );
  res.json({ ok: true, id });
});

app.delete('/api/price-alerts/:id', requireAuth, async (req, res) => {
  await dbRun('DELETE FROM price_alerts WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  res.json({ ok: true });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API listening on http://localhost:${PORT}`);
    });
    setInterval(runAlertChecks, ALERT_POLL_MS);
  })
  .catch((error) => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });
