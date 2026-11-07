// Cancelamento e estorno de pedido: estoque devolvido uma vez só, estorno com caixa aberto e caixa fechado imutável.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.stop(); });

const cancel = (id, body = {}) => env.api('POST', `/api/admin/orders/${id}/cancel`, { reason: 'Cliente desistiu', ...body });
const stock = async () => (await env.pool.query('SELECT stock FROM products WHERE id=$1', [env.productId])).rows[0].stock;
const refundCount = async (id) => (await env.pool.query("SELECT COUNT(*)::int AS n FROM payments WHERE order_id=$1 AND kind='refund'", [id])).rows[0].n;
const netCents = async (id) => (await env.pool.query(
  "SELECT COALESCE(SUM(CASE WHEN kind='payment' THEN amount_cents ELSE -amount_cents END),0)::int AS n FROM payments WHERE order_id=$1 AND status='confirmed'", [id])).rows[0].n;

async function ensureCashOpen() {
  const { body } = await env.api('GET', '/api/finance/cash');
  if (!body.session) assert.equal((await env.openCash()).status, 201);
}
async function ensureCashClosed() {
  const { body } = await env.api('GET', '/api/finance/cash');
  if (body.session) assert.equal((await env.closeCash(body.session.id)).status, 200);
}
// Define o estoque do produto de teste para medir a devolução.
const setStock = (n) => env.pool.query('UPDATE products SET stock=$1 WHERE id=$2', [n, env.productId]);
// Pedido de R$ 20,00 (2 itens), pago em dinheiro ou deixado para depois.
async function order({ paid }) {
  const payment = paid ? { type: 'pay', idempotencyKey: env.uuid(), lines: [{ method: 'cash', amount: 20 }] } : { type: 'later', method: 'cash' };
  const sale = await env.sell({ quantity: 2, payment });
  assert.equal(sale.status, 201);
  return sale.body.id;
}

test('cancelar pedido não pago marca como cancelado, devolve o estoque e não cria pagamento', async () => {
  await ensureCashOpen();
  await setStock(10);
  const id = await order({ paid: false });
  assert.equal(await stock(), 8);

  const result = await cancel(id);
  assert.equal(result.status, 200);

  const row = await env.order(id);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancel_reason, 'Cliente desistiu');
  assert.equal(await stock(), 10);
  assert.equal(await env.paymentCount(id), 0);
  assert.equal(await refundCount(id), 0);
});

test('cancelar pedido pago com caixa aberto registra o estorno e zera o recebido', async () => {
  await ensureCashOpen();
  await setStock(10);
  const id = await order({ paid: true });
  assert.equal((await env.order(id)).paid_cents, 2000);

  // Sem confirmar o estorno, o cancelamento é recusado.
  const refused = await cancel(id);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'REFUND_REQUIRED');
  assert.equal((await env.order(id)).status, 'active');

  const result = await cancel(id, { refund: true });
  assert.equal(result.status, 200);

  const row = await env.order(id);
  assert.equal(row.status, 'cancelled');
  assert.equal(await env.paymentCount(id), 1);
  assert.equal(await refundCount(id), 1);
  assert.equal(await netCents(id), 0);
  assert.equal(row.paid_cents - row.refunded_cents, 0);
  assert.equal(await stock(), 10);
});

test('cancelar duas vezes não estorna nem devolve estoque em dobro', async () => {
  await ensureCashOpen();
  await setStock(10);
  const id = await order({ paid: true });

  assert.equal((await cancel(id, { refund: true })).status, 200);
  const again = await cancel(id, { refund: true });
  assert.equal(again.status, 409);

  assert.equal(await refundCount(id), 1);
  assert.equal(await netCents(id), 0);
  assert.equal(await stock(), 10);
});

test('cancelar pedido pago com caixa fechado é recusado e nada é gravado', async () => {
  await ensureCashOpen();
  await setStock(10);
  const id = await order({ paid: true });
  await ensureCashClosed();

  const result = await cancel(id, { refund: true });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'NO_CASH_SESSION');

  const row = await env.order(id);
  assert.equal(row.status, 'active');
  assert.equal(row.paid_cents, 2000);
  assert.equal(row.refunded_cents, 0);
  assert.equal(await refundCount(id), 0);
  assert.equal(await netCents(id), 2000);
  assert.equal(await stock(), 8);
});
