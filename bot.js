/* ═══════════════════════════════════════════════════════════
   LEXO BOT · сервер приёма оплаты Telegram Stars
   Ноль зависимостей:  node bot.js   (Node 18+)
   Переменные окружения:
     BOT_TOKEN    — токен бота (НИКОМУ не показывай)
     WEB_APP_URL  — адрес Mini App на Vercel
     PORT         — порт (по умолчанию 8787)
     PLUS_STARS   — цена Plus в звёздах (0 = активация бесплатно)
     PRO_STARS    — цена Pro в звёздах (1 для теста)
   ═══════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.BOT_TOKEN || '';
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://your-app.vercel.app';
const PORT = Number(process.env.PORT || 8787);
const DAYS = 30;
const PRICES = {
  plus: Number(process.env.PLUS_STARS ?? 0),
  pro:  Number(process.env.PRO_STARS ?? 1)
};
if (!TOKEN) { console.error('❌ Нет BOT_TOKEN'); process.exit(1); }

const API = `https://api.telegram.org/bot${TOKEN}`;
const call = async (method, payload = {}) => {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

/* ─────────── хранение подписок (файл data/subs.json) ─────────── */
const DATA_DIR = path.join(__dirname, 'data');
const SUBS_FILE = path.join(DATA_DIR, 'subs.json');
const loadSubs = () => { try { return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) { return {}; } };
const saveSubs = s => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SUBS_FILE, JSON.stringify(s, null, 2)); };
const getSub = userId => {
  const s = loadSubs()[String(userId)];
  if (!s || (s.planUntil && Date.now() > s.planUntil)) return { plan: 'free', planUntil: null };
  return s;
};
const setSub = (userId, plan) => {
  const all = loadSubs();
  all[String(userId)] = { plan, planUntil: plan === 'free' ? null : Date.now() + DAYS * 86400000 };
  saveSubs(all);
  return all[String(userId)];
};

/* ─────────── сообщения бота ─────────── */
const sendStart = chatId => call('sendMessage', {
  chat_id: chatId,
  text: '🦎 <b>LEXO</b> — английский с нуля прямо в Telegram.\n\n· 6 уровней от A1 до C2\n· слова, грамматика, письмо и живой сленг\n· умное повторение — слова не забываются\n· маскот Лекс, которого можно гладить\n\nЖми кнопку — и погнали!',
  parse_mode: 'HTML',
  reply_markup: { inline_keyboard: [[{ text: '▶️ Играть', web_app: { url: WEB_APP_URL } }]] }
});
const sendHelp = chatId => call('sendMessage', {
  chat_id: chatId,
  text: '❓ <b>Что умеет LEXO</b>\n\n/start — открыть приложение\n/plan — моя подписка\n\nВнутри приложения: уроки, умное повторение, ежедневные цели и подписки Plus/Pro за Telegram Stars.',
  parse_mode: 'HTML',
  reply_markup: { inline_keyboard: [[{ text: '▶️ Играть', web_app: { url: WEB_APP_URL } }]] }
});
const sendPlan = chatId => {
  const s = getSub(chatId);
  const when = s.planUntil ? new Date(s.planUntil).toLocaleDateString('ru-RU') : '—';
  return call('sendMessage', {
    chat_id: chatId,
    text: `💳 Твоя подписка: <b>LEXO ${s.plan.toUpperCase()}</b>${s.planUntil ? `\nДействует до: ${when}` : '\nБесплатный тариф'}`,
    parse_mode: 'HTML'
  });
};

/* ─────────── приём обновлений (long polling) ─────────── */
const handle = async u => {
  if (u.message && u.message.text) {
    const txt = u.message.text.trim();
    const id = u.message.chat.id;
    if (txt === '/start') return sendStart(id);
    if (txt === '/help') return sendHelp(id);
    if (txt === '/plan') return sendPlan(id);
    return sendStart(id);
  }
  /* подтверждение чекаута — обязательно, иначе платёж зависнет */
  if (u.pre_checkout_query) {
    return call('answerPreCheckoutQuery', { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
  }
  /* оплата прошла */
  if (u.message && u.message.successful_payment) {
    const sp = u.message.successful_payment;
    const [plan, userId] = String(sp.invoice_payload || '').split(':');
    if (!plan || !userId || !PRICES.hasOwnProperty(plan)) return;
    const sub = setSub(userId, plan);
    try {
      await call('sendMessage', {
        chat_id: userId,
        text: `🎉 Оплата получена! <b>LEXO ${plan.toUpperCase()}</b> активен до ${new Date(sub.planUntil).toLocaleDateString('ru-RU')}.\nОткрой приложение — всё уже включено.`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '▶️ Играть', web_app: { url: WEB_APP_URL } }]] }
      });
    } catch (e) { /* пользователь не нажал /start — не страшно, подписка уже записана */ }
  }
};

let offset = 0;
const poll = async () => {
  while (true) {
    try {
      const upd = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'pre_checkout_query'] });
      for (const u of upd) {
        offset = u.update_id + 1;
        try { await handle(u); } catch (e) { console.error('handler:', e.message); }
      }
    } catch (e) {
      console.error('poll:', e.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
};

/* ─────────── HTTP API для Mini App ─────────── */
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://localhost');
  const send = (obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  if (url.pathname === '/health') return send({ ok: true, prices: PRICES });

  if (url.pathname === '/api/plan') {
    const userId = url.searchParams.get('userId');
    if (!userId) return send({ error: 'userId required' }, 400);
    return send(getSub(userId));
  }

  if (url.pathname === '/api/invoice') {
    const plan = url.searchParams.get('plan');
    const userId = url.searchParams.get('userId');
    if (!plan || !userId) return send({ error: 'plan & userId required' }, 400);
    const stars = PRICES[plan];
    if (stars === undefined) return send({ error: 'unknown plan' }, 400);
    /* цена 0 = промо-активация без платежа */
    if (stars <= 0) return send({ granted: true, sub: setSub(userId, plan) });
    try {
      const link = await call('createInvoiceLink', {
        title: `LEXO ${plan === 'plus' ? 'Plus' : 'Pro'}`,
        description: plan === 'plus'
          ? '30 дней: сленг, умное повторение без лимита, 4 урока в день, 3 сердечка'
          : '30 дней: всё из Plus + Dynamic Context, безлимит уроков и все уровни',
        payload: `${plan}:${userId}`,
        currency: 'XTR',
        prices: [{ label: `LEXO ${plan.toUpperCase()} · 30 дней`, amount: stars }]
      });
      return send({ link });
    } catch (e) { return send({ error: e.message }, 500); }
  }

  return send({ error: 'not found' }, 404);
});

(async () => {
  try { await call('deleteWebhook', {}); } catch (e) {}
  const me = await call('getMe');
  console.log(`🦎 LEXO bot @${me.username} запущен · API на порту ${PORT} · цены: plus=${PRICES.plus}⭐ pro=${PRICES.pro}⭐`);
  server.listen(PORT);
  poll();
})();