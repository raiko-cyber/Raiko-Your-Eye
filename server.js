'use strict';
/*
 * Raiko-Your Eye: сервер.
 * Отдаёт страницу приложения из папки public и пересылает снимки ИИ-модели.
 * Ключ ИИ хранится только здесь, на сервере, и в телефон не попадает.
 * Зависимостей нет: нужен только Node.js 18 или новее.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// Читаем настройки из файла .env, если он есть
(function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

const PORT = Number(process.env.PORT) || 3000;
// Какой ИИ использовать. По умолчанию Gemini (у него есть бесплатный уровень).
// Если задан только ключ Anthropic, приложение само переключится на Claude.
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const PROVIDER = (process.env.PROVIDER || (GEMINI_KEY ? 'gemini' : ANTHROPIC_KEY ? 'anthropic' : 'gemini')).trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'gemini';
const API_KEY = PROVIDER === 'anthropic' ? ANTHROPIC_KEY : GEMINI_KEY;
// gemini-3.5-flash-lite: отвечает за 2–6 секунд. gemini-3.8-flash в ноябре 2026 часто была перегружена (ошибка 503).
const MODEL = (process.env.MODEL || '').trim() || (PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'gemini-3.5-flash-lite');
const BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
// Общий предел на всех пользователей сразу, чтобы чужие не израсходовали бесплатный лимит ключа
const GLOBAL_LIMIT_PER_MIN = Number(process.env.GLOBAL_LIMIT_PER_MIN) || 60;
const GEO_BASE = (process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org').replace(/\/+$/, '');
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

const LANGS = { kk: 'Kazakh', ru: 'Russian', en: 'English' };
const MODES = new Set(['around', 'text', 'thing', 'question']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function systemPrompt(language) {
  return 'You are Raiko-Your Eye, the eyes of a blind or low-vision person. ' +
    'You get one frame from their phone camera. Answer only in ' + language + '. ' +
    'Talk to the person directly in plain spoken sentences: no lists, no markdown, no emoji, because your answer is read aloud. ' +
    'Say the most important thing first. If there are obstacles, steps, kerbs, cars or other hazards, name them first. ' +
    'Give positions as left, right, straight ahead, near or far. ' +
    'Never say that the way is clear, safe or free of danger: one frame cannot prove that, and the person may rely on it. ' +
    'Only name hazards you actually see. If the frame shows only a close object or sign and not the path, say that the path is not visible. ' +
    'Never guess who a person is: describe only clothing and what they are doing. ' +
    'If the picture is too dark, blurry or cut off, say so and say how to point the camera. ' +
    'Do not mention that you are an AI or that this is a photo.';
}

function taskPrompt(mode, question, language) {
  if (mode === 'text') {
    return 'Task: read aloud all the text in the picture in reading order, exactly as written. ' +
      'If it is not in ' + language + ', add a short translation into ' + language + ' after it. ' +
      'If there is no text, say so. Keep the whole answer under 160 words.';
  }
  if (mode === 'thing') {
    return 'Task: name the main object in the centre of the picture and its key details: colour, brand or label text, ' +
      'the denomination and currency if it is money, the expiry date if one is visible. Keep it under 60 words.';
  }
  if (mode === 'question') {
    return 'The person asks: "' + question + '". Answer exactly this question from what you see. Keep it under 70 words.';
  }
  return 'Task: describe what is in front of the person so they can understand the place and move safely. Keep it under 70 words.';
}

// Простое ограничение частоты запросов, чтобы чужие не потратили ваш ключ
// Ограничитель: не больше perIp запросов в минуту с одного телефона и globalMax на всех вместе
function makeLimiter(perIp, globalMax) {
  const byIp = new Map();
  let all = [];
  setInterval(() => {
    const now = Date.now();
    for (const [ip, list] of byIp) { if (!list.some((t) => now - t < 60000)) byIp.delete(ip); }
  }, 60000).unref();
  return function (ip) {
    const now = Date.now();
    all = all.filter((t) => now - t < 60000);
    if (all.length >= globalMax) return false;
    const list = (byIp.get(ip) || []).filter((t) => now - t < 60000);
    if (list.length >= perIp) { byIp.set(ip, list); return false; }
    list.push(now); byIp.set(ip, list); all.push(now);
    return true;
  };
}
const hits = new Map();
let globalHits = [];
// Адрес телефона. За прокси хостинга (Render, Cloudflare) настоящий адрес приходит в заголовке.
function clientIp(req) {
  const h = req.headers;
  return String(h['cf-connecting-ip'] || h['true-client-ip'] || String(h['x-forwarded-for'] || '').split(',')[0]).trim() ||
    req.socket.remoteAddress || 'unknown';
}
function allowed(ip) {
  const now = Date.now();
  globalHits = globalHits.filter((t) => now - t < 60000);
  if (globalHits.length >= GLOBAL_LIMIT_PER_MIN) return false;
  const list = (hits.get(ip) || []).filter((t) => now - t < 60000);
  if (list.length >= LIMIT_PER_MIN) { hits.set(ip, list); return false; }
  list.push(now);
  hits.set(ip, list);
  globalHits.push(now);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of hits) {
    if (!list.some((t) => now - t < 60000)) hits.delete(ip);
  }
}, 60000).unref();

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store'
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { code: 'too_large' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Запасные модели Gemini: если основная перегружена (ошибка 503/429) или долго молчит,
// сервер сам пробует следующую. Список можно поменять в .env: FALLBACK_MODELS=модель1,модель2
const FALLBACK_MODELS = (process.env.FALLBACK_MODELS === undefined ? 'gemini-3.5-flash,gemini-3.8-flash' : process.env.FALLBACK_MODELS)
  .split(',').map((s) => s.trim()).filter((s) => s && s !== MODEL);
const TRY_TIMEOUT = Number(process.env.AI_TIMEOUT_SEC) * 1000 || 15000;
// Короткое «размышление» модели: ответ приходит быстрее. Пустое значение в .env отключает.
const THINKING = process.env.THINKING_LEVEL === undefined ? 'low' : process.env.THINKING_LEVEL.trim();

// Один запрос к одной модели Gemini. Возвращает { text } или { status, detail } при ошибке.
async function askGeminiModel(model, image, system, task, thinking) {
  const payload = {
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'image/jpeg', data: image } },
        { text: system + '\n\n' + task }
      ]
    }]
  };
  if (thinking) payload.generationConfig = { thinkingConfig: { thinkingLevel: thinking } };
  let r;
  try {
    r = await fetch(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TRY_TIMEOUT)
    });
  } catch (e) {
    return { status: 504, detail: 'нет ответа: ' + e.message };
  }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 400);
    // Если модель не поддерживает настройку размышления, повторяем без неё
    if (r.status === 400 && thinking && /thinking/i.test(detail)) return askGeminiModel(model, image, system, task, '');
    return { status: r.status, detail };
  }
  const data = await r.json();
  const first = Array.isArray(data.candidates) ? data.candidates[0] : null;
  const parts = first && first.content && Array.isArray(first.content.parts) ? first.content.parts : [];
  return { text: parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join(' ').trim() };
}

// Запрос к Gemini с переходом на запасные модели.
async function askGemini(image, system, task) {
  let last = { status: 502, detail: 'нет моделей' };
  for (const model of [MODEL].concat(FALLBACK_MODELS)) {
    const t0 = Date.now();
    const out = await askGeminiModel(model, image, system, task, THINKING);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (!out.status && out.text) { console.log('Ответ от ' + model + ' за ' + sec + ' с'); return out; }
    console.error('Модель ' + model + ' не ответила (' + (out.status || 'пустой ответ') + ') за ' + sec + ' с');
    last = out.status ? out : { status: 502, detail: 'пустой ответ' };
    // Неверный ключ или неверный запрос: другие модели не помогут
    const retryable = !out.status || out.status === 429 || out.status === 404 || out.status >= 500;
    if (!retryable) break;
  }
  return last;
}

// Запрос к Claude (Anthropic). Возвращает { text } или { status, detail } при ошибке.
async function askClaude(image, system, task) {
  const r = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: system,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
          { type: 'text', text: task }
        ]
      }]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) return { status: r.status, detail: (await r.text()).slice(0, 400) };
  const data = await r.json();
  return { text: (Array.isArray(data.content) ? data.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim() };
}

// ---------- Озвучка на сервере (Gemini TTS) ----------
// Голос телефона часто не умеет по-казахски, поэтому звук делает Gemini тем же ключом.
// Gemini отдаёт WAV (или «сырой» звук PCM, который мы оборачиваем в WAV). MP3 без сторонних библиотек не сделать.
const TTS_MODELS = (process.env.TTS_MODELS || 'gemini-3.8-flash-lite-tts,gemini-3.8-flash-tts')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TTS_VOICE = (process.env.TTS_VOICE || 'Kore').trim();
const TTS_TIMEOUT = Number(process.env.TTS_TIMEOUT_SEC) * 1000 || 15000;
const TTS_MAX_CHARS = 600;
// Озвучка дешевле и короче запросов к ИИ, а на один ответ идёт 1–4 куска, поэтому у неё свои пределы
const speakLimit = makeLimiter(Number(process.env.SPEAK_LIMIT_PER_MIN) || 60, Number(process.env.SPEAK_GLOBAL_LIMIT_PER_MIN) || 200);
// Небольшой кеш: одинаковые фразы (сообщения об ошибках, «Повторить») не озвучиваются заново
const ttsCache = new Map();
function cachePut(k, v) {
  ttsCache.set(k, v);
  if (ttsCache.size > 60) ttsCache.delete(ttsCache.keys().next().value);
}

function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Необязательное уменьшение звука (например TTS_RATE=12000 в .env): файл вдвое меньше и быстрее грузится.
// По умолчанию выключено: проверка показала, что при 12 000 казахская речь становится похожей на киргизскую.
const TTS_RATE = Number(process.env.TTS_RATE) || 0;
function shrinkWav(buf) {
  try {
    if (!TTS_RATE || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return buf;
    let pos = 12, fmt = null, dataStart = -1, dataLen = 0;
    while (pos + 8 <= buf.length) {
      const id = buf.toString('latin1', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
      if (id === 'fmt ') fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
      if (id === 'data') { dataStart = pos + 8; dataLen = Math.min(size, buf.length - dataStart); break; }
      pos += 8 + size + (size % 2);
    }
    if (!fmt || dataStart < 0 || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16) return buf;
    const k = fmt.rate / TTS_RATE;
    if (!Number.isInteger(k) || k < 2) return buf;
    const n = Math.floor(dataLen / 2 / k), out = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) {
      let sum = 0; // среднее из k соседних отсчётов — простой фильтр, убирает лишний писк
      for (let j = 0; j < k; j++) sum += buf.readInt16LE(dataStart + (i * k + j) * 2);
      out.writeInt16LE(Math.round(sum / k), i * 2);
    }
    return pcmToWav(out, TTS_RATE);
  } catch (e) { return buf; }
}

async function ttsOnce(model, text) {
  let r;
  try {
    r = await fetch(GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } }
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT)
    });
  } catch (e) { return { status: 504, detail: e.message }; }
  if (!r.ok) return { status: r.status, detail: (await r.text()).slice(0, 300) };
  const d = await r.json();
  const first = Array.isArray(d.candidates) ? d.candidates[0] : null;
  const parts = first && first.content && Array.isArray(first.content.parts) ? first.content.parts : [];
  const part = parts.find((p) => p && (p.inlineData || p.inline_data));
  if (!part) return { status: 502, detail: 'нет звука в ответе' };
  const inl = part.inlineData || part.inline_data;
  const mime = String(inl.mimeType || inl.mime_type || '');
  let audio = Buffer.from(inl.data || '', 'base64');
  if (audio.length < 100) return { status: 502, detail: 'пустой звук' };
  // Если пришёл «сырой» звук без заголовка, оборачиваем в WAV
  if (audio.slice(0, 4).toString('latin1') !== 'RIFF') {
    const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
    audio = pcmToWav(audio, rate);
  }
  return { audio: shrinkWav(audio) };
}

// ---------- Казахский голос: Piper (бесплатно, работает на этом компьютере, без интернета) ----------
// Голос kk_KZ-issai-high от ISSAI (KazakhTTS), 6 дикторов: 0 и 1 мужские, 2–5 женские.
// Файлы лежат в папке piper/ (в GitHub не попадают, см. .gitignore). Если их нет, казахский идёт через Gemini TTS.
const { spawn } = require('child_process');
const PIPER_EXE = process.env.PIPER_EXE || path.join(__dirname, 'piper', 'piper', process.platform === 'win32' ? 'piper.exe' : 'piper');
const PIPER_MODEL = process.env.PIPER_MODEL || path.join(__dirname, 'piper', 'kk_KZ-issai-high.onnx');
const PIPER_SPEAKER = String(Number(process.env.PIPER_SPEAKER) || 0);
const PIPER_RATE = 22050;
const HAS_PIPER = fs.existsSync(PIPER_EXE) && fs.existsSync(PIPER_MODEL);

function piperSpeak(text) {
  return new Promise((resolve) => {
    let done = false, p;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      // --output_raw: звук без заголовка идёт в stdout, временные файлы не нужны
      p = spawn(PIPER_EXE, ['--model', PIPER_MODEL, '--speaker', PIPER_SPEAKER, '--output_raw'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return finish({ error: e.message }); }
    const chunks = [];
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (e) {} finish({ error: 'piper timeout' }); }, 20000);
    p.stdout.on('data', (c) => chunks.push(c));
    p.stderr.on('data', (c) => { err += c; if (err.length > 2000) err = err.slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); finish({ error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (code !== 0 || pcm.length < 1000) return finish({ error: 'piper code ' + code + ' ' + err.slice(-200) });
      finish({ audio: pcmToWav(pcm, PIPER_RATE) });
    });
    p.stdin.on('error', () => {});
    p.stdin.end(text.replace(/[\r\n]+/g, ' ') + '\n', 'utf8');
  });
}

async function handleSpeak(req, res) {
  if (!speakLimit(clientIp(req))) return sendJson(res, 429, { error: 'busy' });
  if (!GEMINI_KEY) return sendJson(res, 500, { error: 'no_key' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'bad_request' }); }
  const lang = LANGS[body.lang] ? body.lang : 'ru';
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, TTS_MAX_CHARS);
  if (!text) return sendJson(res, 400, { error: 'bad_request' });

  const cacheKey = lang + '|' + text;
  let audio = ttsCache.get(cacheKey);
  // Казахский: сначала Piper. Если он не сработал, ниже пробуем Gemini TTS.
  if (!audio && lang === 'kk' && HAS_PIPER) {
    const t0 = Date.now();
    const out = await piperSpeak(text);
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    if (out.audio) { audio = out.audio; cachePut(cacheKey, audio); console.log('Озвучка kk от Piper за ' + sec + ' с'); }
    else console.error('Piper не сработал (' + out.error + '), пробую Gemini TTS');
  }
  if (!audio) {
    let last = null;
    for (const model of TTS_MODELS) {
      const t0 = Date.now();
      const out = await ttsOnce(model, text);
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      if (out.audio) { audio = out.audio; console.log('Озвучка ' + lang + ' от ' + model + ' за ' + sec + ' с'); break; }
      console.error('Озвучка: ' + model + ' не ответила (' + out.status + ') за ' + sec + ' с');
      last = out;
      if (out.status === 400 || out.status === 401 || out.status === 403) break;
    }
    if (!audio) return sendJson(res, last && (last.status === 429 || last.status >= 500) ? 503 : 502, { error: 'tts_error' });
    cachePut(cacheKey, audio);
  }
  res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': audio.length, 'cache-control': 'no-store' });
  res.end(audio);
}

// Адрес по координатам: OpenStreetMap (Nominatim), бесплатно, без ключа.
const WHERE_WORDS = {
  ru: { near: 'Вы примерно здесь: ', house: 'дом ' },
  kk: { near: 'Сіз шамамен осы жердесіз: ', house: 'үй ' },
  en: { near: 'You are about here: ', house: '' }
};
async function handleWhere(req, res) {
  if (!allowed(clientIp(req))) return sendJson(res, 429, { error: 'busy' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: 'bad_request' }); }
  const lat = Number(body.lat), lon = Number(body.lon);
  const lang = WHERE_WORDS[body.lang] ? body.lang : 'ru';
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return sendJson(res, 400, { error: 'bad_request' });
  try {
    const url = GEO_BASE + '/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=' + lat.toFixed(6) + '&lon=' + lon.toFixed(6) + '&accept-language=' + (lang === 'kk' ? 'kk,ru' : lang);
    const r = await fetch(url, { headers: { 'user-agent': 'Raiko-Your-Eye/0.1 (assistive app prototype)' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) { console.error('Ошибка геокодера', r.status); return sendJson(res, 502, { error: 'geo_error' }); }
    const d = await r.json();
    const a = d.address || {};
    const w = WHERE_WORDS[lang];
    const street = a.road || a.pedestrian || a.footway || a.street || '';
    const place = a.amenity || a.shop || a.building || a.leisure || '';
    const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
    const city = a.city || a.town || a.village || a.municipality || a.county || '';
    const parts = [];
    if (place) parts.push(place);
    // По-казахски номер дома идёт перед словом: «5 үй», по-русски после: «дом 5»
    const house = a.house_number ? (lang === 'kk' ? ', ' + a.house_number + ' үй' : ', ' + w.house + a.house_number) : '';
    if (street) parts.push(street + house);
    if (area) parts.push(area);
    if (city) parts.push(city);
    const line = parts.length ? parts.join(', ') : (d.display_name || '');
    if (!line) return sendJson(res, 502, { error: 'geo_error' });
    return sendJson(res, 200, { text: w.near + line + '.' });
  } catch (e) {
    console.error('Не удалось обратиться к геокодеру:', e.message);
    return sendJson(res, 502, { error: 'geo_error' });
  }
}

async function handleLook(req, res) {
  if (!allowed(clientIp(req))) return sendJson(res, 429, { error: 'busy' });
  if (!API_KEY) return sendJson(res, 500, { error: 'no_key' });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (e) { return sendJson(res, e.code === 'too_large' ? 413 : 400, { error: 'bad_request' }); }

  const image = typeof body.image === 'string' ? body.image.replace(/^data:image\/\w+;base64,/, '') : '';
  const mode = MODES.has(body.mode) ? body.mode : 'around';
  const language = LANGS[body.lang] || LANGS.ru;
  const question = String(body.question || '').replace(/["\n\r]/g, ' ').trim().slice(0, 300);
  if (!image || image.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(image)) return sendJson(res, 400, { error: 'bad_request' });
  if (mode === 'question' && !question) return sendJson(res, 400, { error: 'bad_request' });

  try {
    const ask = PROVIDER === 'anthropic' ? askClaude : askGemini;
    const out = await ask(image, systemPrompt(language), taskPrompt(mode, question, language));
    if (out.status) {
      console.error('Ошибка ИИ-сервиса', out.status, out.detail);
      const keyProblem = out.status === 401 || out.status === 403 || (out.status === 400 && /api[ _]?key/i.test(out.detail));
      if (keyProblem) return sendJson(res, 502, { error: 'bad_key' });
      if (out.status === 429 || out.status === 503 || out.status === 504 || out.status === 529) return sendJson(res, 503, { error: 'ai_busy' });
      return sendJson(res, 502, { error: 'ai_error' });
    }
    if (!out.text) return sendJson(res, 502, { error: 'ai_error' });
    return sendJson(res, 200, { text: out.text });
  } catch (e) {
    console.error('Не удалось обратиться к ИИ-сервису:', e.message);
    return sendJson(res, 502, { error: 'ai_error' });
  }
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.png' ? 'public, max-age=86400' : 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, hasKey: Boolean(API_KEY), provider: PROVIDER, model: MODEL });
  if (pathname === '/api/speak') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'bad_request' });
    return handleSpeak(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'tts_error' }); });
  }
  if (pathname === '/api/where') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'bad_request' });
    return handleWhere(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'geo_error' }); });
  }
  if (pathname === '/api/look') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'bad_request' });
    return handleLook(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: 'ai_error' }); });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('Raiko-Your Eye запущен: http://localhost:' + PORT);
  console.log('ИИ: ' + (PROVIDER === 'anthropic' ? 'Claude' : 'Gemini') + ', модель ' + MODEL +
    (PROVIDER === 'gemini' && FALLBACK_MODELS.length ? ', запасные: ' + FALLBACK_MODELS.join(', ') : ''));
  console.log('Казахский голос: ' + (HAS_PIPER ? 'Piper (диктор ' + PIPER_SPEAKER + ')' : 'Gemini TTS (Piper не найден в папке piper/)'));
  if (!API_KEY) console.log('ВНИМАНИЕ: ключ ИИ не задан. Скопируйте .env.example в .env и впишите GEMINI_API_KEY.');
});
