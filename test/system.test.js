const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'black-crown-system-test-'));
const dataDir = path.join(testRoot, 'data');
const restoreDir = path.join(testRoot, 'restored-data');
const email = `test-${crypto.randomUUID()}@example.invalid`;
let password = crypto.randomBytes(24).toString('base64url');
let port;
let server;
let cookie;

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const baseUrl = () => `http://127.0.0.1:${port}`;
const api = (url, options = {}) => fetch(`${baseUrl()}${url}`, options);

function runAdminCommand(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js', command], {
      cwd: root,
      env: { ...process.env, HOST: '127.0.0.1', DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve(stdout + stderr)
      : reject(new Error(`${command} terminou com código ${code}: ${stdout}${stderr}`)));
    child.stdin.end(input);
  });
}

async function startServer(directory = dataDir) {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error(`Servidor encerrou ao iniciar: ${output}`);
    try {
      const response = await fetch(`${baseUrl()}/api/health`);
      if (response.ok) return;
    } catch {}
    await pause(100);
  }
  throw new Error(`Servidor não iniciou: ${output}`);
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

async function json(response) {
  const value = await response.json();
  return { response, value };
}

async function adminLogin() {
  const result = await json(await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password })
  }));
  assert.equal(result.response.status, 200);
  cookie = result.response.headers.get('set-cookie').split(';')[0];
}

const adminHeaders = () => ({ 'content-type': 'application/json', cookie });
async function adminJson(url, method = 'GET', body) {
  const response = await api(url, {
    method,
    headers: adminHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return json(response);
}

test('primeira versão: banco, CRUD, agendamento, isolamento da pausa e restauração', async t => {
  t.after(async () => {
    await stopServer();
    const tmp = path.resolve(os.tmpdir());
    const target = path.resolve(testRoot);
    if (target.startsWith(tmp + path.sep)) fs.rmSync(target, { recursive: true, force: true });
  });

  const portProbe = http.createServer();
  await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));

  // Confere a migração de um banco existente sem bookingPaused, sem inserir/excluir registros.
  fs.mkdirSync(dataDir, { recursive: true });
  const legacyDb = new DatabaseSync(path.join(dataDir, 'black-crown.sqlite'));
  legacyDb.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const legacySetting = legacyDb.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
  legacySetting.run('demoMode', 'true');
  legacySetting.run('bookingEnabled', 'true');
  legacyDb.close();

  const adminOutput = await runAdminCommand('create-admin', `${email}\n${password}\n`);
  assert.match(adminOutput, /Administrador criado/);
  await startServer();

  const page = await api('/admin');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /app\.js/);
  assert.equal((await (await api('/api/health')).json()).storage, 'sqlite');
  assert.equal((await api('/api/admin/settings')).status, 401, 'settings não autenticado deve retornar 401');
  assert.equal((await api('/api/admin/services')).status, 401, 'serviços não autenticado devem retornar 401');

  await adminLogin();
  let bootstrap = await (await api('/api/public/bootstrap')).json();
  assert.equal(bootstrap.services.length, 0, 'instalação vazia não deve receber serviços fictícios');
  assert.equal(bootstrap.professionals.length, 0, 'instalação vazia não deve receber profissionais fictícios');
  assert.equal(bootstrap.settings.bookingPaused, true, 'migração deve manter os agendamentos pausados');

  let result = await adminJson('/api/admin/services', 'POST', {
    name: 'Corte teste', description: 'Registro de integração', price: 50, duration: 60, active: true
  });
  assert.equal(result.response.status, 200);
  const serviceId = result.value.services[0].id;
  assert.equal(result.value.services.length, 1);
  result = await adminJson('/api/admin/services', 'PUT', {
    id: serviceId, name: 'Corte atualizado', description: 'Editado', price: 55, duration: 60, active: true, image: ''
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.value.services[0].price, 55);
  result = await adminJson('/api/admin/services', 'PUT', {
    id: 99999, name: 'ID inexistente', description: '', price: 10, duration: 30, active: true, image: ''
  });
  assert.equal(result.response.status, 404, 'PUT com ID inexistente não deve criar um serviço');
  result = await adminJson('/api/admin/services', 'POST', {
    name: 'Inválido', description: '', price: 10, duration: 2, active: true
  });
  assert.equal(result.response.status, 400, 'duração inválida deve ser rejeitada');

  result = await adminJson('/api/admin/professionals', 'POST', {
    name: 'Profissional teste', specialties: 'Corte', description: 'Registro de integração', active: true
  });
  assert.equal(result.response.status, 200);
  const professionalId = result.value.professionals[0].id;
  result = await adminJson('/api/admin/professionals', 'PUT', {
    id: professionalId, name: 'Profissional atualizado', specialties: 'Corte e barba', description: 'Editado', active: true, image: ''
  });
  assert.equal(result.response.status, 200);
  result = await adminJson('/api/admin/professionals', 'PUT', {
    id: 99999, name: 'ID inexistente', specialties: '', description: '', active: true, image: ''
  });
  assert.equal(result.response.status, 404, 'PUT com ID inexistente não deve criar um profissional');

  result = await adminJson('/api/admin/settings', 'PUT', {
    hours: { open: '09:00', close: '14:00', breakStart: '10:00', breakEnd: '10:30', closedDays: [0] }
  });
  assert.equal(result.response.status, 200, 'horários reais devem ser persistidos');
  result = await adminJson('/api/admin/settings', 'PUT', {
    hours: { open: '09:00', close: '14:00', breakStart: '10:00', breakEnd: '', closedDays: [0] }
  });
  assert.equal(result.response.status, 400, 'intervalo incompleto deve ser rejeitado');
  result = await adminJson('/api/admin/settings', 'PUT', {
    bookingEnabled: true, bookingPaused: false, demoMode: true
  });
  assert.equal(result.response.status, 200);
  bootstrap = await (await api('/api/public/bootstrap')).json();
  assert.equal(bootstrap.settings.demoMode, true);
  assert.equal(bootstrap.settings.bookingPaused, false, 'modo demonstração não deve se confundir com a pausa operacional');

  const date = '2027-01-04'; // segunda-feira futura
  const getSlots = async () => (await (await api(`/api/public/slots?date=${date}&professionalId=${professionalId}&serviceId=${serviceId}`)).json()).slots;
  let slots = await getSlots();
  assert.ok(slots.includes('09:00'));
  assert.ok(!slots.includes('09:30'), 'duração deve impedir sobreposição com intervalo das 10:00');
  assert.ok(slots.includes('10:30'));
  const sundaySlots = await (await api(`/api/public/slots?date=2027-01-03&professionalId=${professionalId}&serviceId=${serviceId}`)).json();
  assert.deepEqual(sundaySlots.slots, [], 'dia fechado não deve oferecer horários');

  const makeBooking = (time, key = crypto.randomUUID()) => api('/api/public/appointments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Cliente de teste', phone: '+55 (11) 99999-0000', serviceId, professionalId,
      date, time, idempotencyKey: key
    })
  });
  let booked = await json(await makeBooking('09:00'));
  assert.equal(booked.response.status, 201);
  assert.equal(booked.value.appointment.status, 'Pendente');
  const firstBookingId = booked.value.appointment.id;
  assert.ok(!(await getSlots()).includes('09:00'), 'horário gravado deve sair da disponibilidade');
  booked = await json(await makeBooking('09:30'));
  assert.equal(booked.response.status, 409, 'conflito com duração deve ser bloqueado no servidor');

  const sameKey = crypto.randomUUID();
  const duplicatePair = await Promise.all([makeBooking('11:30', sameKey), makeBooking('11:30', sameKey)]);
  const duplicateResults = await Promise.all(duplicatePair.map(json));
  assert.deepEqual(duplicateResults.map(x => x.response.status).sort(), [200, 201]);
  assert.equal(duplicateResults.filter(x => x.value.duplicate).length, 1, 'chave duplicada simultânea deve ser idempotente');

  const conflictPair = await Promise.all([makeBooking('13:00'), makeBooking('13:00')]);
  const conflictResults = await Promise.all(conflictPair.map(json));
  assert.deepEqual(conflictResults.map(x => x.response.status).sort(), [201, 409], 'duas solicitações simultâneas não podem ocupar o mesmo horário');

  let agenda = await adminJson(`/api/admin/appointments?date=${date}`);
  assert.equal(agenda.response.status, 200);
  assert.equal(agenda.value.appointments.length, 3);
  let dashboard = await adminJson('/api/admin/dashboard');
  assert.equal(dashboard.value.pending, 3);
  assert.equal(dashboard.value.customers, 1, 'cliente deve ser deduplicado por telefone');
  result = await adminJson(`/api/admin/appointments/${firstBookingId}`, 'PATCH', { status: 'Cancelado' });
  assert.equal(result.response.status, 200);
  result = await adminJson(`/api/admin/appointments/${firstBookingId}/history`);
  assert.equal(result.response.status, 200);

  result = await adminJson('/api/admin/services', 'PUT', {
    id: serviceId, name: 'Corte atualizado', description: 'Editado', price: 55, duration: 60, active: false, image: ''
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await getSlots(), [], 'serviço desativado não deve aparecer disponível');
  result = await adminJson('/api/admin/services', 'PUT', {
    id: serviceId, name: 'Corte atualizado', description: 'Editado', price: 55, duration: 60, active: true, image: ''
  });
  assert.equal(result.response.status, 200);
  result = await adminJson('/api/admin/professionals', 'PUT', {
    id: professionalId, name: 'Profissional atualizado', specialties: 'Corte e barba', description: 'Editado', active: false, image: ''
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await getSlots(), [], 'profissional inativo não deve aparecer disponível');
  result = await adminJson('/api/admin/professionals', 'PUT', {
    id: professionalId, name: 'Profissional atualizado', specialties: 'Corte e barba', description: 'Editado', active: true, image: ''
  });
  assert.equal(result.response.status, 200);

  const csrf = await api('/api/admin/settings', {
    method: 'PUT', headers: { ...adminHeaders(), origin: 'https://evil.example' },
    body: JSON.stringify({ bookingPaused: false })
  });
  assert.equal(csrf.status, 403, 'origem externa não deve alterar configurações');
  result = await adminJson('/api/admin/settings', 'PUT', { bookingPaused: true });
  assert.equal(result.response.status, 200);
  assert.deepEqual(await getSlots(), [], 'pausa deve bloquear horários no servidor');
  let blocked = await json(await makeBooking('10:30'));
  assert.equal(blocked.response.status, 503);
  assert.equal(blocked.value.error, 'booking_paused');

  result = await adminJson('/api/admin/logout', 'POST', {});
  assert.equal(result.response.status, 200);
  assert.equal((await api('/api/admin/appointments', { headers: { cookie } })).status, 401);
  await stopServer();

  const dbPath = path.join(dataDir, 'black-crown.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, 3);
  db.close();

  fs.cpSync(dataDir, restoreDir, { recursive: true });
  await startServer(restoreDir);
  bootstrap = await (await api('/api/public/bootstrap')).json();
  assert.equal(bootstrap.settings.bookingPaused, true, 'pausa deve persistir após reiniciar/restaurar');
  assert.equal(bootstrap.services.length, 1);
  assert.equal(bootstrap.professionals.length, 1);
  assert.equal((await api('/api/admin/settings')).status, 401, 'reinício deve invalidar sessão em memória');
  await adminLogin();
  agenda = await adminJson(`/api/admin/appointments?date=${date}`);
  assert.equal(agenda.value.appointments.length, 3, 'agendamentos devem persistir após restauração');

  const resetPassword = crypto.randomBytes(24).toString('base64url');
  const previousPassword = password;
  result = await adminJson('/api/admin/password', 'POST', { currentPassword: password, newPassword: resetPassword });
  assert.equal(result.response.status, 200, 'alteração de senha autenticada deve concluir');
  await stopServer();
  password = resetPassword;
  await startServer(restoreDir);
  const oldLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: previousPassword })
  });
  assert.equal(oldLogin.status, 401, 'senha anterior deve deixar de autenticar após alteração');
  await adminLogin();
});
