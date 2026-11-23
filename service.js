const crypto = require('node:crypto');
const { Pool } = require('pg');
const db = new Pool({ connectionString:process.env.DATABASE_URL, max:5, connectionTimeoutMillis:4000 });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function authenticate(raw, token) {
  const fields = new URLSearchParams(raw || '');
  const hash = fields.get('hash') || '';
  fields.delete('hash');
  const check = [...fields].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => k+'='+v).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(token).digest();
  const expected = crypto.createHmac('sha256',secret).update(check).digest();
  const age = Date.now()/1000 - Number(fields.get('auth_date'));
  if (!/^[0-9a-f]{64}$/.test(hash) || !crypto.timingSafeEqual(expected,Buffer.from(hash,'hex')) ||
      !Number.isFinite(age) || age < -60 || age > 86400) fail(401,'Откройте LEXO заново из Telegram.');
  const user = JSON.parse(fields.get('user') || 'null');
  if (!Number.isSafeInteger(user?.id) || user.id <= 0) fail(401,'Нужен вход через Telegram.');
  return user;
}

async function transaction(fn) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) { await c.query('ROLLBACK'); throw err; }
  finally { c.release(); }
}
async function profile(c,u) {
  const {rows:[p]} = await c.query(`INSERT INTO public.profiles(telegram_id,username,first_name,last_name)
    VALUES ($1,$2,$3,$4) ON CONFLICT(telegram_id) DO UPDATE SET username=excluded.username,
    first_name=excluded.first_name,last_name=excluded.last_name RETURNING id,cefr_level,theme`,
    [u.id,u.username,u.first_name,u.last_name]);
  await c.query('INSERT INTO public.lexo_access(profile_id) VALUES($1) ON CONFLICT DO NOTHING',[p.id]);
  return p;
}
async function plan(c,id) {
  const {rows:[r]} = await c.query('SELECT plus_until,pro_until FROM public.lexo_access WHERE profile_id=$1',[id]);
  for (const name of ['pro','plus']) {
    const until = Number(r[name+'_until']);
    if (until > Date.now()) return {plan:name,planUntil:until};
  }
  return {plan:'free',planUntil:null};
}
async function addFeedback(c,id,kind,body) {
  if (!['bug','idea','payment'].includes(kind) || typeof body !== 'string' || !body.trim() || body.trim().length>2000)
    fail(400,'Введите сообщение длиной до 2000 символов.');
  const recent = await c.query("SELECT 1 FROM public.lexo_feedback WHERE profile_id=$1 AND created_at > now()-interval '10 seconds'",[id]);
  if (recent.rowCount) fail(429,'Подождите несколько секунд перед отправкой.');
  const {rows:[ticket]} = await c.query('INSERT INTO public.lexo_feedback(profile_id,kind,body) VALUES($1,$2,$3) RETURNING id',[id,kind,body.trim()]);
  return ticket;
}
const themes = { night:'Dark',ocean:'Ocean',mango:'Mango',tropics:'Tropics' };
async function getPrices() {
  const {rows} = await db.query('SELECT plan,stars FROM public.lexo_prices');
  return Object.fromEntries(rows.map(({plan,stars})=>[plan,stars]));
}

async function api(route,u,b,tg) {
  if (route === 'prices') return getPrices();
  const result = await transaction(async c=>{
    const p = await profile(c,u), id = p.id;
    if (route === 'session') {
      const {rows:[r]} = await c.query('SELECT * FROM public.user_progress WHERE profile_id=$1',[id]);
      const existing = r && { xp:r.xp, streak:r.current_streak, hearts:r.lives, level:p.cefr_level,
        theme:Object.keys(themes).find(k=>themes[k]===p.theme) };
      return {telegramId:u.id,state:r?.app_state || null, existing, revision:r?.revision || 0, ...await plan(c,id)};
    }
    if (route === 'progress') {
      const s = b.state;
      if (!s || !Number.isSafeInteger(b.revision) || ![s.xp,s.streak,s.hearts].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=2147483647)
        || !Array.isArray(s.completed) || !['A1','A2','B1','B2','C1','C2'].includes(s.level)) fail(400,'Некорректный прогресс.');
      delete s.plan; delete s.planUntil; delete s.usedPromos;
      await c.query('INSERT INTO public.user_progress(profile_id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
      const {rows:[r]} = await c.query(`UPDATE public.user_progress SET app_state=$2,revision=revision+1,xp=$3,
        current_streak=$4,best_streak=greatest(best_streak,$4),lives=$5,lessons_completed=greatest(lessons_completed,$6),
        last_activity_date=coalesce($7,last_activity_date),updated_at=now() WHERE profile_id=$1 AND revision=$8 RETURNING revision`,
        [id,s,s.xp,s.streak,s.hearts,s.completed.length,s.lastStudy,b.revision]);
      if (!r) fail(409,'Прогресс изменился на другом устройстве. Откройте приложение заново.');
      await c.query('UPDATE public.profiles SET cefr_level=$2,theme=coalesce($3,theme),updated_at=now() WHERE id=$1',[id,s.level,themes[s.theme]]);
      return r;
    }
    if (route === 'plus') {
      const {rows:[price]} = await c.query("SELECT stars FROM public.lexo_prices WHERE plan='plus' FOR SHARE");
      if (price.stars!==0) fail(409,'Plus теперь платный. Откройте актуальные тарифы через /plan в чате бота.');
      await c.query(`UPDATE public.lexo_access SET plus_until=now()+interval '30 days'
        WHERE profile_id=$1 AND (plus_until IS NULL OR plus_until<=now())`,[id]);
    } else if (route === 'promo') {
      const code = String(b.code || '').trim().toLowerCase();
      const {rows:[promo]} = await c.query(`SELECT days, new_only, max_uses, expires_at <= now() AS expired, p.created_at >= now()-interval '24 hours' AS fresh
        FROM public.lexo_promos, public.profiles p WHERE code=$1 AND enabled AND p.id=$2 FOR UPDATE OF lexo_promos`,[code,id]);
      if (!promo) fail(404,'Промокод не найден.');
      if (promo.new_only && !promo.fresh) fail(400,'Этот код доступен в первые 24 часа после регистрации.');
      if (promo.expired) fail(400,'Срок действия промокода истёк.');
      const used = await c.query('INSERT INTO public.lexo_redemptions(profile_id,code) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,code]);
      if (!used.rowCount) fail(409,'Этот код уже использован.');
      if (promo.max_uses !== null) {
        const {rows:[{uses}]} = await c.query('SELECT count(*) AS uses FROM public.lexo_redemptions WHERE code=$1',[code]);
        if (Number(uses)>promo.max_uses) fail(409,'Лимит активаций промокода исчерпан.');
      }
      await c.query("UPDATE public.lexo_access SET plus_until=greatest(now(),plus_until)+$2*interval '24 hours' WHERE profile_id=$1",[id,promo.days]);
    } else if (route === 'invoice') {
      const tier = b.plan ?? 'pro';
      const expected = b.stars ?? (b.plan == null ? 1 : null);
      if (!['plus','pro'].includes(tier) || !Number.isInteger(expected) || expected<1)
        fail(400,'Не удалось подтвердить цену. Откройте тарифы заново.');
      const {rows:[order]} = await c.query(`INSERT INTO public.lexo_orders(profile_id,plan,stars)
        SELECT $1,plan,stars FROM public.lexo_prices WHERE plan=$2 AND stars=$3
        RETURNING id,plan,stars`,[id,tier,expected]);
      if (!order) fail(409,'Цена изменилась. Откройте тарифы заново.');
      return order;
    } else if (route === 'feedback') return addFeedback(c,id,b.kind,b.body);
    else if (route !== 'plan') fail(404,'Страница не найдена.');
    return plan(c,id);
  });
  if (route !== 'invoice') return result;
  const title = result.plan==='plus'?'LEXO Plus':'LEXO Pro';
  return {url:await tg('createInvoiceLink',{title,description:'Доступ на 30 дней. Разовая покупка.',payload:result.id,
    provider_token:'',currency:'XTR',prices:[{label:title+' · 30 дней',amount:result.stars}]})};
}

async function payment(userId,p,success) {
  if (p.currency!=='XTR' || !/^[0-9a-f-]{36}$/.test(p.invoice_payload || '')) return false;
  return transaction(async c=>{
    const {rows:[o]} = await c.query(`SELECT o.* FROM public.lexo_orders o JOIN public.profiles p ON p.id=o.profile_id
      WHERE o.id=$1 AND p.telegram_id=$2 FOR UPDATE OF o`,[p.invoice_payload,userId]);
    if (!o || p.total_amount!==o.stars) return false;
    if (!success) {
      if (o.charge || !p.id || Date.now()-Number(o.created_at)>=3600000 || (o.checkout_id && o.checkout_id!==p.id)) return false;
      await c.query('UPDATE public.lexo_orders SET checkout_id=$2 WHERE id=$1',[o.id,p.id]);
      return true;
    }
    if (o.charge) return o.charge===p.telegram_payment_charge_id;
    if (!p.telegram_payment_charge_id) return false;
    await c.query('UPDATE public.lexo_orders SET charge=$2,paid_at=now() WHERE id=$1',[o.id,p.telegram_payment_charge_id]);
    const expiry = o.plan==='plus'?'plus_until':'pro_until';
    await c.query(`UPDATE public.lexo_access SET ${expiry}=greatest(now(),${expiry})+interval '30 days' WHERE profile_id=$1`,[o.profile_id]);
    return true;
  });
}

async function deliver(tg,admin) {
  return transaction(async c=>{
    const {rows:[r]} = await c.query(`SELECT f.*,p.telegram_id,p.username FROM public.lexo_feedback f
      JOIN public.profiles p ON p.id=f.profile_id WHERE delivered_at IS NULL ORDER BY f.id LIMIT 1 FOR UPDATE OF f SKIP LOCKED`);
    if (!r) return;
    const label = {bug:'Ошибка',idea:'Предложение',payment:'Оплата'}[r.kind];
    await tg('sendMessage',{chat_id:admin,text:'#'+r.id+' · '+label+'\n'+(r.username?'@'+r.username+' · ':'')+r.telegram_id+'\n\n'+r.body});
    await c.query('UPDATE public.lexo_feedback SET delivered_at=now() WHERE id=$1',[r.id]);
  });
}
module.exports = {authenticate,api,payment,deliver,db,getPrices};


