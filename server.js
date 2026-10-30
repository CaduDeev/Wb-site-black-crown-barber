#!/usr/bin/env node
'use strict';

// Single-company deployment: keep one database and one upload directory per customer.
// Uses Node's built-in HTTP, crypto, and SQLite APIs; no runtime package install is needed.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const readline = require('node:readline');

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'black-crown.sqlite'));
const PORT = Math.max(1, Number(process.env.PORT || 4173));
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const SESSION_MS = 8 * 60 * 60 * 1000;
const MAX_BODY = 3 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const SESSIONS = new Map();
const ATTEMPTS = new Map();
const BOOKING_LIMITS = new Map();
const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, password_changed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL CHECK(price_cents >= 0), duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 5 AND 600), active INTEGER NOT NULL DEFAULT 1, image TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS professionals (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, specialties TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, image TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS professional_availability (professional_id INTEGER NOT NULL REFERENCES professionals(id) ON DELETE CASCADE, weekday INTEGER NOT NULL CHECK(weekday BETWEEN 0 AND 6), open_time TEXT NOT NULL, close_time TEXT NOT NULL, break_start TEXT NOT NULL DEFAULT '', break_end TEXT NOT NULL DEFAULT '', is_closed INTEGER NOT NULL DEFAULT 0 CHECK(is_closed IN (0,1)), PRIMARY KEY(professional_id,weekday));
CREATE TABLE IF NOT EXISTS appointments (id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, customer_name TEXT NOT NULL, phone TEXT NOT NULL, service_id INTEGER NOT NULL REFERENCES services(id), professional_id INTEGER NOT NULL REFERENCES professionals(id), day TEXT NOT NULL, time TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pendente', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, booked_service_name TEXT, booked_professional_name TEXT, booked_price_cents INTEGER, booked_duration_minutes INTEGER);
CREATE INDEX IF NOT EXISTS appointments_day_professional ON appointments(day, professional_id, status, time);
CREATE INDEX IF NOT EXISTS appointments_phone ON appointments(phone);
CREATE TABLE IF NOT EXISTS appointment_history (id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE, action TEXT NOT NULL, old_value TEXT, new_value TEXT, created_at TEXT NOT NULL);`);
const appointmentColumns=new Set(db.prepare('PRAGMA table_info(appointments)').all().map(c=>c.name));
for(const [name,type] of [['booked_service_name','TEXT'],['booked_professional_name','TEXT'],['booked_price_cents','INTEGER'],['booked_duration_minutes','INTEGER']]) if(!appointmentColumns.has(name)) db.exec(`ALTER TABLE appointments ADD COLUMN ${name} ${type}`);

const defaultSettings = {
  name: 'Black Crown Barber', address: 'Endereço a informar', phone: '', whatsapp: '', email: '',
  footer: '', timezone: 'America/Sao_Paulo', logoImage:'', primaryColor:'#b99b62', accentColor:'#d6c49d', bookingEnabled:true,
  hours: { open: '09:00', close: '19:00', breakStart: '12:00', breakEnd: '13:00', closedDays: [0] },
  privacyText: 'Os dados informados serão usados para tratar sua solicitação de agendamento.', demoMode: false, bookingPaused: true,
  siteContent: {heroEyebrow:'Black Crown Barber',heroTitle:'Seu estilo.\nSua identidade.',heroText:'Cortes, barba e cuidados masculinos com hora marcada, atendimento atento e acabamento na navalha.',aboutTitle:'Tradição no ofício, atenção ao detalhe',aboutText:'A Black Crown une técnicas clássicas de barbearia a serviços modernos de cabelo e barba. Cada atendimento começa por uma conversa sobre o que combina com você.',servicesTitle:'Cada detalhe, um ofício',servicesText:'Escolha um serviço e siga direto para o agendamento.',aboutEyebrow:'A barbearia',servicesEyebrow:'Serviços',teamEyebrow:'Equipe',teamTitle:'Quem cuida de você',teamText:'Especialistas para cada tipo de serviço.',galleryEyebrow:'Galeria',galleryTitle:'Referências de estilo',galleryText:'Conheça nosso trabalho.'}
};
const hadBookingPaused = Boolean(db.prepare("SELECT 1 FROM settings WHERE key='bookingPaused'").get());
const legacyDemoMode = db.prepare("SELECT value FROM settings WHERE key='demoMode'").get();
const legacyBookingEnabled = db.prepare("SELECT value FROM settings WHERE key='bookingEnabled'").get();
for (const [key, value] of Object.entries(defaultSettings)) {
  const initialValue = key === 'bookingPaused' && !hadBookingPaused
    ? (!legacyDemoMode || JSON.parse(legacyDemoMode.value) === true || !legacyBookingEnabled || JSON.parse(legacyBookingEnabled.value) !== true)
    : value;
  db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(initialValue));
}

function isoNow() { return new Date().toISOString(); }
function setting(key) { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : undefined; }
function setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
function settingsObject() { return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x => [x.key, JSON.parse(x.value)])); }
function bookingsActive() { return setting('bookingEnabled') === true && setting('bookingPaused') !== true; }
function publicSettings() { const all=settingsObject();return Object.fromEntries(['name','address','phone','whatsapp','email','footer','timezone','hours','privacyText','demoMode','bookingPaused','heroImage','galleryImages','logoImage','primaryColor','accentColor','bookingEnabled','siteContent'].filter(k=>Object.hasOwn(all,k)).map(k=>[k,all[k]])); }
function json(res, status, value, headers = {}) { res.writeHead(status, { ...JSON_HEADERS, ...headers }); res.end(JSON.stringify(value)); }
function fail(res, status, code, message) { json(res, status, { error: code, message }); }
function parseCookies(req) { return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => { const i=x.indexOf('='); return [x.slice(0,i), decodeURIComponent(x.slice(i+1))]; })); }
function csrfCheck(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { const u = new URL(origin); if (u.host === req.headers.host && ['http:','https:'].includes(u.protocol)) return true; } catch {}
  fail(res, 403, 'origin_rejected', 'Origem da solicitação não permitida.'); return false;
}
function session(req) {
  const token = parseCookies(req).bcb_session;
  if (!token) return null;
  const value = SESSIONS.get(token);
  if (!value || value.expires < Date.now()) { SESSIONS.delete(token); return null; }
  value.expires = Date.now() + SESSION_MS;
  return value;
}
function requireAdmin(req, res) { if (!session(req)) { fail(res, 401, 'unauthorized', 'Entre novamente para continuar.'); return null; } return session(req); }
function checkLogin(email, password, callback) {
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase());
  if (!user) return callback(false, null);
  crypto.scrypt(password, Buffer.from(user.salt, 'hex'), 64, (err, derived) => {
    if (err) return callback(false, null);
    callback(crypto.timingSafeEqual(derived, Buffer.from(user.password_hash, 'hex')), user);
  });
}
function validPhone(value) { return /^\+?[0-9 ()-]{10,20}$/.test(value); }
function mins(hhmm) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hhmm || '')) return NaN; const [h,m]=hhmm.split(':').map(Number); return h*60+m; }
function localDateTime() {
  const tz = setting('timezone') || 'America/Sao_Paulo';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(p => [p.type,p.value])); return { day:`${v.year}-${v.month}-${v.day}`, minute:Number(v.hour)*60+Number(v.minute) };
}
function availableSlots(day, professionalId, serviceId, excludeId = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isInteger(Number(professionalId)) || !Number.isInteger(Number(serviceId))) return [];
  const date = new Date(`${day}T12:00:00Z`); if (Number.isNaN(+date) || date.toISOString().slice(0,10)!==day) return [];
  const service = db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(Number(serviceId));
  const professional = db.prepare('SELECT * FROM professionals WHERE id=? AND active=1').get(Number(professionalId));
  if (!service || !professional) return [];
  const globalHours = setting('hours') || defaultSettings.hours;
  const weekday = date.getUTCDay();
  const personal = db.prepare('SELECT * FROM professional_availability WHERE professional_id=? AND weekday=?').get(Number(professionalId),weekday);
  const hours = personal ? {open:personal.open_time,close:personal.close_time,breakStart:personal.break_start,breakEnd:personal.break_end,closed:personal.is_closed===1} : {...globalHours,closed:(globalHours.closedDays||[]).includes(weekday)};
  if(hours.closed)return [];
  const open=mins(hours.open), close=mins(hours.close), bs=mins(hours.breakStart), be=mins(hours.breakEnd);
  if (![open,close].every(Number.isFinite) || close<=open) return [];
  const now=localDateTime(); const booked=db.prepare("SELECT a.id,a.time,a.service_id,COALESCE(a.booked_duration_minutes,s.duration_minutes) AS occupied_duration FROM appointments a JOIN services s ON s.id=a.service_id WHERE a.day=? AND a.professional_id=? AND a.status NOT IN ('Cancelado','Não compareceu') AND a.id<>?").all(day,Number(professionalId),excludeId);
  const slots=[];
  for (let t=open; t+service.duration_minutes<=close; t+=30) {
    if (Number.isFinite(bs)&&Number.isFinite(be)&&t<be&&t+service.duration_minutes>bs) continue;
    if (day<now.day || (day===now.day&&t<=now.minute)) continue;
    const collision=booked.some(b=>{const start=mins(b.time);return t<start+b.occupied_duration&&t+service.duration_minutes>start;});
    if (!collision) slots.push(`${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}`);
  }
  return slots;
}
function readBody(req) {
  return new Promise((resolve,reject)=>{let data='';req.on('data',chunk=>{data+=chunk;if(data.length>MAX_BODY){reject(Object.assign(new Error('body too large'),{status:413}));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(Object.assign(new Error('invalid json'),{status:400}));}});req.on('error',reject);});
}
function normalizeService(input, id) {
  const name=String(input.name||'').trim(), description=String(input.description||'').trim();
  const price=Number(input.price), duration=Number(input.duration), active=input.active;
  const image=String(input.image||'');
  if(name.length<2||name.length>80||description.length>500||!Number.isFinite(price)||price<0||price>100000||!Number.isInteger(duration)||duration<5||duration>600||typeof active!=='boolean'||(image!==''&&!/^\/uploads\/[\w-]+\.(?:jpg|png|webp)$/.test(image))) throw Object.assign(new Error('Confira nome, preço, duração, estado e imagem do serviço.'),{status:400});
  const priceCents=Math.round(price*100);
  if(id) { const result=db.prepare('UPDATE services SET name=?,description=?,price_cents=?,duration_minutes=?,active=?,image=? WHERE id=?').run(name,description,priceCents,duration,active?1:0,image,id); if(!result.changes)throw Object.assign(new Error('Serviço não encontrado.'),{status:404}); }
  else db.prepare('INSERT INTO services(name,description,price_cents,duration_minutes,active,image) VALUES(?,?,?,?,?,?)').run(name,description,priceCents,duration,active?1:0,String(input.image||''));
}
function normalizeProfessional(input, id) {
  const name=String(input.name||'').trim(), specialties=String(input.specialties||'').trim(), description=String(input.description||'').trim();
  const image=String(input.image||'');
  if(name.length<2||name.length>80||specialties.length>200||description.length>500||typeof input.active!=='boolean'||(image!==''&&!/^\/uploads\/[\w-]+\.(?:jpg|png|webp)$/.test(image))) throw Object.assign(new Error('Confira os dados, estado e imagem do profissional.'),{status:400});
  if(id) { const result=db.prepare('UPDATE professionals SET name=?,specialties=?,description=?,active=?,image=? WHERE id=?').run(name,specialties,description,input.active?1:0,image,id); if(!result.changes)throw Object.assign(new Error('Profissional não encontrado.'),{status:404}); }
  else db.prepare('INSERT INTO professionals(name,specialties,description,active,image) VALUES(?,?,?,?,?)').run(name,specialties,description,input.active?1:0,String(input.image||''));
}
async function route(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method=req.method||'GET', routePath=u.pathname.replace(/\/+$/, '') || '/';
  if (method==='GET' && u.pathname==='/admin/') { res.writeHead(308,{location:'/admin','cache-control':'no-store'}); return res.end(); }
  if (method==='GET' && routePath==='/api/health') return json(res,200,{ok:true,storage:'sqlite',adminConfigured:db.prepare('SELECT COUNT(*) AS n FROM users').get().n>0});
  if (method==='GET' && routePath==='/api/public/bootstrap') {
    const services=db.prepare('SELECT id,name,description,price_cents/100.0 AS price,duration_minutes AS duration,active,image FROM services WHERE active=1 ORDER BY id').all();
    const professionals=db.prepare('SELECT id,name,specialties,description,active,image FROM professionals WHERE active=1 ORDER BY id').all();
    return json(res,200,{settings:publicSettings(),services,professionals,demoData:setting('demoMode')===true});
  }
  if (method==='GET' && routePath==='/api/public/slots') return json(res,200,{slots:!bookingsActive()?[]:availableSlots(u.searchParams.get('date'),u.searchParams.get('professionalId'),u.searchParams.get('serviceId'))});
  if (method==='POST' && routePath==='/api/public/appointments') {
    if (!csrfCheck(req,res)) return;
    let b; try{b=await readBody(req);}catch(e){return fail(res,e.status||400,'invalid_request','Não foi possível ler a solicitação.');}
    if (!bookingsActive()) return fail(res,503,'booking_paused','Os agendamentos estão temporariamente indisponíveis.');
    const remote=req.socket.remoteAddress||'unknown', bucket=BOOKING_LIMITS.get(remote)||{count:0,until:Date.now()+5*60*1000};
    if(bucket.until<Date.now()){bucket.count=0;bucket.until=Date.now()+5*60*1000;}
    if(bucket.count>=12)return fail(res,429,'rate_limited','Muitas solicitações. Aguarde alguns minutos.');
    bucket.count++;BOOKING_LIMITS.set(remote,bucket);
    const name=String(b.name||'').trim(), phone=String(b.phone||'').trim(), key=String(b.idempotencyKey||'');
    const sid=Number(b.serviceId), pid=Number(b.professionalId), day=String(b.date||''), time=String(b.time||'');
    if(name.length<2||name.length>100||!validPhone(phone)||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)||!Number.isInteger(sid)||!Number.isInteger(pid)||!/^[0-9a-f-]{36}$/i.test(key)) return fail(res,400,'invalid_fields','Confira nome, telefone, serviço, profissional, data e horário.');
    const previous=db.prepare('SELECT id,status,day,time FROM appointments WHERE idempotency_key=?').get(key);
    if(previous) return json(res,200,{ok:true,appointment:previous,duplicate:true});
    db.exec('BEGIN IMMEDIATE');
    try {
      const service=db.prepare('SELECT id FROM services WHERE id=? AND active=1').get(sid);
      if(!service||!db.prepare('SELECT id FROM professionals WHERE id=? AND active=1').get(pid)) throw Object.assign(new Error('Serviço ou profissional indisponível.'),{status:400,code:'unavailable'});
      if(!availableSlots(day,pid,sid).includes(time)) throw Object.assign(new Error('Esse horário não está mais disponível. Escolha outro.'),{status:409,code:'slot_taken'});
      const id=crypto.randomUUID(), now=isoNow(),snapshot=db.prepare('SELECT s.name AS service_name,s.price_cents,s.duration_minutes,p.name AS professional_name FROM services s,professionals p WHERE s.id=? AND p.id=?').get(sid,pid);
      db.prepare("INSERT INTO appointments(id,idempotency_key,customer_name,phone,service_id,professional_id,day,time,status,created_at,updated_at,booked_service_name,booked_professional_name,booked_price_cents,booked_duration_minutes) VALUES(?,?,?,?,?,?,?,?, 'Pendente',?,?,?,?,?,?)").run(id,key,name,phone,sid,pid,day,time,now,now,snapshot.service_name,snapshot.professional_name,snapshot.price_cents,snapshot.duration_minutes);
      db.prepare('INSERT INTO appointment_history(appointment_id,action,new_value,created_at) VALUES(?,?,?,?)').run(id,'created','Pendente',now);
      db.exec('COMMIT'); return json(res,201,{ok:true,appointment:{id,status:'Pendente',date:day,time}});
    } catch(e) { db.exec('ROLLBACK'); return fail(res,e.status||500,e.code||'booking_failed',e.status?e.message:'Não foi possível registrar a solicitação.'); }
  }
  if (method==='POST' && routePath==='/api/admin/login') {
    if (!csrfCheck(req,res)) return;
    let b;try{b=await readBody(req);}catch{return fail(res,400,'invalid_request','Confira os dados informados.');}
    const email=String(b.email||'').trim().toLowerCase(), password=String(b.password||'');
    const rate=ATTEMPTS.get(email)||{count:0,until:0}; if(rate.until>Date.now()) return fail(res,429,'rate_limited','Muitas tentativas. Aguarde alguns minutos.');
    return checkLogin(email,password,(ok,user)=>{
      if(!ok){rate.count++;if(rate.count>=5){rate.count=0;rate.until=Date.now()+10*60*1000;}ATTEMPTS.set(email,rate);return fail(res,401,'login_failed','E-mail ou senha inválidos.');}
      ATTEMPTS.delete(email);const token=crypto.randomBytes(32).toString('base64url');SESSIONS.set(token,{userId:user.id,email:user.email,expires:Date.now()+SESSION_MS});
      const cookie=`bcb_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}${COOKIE_SECURE?'; Secure':''}`;
      return json(res,200,{ok:true,email:user.email},{'set-cookie':cookie});
    });
  }
  if (routePath.startsWith('/api/admin/')) {
    if(method!=='GET'&&!csrfCheck(req,res)) return;
    const admin=requireAdmin(req,res);if(!admin)return;
    if(method==='POST'&&routePath==='/api/admin/logout'){const token=parseCookies(req).bcb_session;SESSIONS.delete(token);return json(res,200,{ok:true},{'set-cookie':`bcb_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${COOKIE_SECURE?'; Secure':''}`});}
    if(method==='GET'&&routePath==='/api/admin/me')return json(res,200,{email:admin.email});
    if(method==='POST'&&routePath==='/api/admin/password'){
      let b;try{b=await readBody(req);}catch{return fail(res,400,'invalid_request','Confira os campos.');}
      if(String(b.newPassword||'').length<12)return fail(res,400,'weak_password','A nova senha precisa ter pelo menos 12 caracteres.');
      const user=db.prepare('SELECT * FROM users WHERE id=?').get(admin.userId);
      return checkLogin(user.email,String(b.currentPassword||''),(ok)=>{if(!ok)return fail(res,401,'wrong_password','Senha atual inválida.');const salt=crypto.randomBytes(16),now=isoNow();crypto.scrypt(String(b.newPassword),salt,64,(err,hash)=>{if(err)return fail(res,500,'password_error','Não foi possível atualizar a senha.');db.prepare('UPDATE users SET salt=?,password_hash=?,password_changed_at=? WHERE id=?').run(salt.toString('hex'),hash.toString('hex'),now,admin.userId);return json(res,200,{ok:true});});});
    }
    if(method==='GET'&&routePath==='/api/admin/dashboard'){
      const today=localDateTime().day;
      const bookings=db.prepare(`SELECT a.*,COALESCE(a.booked_service_name,s.name) AS service_name,COALESCE(a.booked_price_cents,s.price_cents)/100.0 AS price,COALESCE(a.booked_duration_minutes,s.duration_minutes) AS duration,COALESCE(a.booked_professional_name,p.name) AS professional_name FROM appointments a JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id ORDER BY a.day,a.time`).all();
      const customers=new Set(bookings.map(x=>x.phone));
      const pending=bookings.filter(x=>x.status==='Pendente').length;
      const revenue=bookings.filter(x=>x.status==='Concluído').reduce((n,x)=>n+x.price,0);
      const statusCounts=Object.fromEntries(['Pendente','Confirmado','Cliente chegou','Em atendimento','Concluído','Cancelado','Não compareceu'].map(k=>[k,bookings.filter(x=>x.status===k).length]));
      return json(res,200,{today,totalToday:bookings.filter(x=>x.day===today&&x.status!=='Cancelado').length,pending,customers:customers.size,revenue,statusCounts,bookings:bookings.filter(x=>x.day>=today).slice(0,8)});
    }
    if(method==='GET'&&routePath==='/api/admin/appointments'){
      const where=[],args=[];for(const [q,col] of [['date','a.day'],['professionalId','a.professional_id'],['status','a.status']]){const v=u.searchParams.get(q);if(v){where.push(`${col}=?`);args.push(q==='professionalId'?Number(v):v);}}
      const sql=`SELECT a.*,COALESCE(a.booked_service_name,s.name) AS service_name,COALESCE(a.booked_price_cents,s.price_cents)/100.0 AS price,COALESCE(a.booked_duration_minutes,s.duration_minutes) AS duration,COALESCE(a.booked_professional_name,p.name) AS professional_name FROM appointments a JOIN services s ON s.id=a.service_id JOIN professionals p ON p.id=a.professional_id ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY a.day,a.time`;
      return json(res,200,{appointments:db.prepare(sql).all(...args)});
    }
    if(method==='GET'&&routePath==='/api/admin/clients'){
      const rows=db.prepare(`SELECT a.phone,a.customer_name,a.day,a.time,a.status,COALESCE(a.booked_service_name,s.name) AS service_name,COALESCE(a.booked_price_cents,s.price_cents)/100.0 AS price FROM appointments a JOIN services s ON s.id=a.service_id ORDER BY a.day DESC,a.time DESC`).all();
      const clients=new Map();for(const a of rows){const c=clients.get(a.phone)||{phone:a.phone,name:a.customer_name,visits:0,spend:0,last:'',history:[]};c.visits++;if(a.status==='Concluído')c.spend+=a.price;if(a.day>c.last)c.last=a.day;c.history.push({date:a.day,time:a.time,service:a.service_name,status:a.status});clients.set(a.phone,c);}
      return json(res,200,{clients:[...clients.values()]});
    }
    if(method==='GET'&&routePath.startsWith('/api/admin/appointments/')&&routePath.endsWith('/history')){
      const id=routePath.split('/').at(-2);if(!db.prepare('SELECT id FROM appointments WHERE id=?').get(id))return fail(res,404,'not_found','Agendamento não encontrado.');
      return json(res,200,{history:db.prepare('SELECT action,old_value,new_value,created_at FROM appointment_history WHERE appointment_id=? ORDER BY id DESC').all(id)});
    }
    if(method==='PATCH'&&routePath.startsWith('/api/admin/appointments/')){
      const id=routePath.split('/').pop();let b;try{b=await readBody(req);}catch{return fail(res,400,'invalid_request','Confira a alteração.');}
      const ap=db.prepare('SELECT * FROM appointments WHERE id=?').get(id);if(!ap)return fail(res,404,'not_found','Agendamento não encontrado.');
      const allowed=['Pendente','Confirmado','Cliente chegou','Em atendimento','Concluído','Cancelado','Não compareceu'];
      const status=String(b.status||ap.status),day=String(b.date||ap.day),time=String(b.time||ap.time);
      if(!allowed.includes(status))return fail(res,400,'invalid_status','Status inválido.');
      if((day!==ap.day||time!==ap.time)&&status!=='Cancelado'&&!availableSlots(day,ap.professional_id,ap.service_id,id).includes(time))return fail(res,409,'slot_taken','O novo horário não está disponível.');
      const now=isoNow();db.prepare('UPDATE appointments SET status=?,day=?,time=?,updated_at=? WHERE id=?').run(status,day,time,now,id);
      db.prepare('INSERT INTO appointment_history(appointment_id,action,old_value,new_value,created_at) VALUES(?,?,?,?,?)').run(id,'updated',JSON.stringify({status:ap.status,date:ap.day,time:ap.time}),JSON.stringify({status,date:day,time}),now);
      return json(res,200,{ok:true});
    }
    if(method==='GET'&&routePath==='/api/admin/services')return json(res,200,{services:db.prepare('SELECT id,name,description,price_cents/100.0 AS price,duration_minutes AS duration,active,image FROM services ORDER BY id').all()});
    if((method==='POST'||method==='PUT')&&routePath==='/api/admin/services'){
      let b;try{b=await readBody(req);if(method==='PUT'&&(!Number.isSafeInteger(Number(b.id))||Number(b.id)<1))return fail(res,400,'invalid_service','Serviço inválido.');normalizeService(b,method==='PUT'?Number(b.id):0); }catch(e){return fail(res,e.status||400,'invalid_service',e.status?e.message:'Não foi possível salvar o serviço.');}
      return json(res,200,{ok:true,services:db.prepare('SELECT id,name,description,price_cents/100.0 AS price,duration_minutes AS duration,active,image FROM services ORDER BY id').all()});
    }
    if(method==='GET'&&routePath==='/api/admin/professionals')return json(res,200,{professionals:db.prepare('SELECT id,name,specialties,description,active,image FROM professionals ORDER BY id').all()});
    if((method==='POST'||method==='PUT')&&routePath==='/api/admin/professionals'){
      let b;try{b=await readBody(req);if(method==='PUT'&&(!Number.isSafeInteger(Number(b.id))||Number(b.id)<1))return fail(res,400,'invalid_professional','Profissional inválido.');normalizeProfessional(b,method==='PUT'?Number(b.id):0);}catch(e){return fail(res,e.status||400,'invalid_professional',e.status?e.message:'Não foi possível salvar o profissional.');}
      return json(res,200,{ok:true,professionals:db.prepare('SELECT id,name,specialties,description,active,image FROM professionals ORDER BY id').all()});
    }
    if(method==='GET'&&routePath==='/api/admin/professional-availability'){
      const id=Number(u.searchParams.get('professionalId'));if(!Number.isInteger(id)||id<1||!db.prepare('SELECT id FROM professionals WHERE id=?').get(id))return fail(res,404,'professional_not_found','Profissional não encontrado.');
      const globalHours=setting('hours')||defaultSettings.hours,stored=db.prepare('SELECT * FROM professional_availability WHERE professional_id=?').all(id),byDay=new Map(stored.map(x=>[x.weekday,x]));
      const schedule=Array.from({length:7},(_,weekday)=>{const x=byDay.get(weekday);return x?{weekday,open:x.open_time,close:x.close_time,breakStart:x.break_start,breakEnd:x.break_end,closed:Boolean(x.is_closed),inherited:false}:{weekday,open:globalHours.open,close:globalHours.close,breakStart:globalHours.breakStart||'',breakEnd:globalHours.breakEnd||'',closed:(globalHours.closedDays||[]).includes(weekday),inherited:true};});
      return json(res,200,{professionalId:id,schedule});
    }
    if(method==='PUT'&&routePath==='/api/admin/professional-availability'){
      let b;try{b=await readBody(req);}catch{return fail(res,400,'invalid_request','Confira a disponibilidade enviada.');}
      const id=Number(b.professionalId),rows=b.schedule;
      if(!Number.isInteger(id)||id<1||!db.prepare('SELECT id FROM professionals WHERE id=?').get(id))return fail(res,404,'professional_not_found','Profissional não encontrado.');
      if(!Array.isArray(rows)||rows.length!==7||new Set(rows.map(x=>Number(x.weekday))).size!==7||rows.some(x=>!Number.isInteger(Number(x.weekday))||Number(x.weekday)<0||Number(x.weekday)>6))return fail(res,400,'invalid_schedule','Envie uma configuração para cada dia da semana.');
      const normalized=[];
      for(const x of rows){const weekday=Number(x.weekday),closed=x.closed===true,open=String(x.open||''),close=String(x.close||''),breakStart=String(x.breakStart||''),breakEnd=String(x.breakEnd||'');
        if(!closed){const o=mins(open),c=mins(close),bs=breakStart?mins(breakStart):NaN,be=breakEnd?mins(breakEnd):NaN;if(!Number.isFinite(o)||!Number.isFinite(c)||c<=o||((breakStart||breakEnd)&&(!Number.isFinite(bs)||!Number.isFinite(be)||be<=bs||bs<o||be>c)))return fail(res,400,'invalid_schedule','Confira abertura, fechamento e intervalo de cada dia.');}
        normalized.push({weekday,open:closed?'00:00':open,close:closed?'00:00':close,breakStart:closed?'':breakStart,breakEnd:closed?'':breakEnd,closed});
      }
      db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM professional_availability WHERE professional_id=?').run(id);const insert=db.prepare('INSERT INTO professional_availability(professional_id,weekday,open_time,close_time,break_start,break_end,is_closed) VALUES(?,?,?,?,?,?,?)');for(const x of normalized)insert.run(id,x.weekday,x.open,x.close,x.breakStart,x.breakEnd,x.closed?1:0);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');return fail(res,500,'save_failed','Não foi possível salvar a disponibilidade.');}
      return json(res,200,{ok:true});
    }
    if(method==='GET'&&routePath==='/api/admin/settings')return json(res,200,{settings:settingsObject()});
    if(method==='PUT'&&routePath==='/api/admin/settings'){
      let b;try{b=await readBody(req);}catch{return fail(res,400,'invalid_settings','Não foi possível ler as configurações.');}
      const allowed=['name','address','phone','whatsapp','email','footer','timezone','hours','privacyText','demoMode','bookingPaused','bookingEnabled','logoImage','heroImage','galleryImages','primaryColor','accentColor','siteContent'];
      const normalized={};
      for(const key of allowed)if(Object.hasOwn(b,key)){
        if(key==='siteContent'){
          const supplied=b.siteContent;if(!supplied||typeof supplied!=='object'||Array.isArray(supplied))return fail(res,400,'invalid_content','Confira os textos do site.');
          const content={...defaultSettings.siteContent,...(setting('siteContent')||{})};
          for(const field of Object.keys(defaultSettings.siteContent))if(Object.hasOwn(supplied,field)){if(typeof supplied[field]!=='string'||supplied[field].length>500)return fail(res,400,'invalid_content','Um texto do site excede o limite permitido.');content[field]=supplied[field].trim();}
          normalized.siteContent=content;continue;
        }
        if(key==='hours'){
          const h=b.hours;if(!h||!Number.isFinite(mins(h.open))||!Number.isFinite(mins(h.close))||mins(h.close)<=mins(h.open)||!Array.isArray(h.closedDays)||h.closedDays.some(d=>!Number.isInteger(d)||d<0||d>6)||((h.breakStart||'')&& !Number.isFinite(mins(h.breakStart)))||((h.breakEnd||'')&&!Number.isFinite(mins(h.breakEnd))))return fail(res,400,'invalid_hours','Confira horários, intervalo e dias fechados.');
          if(Boolean(h.breakStart)!==Boolean(h.breakEnd)||(h.breakStart&&(mins(h.breakEnd)<=mins(h.breakStart)||mins(h.breakStart)<mins(h.open)||mins(h.breakEnd)>mins(h.close))))return fail(res,400,'invalid_hours','Informe o início e o fim do intervalo dentro do expediente.');
        }
        if(key==='timezone'){try{new Intl.DateTimeFormat('en',{timeZone:String(b[key])});}catch{return fail(res,400,'invalid_timezone','Fuso horário inválido.');}}
        if(key==='whatsapp'&&b[key]&&!/^\+?[0-9]{10,15}$/.test(String(b[key])))return fail(res,400,'invalid_whatsapp','Informe o WhatsApp com DDI e DDD, somente números.');
        if(['primaryColor','accentColor'].includes(key)&&!/^#[\da-f]{6}$/i.test(String(b[key])))return fail(res,400,'invalid_color','Use uma cor hexadecimal no formato #RRGGBB.');
        if(['demoMode','bookingPaused','bookingEnabled'].includes(key)&&typeof b[key]!=='boolean')return fail(res,400,'invalid_settings','Confira as opções de demonstração e agendamento.');
        if(key==='galleryImages'&&(!Array.isArray(b[key])||b[key].length>24||b[key].some(v=>typeof v!=='string'||!/^\/uploads\/[\w-]+\.(?:jpg|png|webp)$/.test(v))))return fail(res,400,'invalid_gallery','A galeria não pôde ser salva.');
        if(['heroImage','logoImage'].includes(key)&&b[key]!==''&&(typeof b[key]!=='string'||!/^\/uploads\/[\w-]+\.(?:jpg|png|webp)$/.test(b[key])))return fail(res,400,'invalid_image','Imagem inválida.');
        if(typeof b[key]==='string'&&b[key].length>500)return fail(res,400,'invalid_settings','Um dos campos excede o limite de tamanho.');
        normalized[key]=b[key];
      }
      db.exec('BEGIN IMMEDIATE');
      try{for(const [key,value] of Object.entries(normalized))setSetting(key,value);db.exec('COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
      return json(res,200,{ok:true,settings:settingsObject()});
    }
    if(method==='POST'&&routePath==='/api/admin/upload'){
      let b;try{b=await readBody(req);}catch(e){return fail(res,e.status||400,'upload_error','Arquivo inválido ou muito grande.');}
      const type=String(b.type||''), extension=({ 'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp' })[type];
      if(!extension||typeof b.data!=='string')return fail(res,400,'invalid_image','Use uma imagem JPEG, PNG ou WebP.');
      const bytes=Buffer.from(b.data,'base64');if(!bytes.length||bytes.length>MAX_IMAGE||bytes.toString('base64')!==b.data)return fail(res,400,'invalid_image','A imagem deve ter até 2 MB.');
      const name=crypto.randomUUID()+extension;fs.writeFileSync(path.join(UPLOAD_DIR,name),bytes,{flag:'wx'});return json(res,201,{ok:true,url:`/uploads/${name}`});
    }
    return fail(res,404,'not_found','Rota administrativa não encontrada.');
  }
  if(method==='GET'&&routePath.startsWith('/uploads/')){
    const name=path.basename(routePath.slice('/uploads/'.length));if(name!==routePath.slice('/uploads/'.length)||!/^[-\w]+\.(?:jpg|png|webp)$/.test(name))return fail(res,404,'not_found','Imagem não encontrada.');
    const file=path.join(UPLOAD_DIR,name);if(!fs.existsSync(file))return fail(res,404,'not_found','Imagem não encontrada.');
    const ext=path.extname(file);res.writeHead(200,{'content-type':({'.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'})[ext],'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'});return fs.createReadStream(file).pipe(res);
  }
  if(method==='GET'&&routePath==='/') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY'});return fs.createReadStream(path.join(ROOT,'index.html')).pipe(res); }
  if(method==='GET'&&routePath==='/admin') {
    let html=fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    // Render the login overlay in the initial response so /admin never depends
    // on a successful /api/admin/me request to reveal the login form.
    html=html.replace(/<div id="adm">/i,'<div id="adm" style="display:block">');
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY'});return res.end(html);
  }
  if(method==='GET'&&routePath==='/black-crown-barber.html') { res.writeHead(200,{'content-type':'text/html; charset=utf-8','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY'});return fs.createReadStream(path.join(ROOT,'index.html')).pipe(res); }
  if(method==='GET'&&routePath==='/app.js') { res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});return fs.createReadStream(path.join(ROOT,'app.js')).pipe(res); }
  if(method==='GET'&&routePath==='/site-config.js') { res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});return fs.createReadStream(path.join(ROOT,'site-config.js')).pipe(res); }
  if(method==='GET'&&['/black-crown-barber-app/app.js','/black-crown-barber-app/site-config.js'].includes(routePath)) { const file=routePath.endsWith('/app.js')?'app.js':'site-config.js';res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-cache','x-content-type-options':'nosniff'});return fs.createReadStream(path.join(ROOT,file)).pipe(res); }
  if(method==='GET'&&routePath==='/favicon.ico'){res.writeHead(204);return res.end();}
  return fail(res,404,'not_found','Página não encontrada.');
}

const server=http.createServer((req,res)=>{route(req,res).catch(err=>{console.error('request failed',err.message);if(!res.headersSent)fail(res,500,'internal_error','Ocorreu um erro interno.');else res.destroy();});});
function ask(prompt, hidden = false) {
  return new Promise(resolve=>{
    if(!process.stdin.isTTY||!process.stdin.setRawMode){const rl=readline.createInterface({input:process.stdin,output:process.stdout});rl.question(prompt,answer=>{rl.close();resolve(answer);});return;}
    process.stdout.write(prompt);let value='';const onData=chunk=>{for(const c of chunk.toString()){if(c==='\u0003'){process.stdin.setRawMode(false);process.stdin.pause();process.exit(130);}if(c==='\r'||c==='\n'){process.stdin.setRawMode(false);process.stdin.pause();process.stdin.removeListener('data',onData);process.stdout.write('\n');resolve(value);return;}if(c==='\u007f'||c==='\b'){value=value.slice(0,-1);if(!hidden)process.stdout.write('\b \b');}else if(c>=' '){value+=c;if(!hidden)process.stdout.write(c);}}};
    process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',onData);
  });
}
function askSecrets(prompts) {
  return new Promise((resolve,reject)=>{
    if(!process.stdin.isTTY||!process.stdin.setRawMode){reject(new Error('Terminal interativo indisponível.'));return;}
    const values=[];let value='',index=0;
    const restore=()=>{try{process.stdin.setRawMode(false);}catch{}process.stdin.pause();process.stdin.removeListener('data',onData);};
    const onData=chunk=>{for(const c of chunk.toString()){
      if(c==='\u0003'){restore();process.exit(130);}
      if(c==='\r'||c==='\n'){process.stdout.write('\n');values.push(value);value='';index++;if(index===prompts.length){restore();resolve(values);}else process.stdout.write(prompts[index]);continue;}
      if(c==='\u007f'||c==='\b'){value=value.slice(0,-1);continue;}
      if(c>=' '&&c!=='\u007f')value+=c;
    }};
    try{process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',onData);process.stdout.write(prompts[0]);}
    catch{restore();reject(new Error('Não foi possível ativar a entrada oculta no terminal.'));}
  });
}
async function createAdmin() {
  if(db.prepare('SELECT COUNT(*) AS n FROM users').get().n) { console.error('Já existe administrador. Para trocar a senha, use a função de alteração no painel depois do login.'); process.exitCode=1; return; }
  let email,password;
  if(!process.stdin.isTTY){const lines=fs.readFileSync(0,'utf8').split(/\r?\n/);email=lines[0]||'';password=lines[1]||'';}
  else {email=await ask('E-mail do administrador: ',false);password=await ask('Senha (mínimo 12 caracteres): ',true);}
  email=email.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { console.error('E-mail inválido.');process.exitCode=1;return; }
  if(password.length<12) { console.error('A senha deve ter pelo menos 12 caracteres.');process.exitCode=1;return; }
  const salt=crypto.randomBytes(16);await new Promise(resolve=>crypto.scrypt(password,salt,64,(err,hash)=>{if(err){console.error('Falha ao criar o administrador.');process.exitCode=1;resolve();return;}const now=isoNow();db.prepare('INSERT INTO users(id,email,salt,password_hash,created_at,password_changed_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),email,salt.toString('hex'),hash.toString('hex'),now,now);console.log('Administrador criado. Guarde o acesso em local seguro.');resolve();}));
}
async function resetAdminPassword() {
  if(!process.stdin.isTTY||!process.stdin.setRawMode){console.error('Execute este comando diretamente em um terminal interativo; entrada por pipe não é aceita para a redefinição.');process.exitCode=1;return;}
  const admins=db.prepare('SELECT id,email FROM users ORDER BY created_at').all();
  if(!admins.length){console.error('Nenhuma conta administrativa existe neste banco.');process.exitCode=1;return;}
  let user=admins[0];
  if(admins.length>1){const email=(await ask('E-mail da conta administrativa: ',false)).trim().toLowerCase();user=admins.find(x=>x.email.toLowerCase()===email);if(!user){console.error('Conta não encontrada.');process.exitCode=1;return;}}
  let password,confirmation;
  try{[password,confirmation]=await askSecrets(['Nova senha (mínimo 12 caracteres): ','Confirme a nova senha: ']);}
  catch{console.error('Não foi possível ler a senha com segurança neste terminal.');process.exitCode=1;return;}
  if(password.length<12){console.error('A senha deve ter pelo menos 12 caracteres.');process.exitCode=1;return;}
  if(password!==confirmation){console.error('As senhas não coincidem. Nenhuma alteração foi feita.');process.exitCode=1;return;}
  const salt=crypto.randomBytes(16);
  await new Promise(resolve=>crypto.scrypt(password,salt,64,(err,hash)=>{
    if(err){console.error('Não foi possível redefinir a senha.');process.exitCode=1;resolve();return;}
    try{db.prepare('UPDATE users SET salt=?,password_hash=?,password_changed_at=? WHERE id=?').run(salt.toString('hex'),hash.toString('hex'),isoNow(),user.id);console.log('Senha administrativa redefinida localmente.');}
    catch{console.error('Não foi possível redefinir a senha.');process.exitCode=1;}
    resolve();
  }));
}
if(process.argv[2]==='create-admin') createAdmin().then(()=>db.close()).catch(e=>{console.error('Falha ao criar administrador.');process.exitCode=1;try{db.close();}catch{}});
else if(process.argv[2]==='reset-admin-password') resetAdminPassword().then(()=>db.close()).catch(e=>{console.error('Falha ao redefinir senha.');process.exitCode=1;try{db.close();}catch{}});
else {
  server.listen(PORT,HOST,()=>console.log(`Black Crown Barber: http://${HOST}:${PORT} · SQLite: ${DB_FILE}`));
  server.on('error',e=>{console.error(`Não foi possível iniciar o servidor: ${e.message}`);process.exitCode=1;});
  const shutdown=()=>server.close(()=>{try{db.close();}finally{process.exit(0);}});process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
}
