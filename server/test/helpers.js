// Ambiente de teste: Postgres embutido temporário (porta livre) + a API Express numa porta livre.
// Não usa .env, nem os dados locais, nem a nuvem: tudo nasce e morre dentro do teste.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';

const ADMIN = { email: 'teste@eag.local', password: 'senha-de-teste-123' };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function startEnv() {
  const dir = mkdtempSync(path.join(tmpdir(), 'eag-test-'));
  const pgPort = await freePort();
  const cluster = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'postgres'), user: 'postgres', password: 'teste', port: pgPort, persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {}
  });
  await cluster.initialise();
  await cluster.start();
  await cluster.createDatabase('eag');

  // As variáveis precisam existir antes de importar a aplicação (db.js lê DATABASE_URL ao carregar).
  process.env.DATABASE_URL = `postgresql://postgres:teste@127.0.0.1:${pgPort}/eag`;
  process.env.DATABASE_URL_UNPOOLED = '';
  process.env.JWT_SECRET = 'segredo-de-teste-com-mais-de-32-caracteres';
  process.env.ADMIN_EMAIL = ADMIN.email;
  process.env.ADMIN_PASSWORD = ADMIN.password;
  process.env.MP_ACCESS_TOKEN = '';
  delete process.env.VERCEL;

  const { default: app, ready } = await import('../src/app.js');
  await ready;
  const { pool } = await import('../src/db.js');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, url, { token, body } = {}) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* resposta sem JSON */ }
    return { status: response.status, body: json };
  }

  const login = await request('POST', '/api/auth/login', { body: ADMIN });
  if (login.status !== 200) throw new Error(`Login de teste falhou: ${JSON.stringify(login.body)}`);
  const token = login.body.token;

  // Produto simples (R$ 10,00) para montar pedidos de valor conhecido.
  const category = (await pool.query("INSERT INTO categories(name,mode) VALUES('Teste','snack') RETURNING id")).rows[0].id;
  const productId = (await pool.query(
    "INSERT INTO products(name,mode,category_id,price_cents) VALUES('Item de teste','snack',$1,1000) RETURNING id", [category])).rows[0].id;

  return {
    pool, token, productId, request,
    api: (method, url, body) => request(method, url, { token, body }),
    // Venda no balcão de `quantity` itens de R$ 10,00. `payment` segue o contrato de /admin/pos/orders.
    async sell({ quantity = 1, payment, buyerName = 'Cliente Teste', buyerPhone = '' }) {
      return request('POST', '/api/admin/pos/orders', {
        token,
        body: { buyerName, buyerPhone, mode: 'snack', serviceType: 'pickup', items: [{ productId, quantity }], payment }
      });
    },
    async openCash(openingCash = 0) {
      const result = await request('POST', '/api/finance/cash/open', { token, body: { openingCash } });
      return result;
    },
    async closeCash(sessionId, countedCash = 0) {
      return request('POST', '/api/finance/cash/close', { token, body: { sessionId, countedCash, confirm: true } });
    },
    async order(id) {
      return (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    },
    async paymentCount(orderId) {
      return (await pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE order_id=$1 AND kind='payment'", [orderId])).rows[0].n;
    },
    uuid: randomUUID,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await pool.end().catch(() => {});
      await cluster.stop().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
