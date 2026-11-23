const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 8787);
const WEB_APP_URL = 'https://lexo-11.vercel.app';

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(35000)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const exercises = [
  { word: 'on my way', example: 'I’m on my way. See you soon!', choices: ['Я уже в пути', 'Я скоро усну', 'Я дома'], correct: 0 },
  { word: 'give it a try', example: 'I’ve never done it, but I’ll give it a try.', choices: ['Отдать это', 'Попробовать', 'Отказаться'], correct: 1 },
  { word: 'sounds good', example: 'Meet at six? Sounds good!', choices: ['Слишком громко', 'Сомневаюсь', 'Отлично, договорились'], correct: 2 },
  { word: 'catch up', example: 'Let’s catch up over coffee.', choices: ['Давай пообщаемся за кофе', 'Давай заварим кофе', 'Давай поторопимся'], correct: 0 },
  { word: 'take your time', example: 'No rush. Take your time.', choices: ['Возьми часы', 'Не торопись', 'Поторопись'], correct: 1 },
  { word: 'fair enough', example: 'You need another day? Fair enough.', choices: ['Это ярмарка', 'Совсем нет', 'Это понятно'], correct: 2 },
  { word: 'keep in mind', example: 'Keep in mind that the shop closes at six.', choices: ['Имей в виду', 'Забудь об этом', 'Скажи громче'], correct: 0 }
];

const openButton = { text: '▶️ Открыть LEXO', web_app: { url: WEB_APP_URL } };
const menu = [[openButton], [{ text: '🧩 Слово дня', callback_data: 'word' }]];
const send = (chatId, text, keyboard = menu) => telegram('sendMessage', {
  chat_id: chatId,
  text,
  reply_markup: { inline_keyboard: keyboard }
});

function sendWord(chatId) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const day = Date.parse(date + 'T00:00:00Z') / 86400000;
  const index = day % exercises.length;
  const item = exercises[index];
  return send(chatId,
    `🧩 Слово дня — ${item.word}\n\n${item.example}\n\nКак перевести выражение?`,
    [...item.choices.map((text, choice) => [{ text, callback_data: `word:${index}:${choice}` }]), [openButton]]
  );
}

function getSub(userId) {
  try {
    const file = path.join(__dirname, 'data', 'subs.json');
    const sub = JSON.parse(fs.readFileSync(file, 'utf8'))[String(userId)];
    if (sub && ['plus', 'pro'].includes(sub.plan) && sub.planUntil > Date.now()) return sub;
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('subs:', error.name);
  }
  return { plan: 'free', planUntil: null };
}

async function handle(update) {
  if (update.pre_checkout_query) {
    return telegram('answerPreCheckoutQuery', {
      pre_checkout_query_id: update.pre_checkout_query.id,
      ok: false,
      error_message: 'Оплата LEXO пока отключена.'
    });
  }

  const callback = update.callback_query;
  if (callback) {
    await telegram('answerCallbackQuery', { callback_query_id: callback.id });
    const chat = callback.message?.chat;
    if (chat?.type !== 'private') return;
    if (callback.data === 'word') return sendWord(chat.id);

    const match = /^word:([0-6]):([0-2])$/.exec(callback.data || '');
    if (!match) return;
    const item = exercises[Number(match[1])];
    const correct = Number(match[2]) === item.correct;
    return telegram('editMessageText', {
      chat_id: chat.id,
      message_id: callback.message.message_id,
      text: `${correct ? '✅ Верно!' : '💡 Правильный ответ'}\n\n${item.word} — ${item.choices[item.correct]}.\n${item.example}`,
      reply_markup: { inline_keyboard: [[openButton]] }
    });
  }

  const message = update.message;
  if (message?.chat.type !== 'private' || !message.text) return;
  const chatId = message.chat.id;
  switch (message.text.trim().split(/[\s@]/)[0]) {
    case '/word':
      return sendWord(chatId);
    case '/help':
      return send(chatId, '🦎 /start — открыть LEXO\n/word — слово дня\n/plan — подписки');
    case '/plan':
      return send(chatId, 'Plus и Pro пока можно активировать бесплатно на 30 дней прямо в LEXO.');
    default:
      return send(chatId, '🦎 Привет! Я Лекс. Практикуй английский в Mini App или попробуй задание дня прямо здесь.');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let status = 404;
  let body = { error: 'not found' };
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    status = 200;
    body = { ok: true, paymentsEnabled: false };
  } else if (req.method === 'GET' && url.pathname === '/api/plan') {
    const id = url.searchParams.get('userId');
    status = id && /^\d+$/.test(id) ? 200 : 400;
    body = status === 200 ? getSub(id) : { error: 'valid userId required' };
  } else if (url.pathname === '/api/invoice') {
    status = 503;
    body = { error: 'payments_disabled' };
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
});

async function start() {
  await telegram('deleteWebhook');
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query']
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handle(update);
        } catch (error) {
          console.error('Update:', error.message);
        }
      }
    } catch (error) {
      console.error('Polling:', error.message);
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }
}

if (require.main === module) {
  if (!TOKEN) {
    console.error('Нет BOT_TOKEN');
    process.exit(1);
  }
  server.listen(PORT, '0.0.0.0');
  start().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { handle, server };
