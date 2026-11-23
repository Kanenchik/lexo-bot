const http = require('node:http');
const { authenticate, api, payment, deliver, db } = require('./service');
const TOKEN = process.env.BOT_TOKEN;
const PORT = Number(process.env.PORT || 8787);
const WEB_APP_URL = 'https://lexo-11.vercel.app';

async function telegram(method, payload = {}) {
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method:'POST', headers:{ 'Content-Type':'application/json' },
    body:JSON.stringify(payload), signal:AbortSignal.timeout(35000)
  });
  const data = await response.json();
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

const exercises = [
  { word:'on my way', example:'I’m on my way. See you soon!', choices:['Я уже в пути','Я скоро усну','Я дома'], correct:0 },
  { word:'give it a try', example:'I’ve never done it, but I’ll give it a try.', choices:['Отдать это','Попробовать','Отказаться'], correct:1 },
  { word:'sounds good', example:'Meet at six? Sounds good!', choices:['Слишком громко','Сомневаюсь','Отлично, договорились'], correct:2 },
  { word:'catch up', example:'Let’s catch up over coffee.', choices:['Давай пообщаемся за кофе','Давай заварим кофе','Давай поторопимся'], correct:0 },
  { word:'take your time', example:'No rush. Take your time.', choices:['Возьми часы','Не торопись','Поторопись'], correct:1 },
  { word:'fair enough', example:'You need another day? Fair enough.', choices:['Это ярмарка','Совсем нет','Это понятно'], correct:2 },
  { word:'keep in mind', example:'Keep in mind that the shop closes at six.', choices:['Имей в виду','Забудь об этом','Скажи громче'], correct:0 }
];
const openButton = { text:'▶️ Открыть LEXO', web_app:{ url:WEB_APP_URL } };
const menu = [[openButton], [{ text:'🧩 Слово дня', callback_data:'word' }]];
const send = (chatId, text, keyboard = menu) => telegram('sendMessage', {
  chat_id:chatId, text, reply_markup:{ inline_keyboard:keyboard }
});

function sendWord(chatId) {
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow' }).format(new Date());
  const day = Date.parse(date + 'T00:00:00Z') / 86400000;
  const index = day % exercises.length;
  const item = exercises[index];
  return send(chatId, `🧩 Слово дня — ${item.word}\n\n${item.example}\n\nКак перевести выражение?`,
    [...item.choices.map((text, choice)=>[{ text, callback_data:`word:${index}:${choice}` }]), [openButton]]);
}

async function handle(update) {
  if (update.pre_checkout_query) {
    const q = update.pre_checkout_query;
    const ok = await payment(q.from.id,q,false);
    return telegram('answerPreCheckoutQuery', {pre_checkout_query_id:q.id,ok,
      ...(!ok && {error_message:'Счёт недействителен. Откройте LEXO и создайте новый.'})});
  }
  const callback = update.callback_query;
  if (callback) {
    await telegram('answerCallbackQuery', { callback_query_id:callback.id });
    const chat = callback.message?.chat;
    if (chat?.type !== 'private') return;
    if (callback.data === 'word') return sendWord(chat.id);
    const match = /^word:([0-6]):([0-2])$/.exec(callback.data || '');
    if (!match) return;
    const item = exercises[Number(match[1])];
    const correct = Number(match[2]) === item.correct;
    return telegram('editMessageText', {
      chat_id:chat.id, message_id:callback.message.message_id,
      text:`${correct ? '✅ Верно!' : '💡 Правильный ответ'}\n\n${item.word} — ${item.choices[item.correct]}.\n${item.example}`,
      reply_markup:{ inline_keyboard:[[openButton]] }
    });
  }
  const message = update.message;
  if (message?.successful_payment) {
    if (!await payment(message.from.id,message.successful_payment,true)) console.error('Unmatched Telegram charge',update.update_id);
    return;
  }
  if (message?.chat.type !== 'private' || !message.text) return;
  const chatId = message.chat.id;
  switch (message.text.trim().split(/[\s@]/)[0]) {
    case '/paysupport': {
      const body = message.text.replace(/^\S+\s*/, '').trim();
      if (!body) return send(chatId,'Опишите вопрос после команды /paysupport. Например, /paysupport Купил Pro, а доступ не появился.');
      try {
        const ticket = await api('feedback',message.from,{kind:'payment',body},telegram);
        return send(chatId,'Обращение по оплате №'+ticket.id+' принято.');
      } catch (err) { return send(chatId,err.status ? err.message : 'Сервис временно недоступен. Повторите позже.'); }
    }
    case '/myid': return send(chatId,'ID этого чата: '+chatId);
    case '/word': return sendWord(chatId);
    case '/help': return send(chatId,'🦎 /start — открыть LEXO\n/word — слово дня\n/plan — подписки\n/paysupport — помощь с оплатой');
    case '/plan': return send(chatId,'В LEXO Plus доступен бесплатно, Pro — за 1 ⭐ на 30 дней. Откройте приложение и выберите подписку.');
    default: return send(chatId,'🦎 Привет! Я Лекс. Практикуй английский в Mini App или попробуй задание дня прямо здесь.');
  }
}

const server = http.createServer(async (req,res)=>{
  const reply = (status,body) => {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
    res.end(JSON.stringify(body));
  };
  res.setHeader('Access-Control-Allow-Origin',WEB_APP_URL);
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }
  try {
    if (req.method==='GET' && req.url==='/health') {
      await db.query('SELECT 1 FROM public.lexo_orders LIMIT 0');
      return reply(200,{ok:true});
    }
    const match = /^\/api\/(session|plan|progress|plus|promo|invoice|feedback)$/.exec(req.url);
    if (req.method!=='POST' || !match) return reply(404,{error:'Страница не найдена.'});
    const user = authenticate((req.headers.authorization || '').replace(/^tma /,''),TOKEN);
    const chunks = [];
    let size=0;
    for await (const chunk of req) {
      size+=chunk.length;
      if (size>1024*1024) return reply(413,{error:'Слишком большой запрос.'});
      chunks.push(chunk);
    }
    let body;
    try { body=JSON.parse(Buffer.concat(chunks).toString() || '{}'); }
    catch { return reply(400,{error:'Некорректный JSON.'}); }
    return reply(200,await api(match[1],user,body,telegram));
  } catch (err) {
    if (!err.status) console.error('API:',err.code || err.name, ['password authentication failed','tenant or user not found','timeout','timed out','invalid url','self-signed certificate','connection terminated','ssl','invalid port','client password must be a string'].find(reason=>String(err.message).toLowerCase().includes(reason)) || 'unknown',err.cause?.code || '');
    reply(err.status || 503,{error:err.status ? err.message : 'Сервис временно недоступен. Попробуйте ещё раз.'});
  }
});

async function notifyAdmin() {
  try { await deliver(telegram,process.env.ADMIN_CHAT_ID); }
  catch (err) { console.error('Feedback:',err.message); }
  setTimeout(notifyAdmin,5000);
}

async function start() {
  if (!TOKEN) throw new Error('Нет BOT_TOKEN');
  await telegram('deleteWebhook');
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram('getUpdates', {
        offset, timeout:25, allowed_updates:['message','callback_query','pre_checkout_query']
      });
      for (const update of updates) {
        try { await handle(update); }
        catch (error) {
          if (update.message?.successful_payment) throw error;
          console.error('Update:',error.message);
        }
        offset = update.update_id + 1;
      }
    } catch (error) {
      console.error('Polling:', error.message);
      await new Promise(resolve=>setTimeout(resolve,3000));
    }
  }
}

if (require.main === module) {
  if (!TOKEN) { console.error('Нет BOT_TOKEN'); process.exit(1); }
  if (!process.env.DATABASE_URL) throw new Error('Укажите DATABASE_URL');
  server.listen(PORT,'0.0.0.0');
  if (process.env.ADMIN_CHAT_ID) notifyAdmin();
  start().catch(error=>{ console.error(error.message); process.exit(1); });
}
module.exports = { handle, server };
