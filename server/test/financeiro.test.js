// Regras financeiras "sagradas" do README: caixa, soma das formas, idempotência, "finalizar ≠ pagar" e fiado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.js';

let env;
before(async () => { env = await startEnv(); });
after(async () => { await env?.stop(); });

// Fecha o caixa aberto (se houver), para o teste começar com o caixa fechado.
async function ensureCashClosed() {
  const { body } = await env.api('GET', '/api/finance/cash');
  if (body.session) assert.equal((await env.closeCash(body.session.id)).status, 200);
}
async function ensureCashOpen() {
  const { body } = await env.api('GET', '/api/finance/cash');
  if (!body.session) assert.equal((await env.openCash()).status, 201);
}
// Pedido de R$ 20,00 sem pagamento (cliente vai pagar no balcão em dinheiro).
async function pendingOrder() {
  const sale = await env.sell({ quantity: 2, payment: { type: 'later', method: 'cash' } });
  assert.equal(sale.status, 201);
  return sale.body.id;
}
const cashPayment = (amount, key = env.uuid()) => ({ idempotencyKey: key, lines: [{ method: 'cash', amount }] });

test('recebimento com caixa fechado é recusado e nada é gravado', async () => {
  await ensureCashClosed();
  const id = await pendingOrder();

  const result = await env.api('POST', `/api/finance/orders/${id}/payments`, cashPayment(20));
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'NO_CASH_SESSION');

  const order = await env.order(id);
  assert.equal(order.payment_status, 'awaiting_payment');
  assert.equal(order.paid_cents, 0);
  assert.equal(await env.paymentCount(id), 0);
});

test('venda já paga no balcão com caixa fechado é recusada por inteiro (nem o pedido nasce)', async () => {
  await ensureCashClosed();
  const before = (await env.pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;

  const sale = await env.sell({ quantity: 1, payment: { type: 'pay', idempotencyKey: env.uuid(), lines: [{ method: 'cash', amount: 10 }] } });
  assert.equal(sale.status, 409);
  assert.equal(sale.body.code, 'NO_CASH_SESSION');

  const after = (await env.pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n;
  assert.equal(after, before);
});

test('soma das formas diferente do valor em aberto é recusada', async () => {
  await ensureCashOpen();
  const id = await pendingOrder();

  const short = await env.api('POST', `/api/finance/orders/${id}/payments`, { idempotencyKey: env.uuid(), lines: [{ method: 'cash', amount: 15 }] });
  assert.equal(short.status, 400);
  const over = await env.api('POST', `/api/finance/orders/${id}/payments`, { idempotencyKey: env.uuid(), lines: [{ method: 'cash', amount: 12 }, { method: 'pix', amount: 12 }] });
  assert.equal(over.status, 400);
  assert.equal(await env.paymentCount(id), 0);

  // Duas formas que fecham exatamente o valor são aceitas.
  const mixed = await env.api('POST', `/api/finance/orders/${id}/payments`, { idempotencyKey: env.uuid(), lines: [{ method: 'cash', amount: 12 }, { method: 'pix', amount: 8 }] });
  assert.equal(mixed.status, 201);
  assert.equal(mixed.body.paymentStatus, 'confirmed');
  assert.equal(await env.paymentCount(id), 2);
});

test('reenvio com a mesma chave de idempotência não duplica o pagamento', async () => {
  await ensureCashOpen();
  const id = await pendingOrder();
  const payload = cashPayment(20);

  const first = await env.api('POST', `/api/finance/orders/${id}/payments`, payload);
  assert.equal(first.status, 201);
  const second = await env.api('POST', `/api/finance/orders/${id}/payments`, payload);
  assert.equal(second.status, 200);
  assert.equal(second.body.duplicate, true);

  const order = await env.order(id);
  assert.equal(order.paid_cents, 2000);
  assert.equal(await env.paymentCount(id), 1);

  // Chave nova num pedido já pago também não recebe de novo.
  const again = await env.api('POST', `/api/finance/orders/${id}/payments`, cashPayment(20));
  assert.equal(again.status, 409);
  assert.equal(await env.paymentCount(id), 1);
});

test('"Já paguei" e finalizar o pedido não marcam como pago', async () => {
  await ensureCashOpen();
  const cashBefore = (await env.api('GET', '/api/finance/cash')).body.summary.methods.cash.received;
  const id = await pendingOrder();

  // Finalizar sem pagamento exige confirmação explícita...
  const blocked = await env.api('POST', `/api/admin/orders/${id}/production`, { from: 'new', to: 'finalized' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'UNPAID');

  // ...e, mesmo confirmada, a finalização não vira recebimento.
  const done = await env.api('POST', `/api/admin/orders/${id}/production`, { from: 'new', to: 'finalized', acknowledgeUnpaid: true });
  assert.equal(done.status, 200);
  const order = await env.order(id);
  assert.equal(order.production_status, 'finalized');
  assert.notEqual(order.payment_status, 'confirmed');
  assert.equal(order.paid_cents, 0);
  assert.equal(await env.paymentCount(id), 0);

  // O caixa não ganhou nenhum recebimento por causa disso.
  const cash = await env.api('GET', '/api/finance/cash');
  assert.equal(cash.body.summary.methods.cash.received, cashBefore);
});

test('"Já paguei" do comprador só coloca em conferência: não é recebimento', async () => {
  await ensureCashOpen();
  const sale = await env.sell({ quantity: 1, payment: { type: 'later', method: 'pix' } });
  assert.equal(sale.status, 201);
  const claim = await env.request('POST', `/api/orders/${sale.body.token}/claim-payment`);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));

  const order = await env.order(sale.body.id);
  assert.equal(order.payment_status, 'pending_review');
  assert.equal(order.paid_cents, 0);
  assert.equal(await env.paymentCount(sale.body.id), 0);
});

test('fiado aparece como a receber e só vira recebido com a baixa (que exige caixa aberto)', async () => {
  await ensureCashClosed();
  const grossBefore = (await env.api('GET', '/api/finance/summary')).body.received.gross;
  const sale = await env.sell({ quantity: 2, buyerName: 'Maria Fiada', buyerPhone: '(83) 99999-1234', payment: { type: 'credit', note: 'paga domingo' } });
  assert.equal(sale.status, 201, JSON.stringify(sale.body));
  const id = sale.body.id;

  // Fiado não precisa de caixa e não gera recebimento.
  const order = await env.order(id);
  assert.equal(order.on_credit, true);
  assert.notEqual(order.payment_status, 'confirmed');
  assert.equal(order.paid_cents, 0);
  assert.equal(await env.paymentCount(id), 0);

  const credits = await env.api('GET', '/api/finance/credits');
  const listed = credits.body.orders.find((o) => o.id === id);
  assert.ok(listed, 'o fiado deve estar na lista de a receber');
  assert.equal(listed.balance, 20);
  assert.ok(credits.body.summary.total >= 20);

  const summary = await env.api('GET', '/api/finance/summary');
  assert.ok(summary.body.credits.total >= 20);
  assert.equal(summary.body.received.gross, grossBefore);

  // A baixa é um recebimento: com o caixa fechado, é recusada e o fiado continua aberto.
  const refused = await env.api('POST', `/api/finance/orders/${id}/payments`, cashPayment(20));
  assert.equal(refused.status, 409);
  assert.equal((await env.order(id)).on_credit, true);
  assert.notEqual((await env.order(id)).payment_status, 'confirmed');

  await ensureCashOpen();
  const paid = await env.api('POST', `/api/finance/orders/${id}/payments`, cashPayment(20));
  assert.equal(paid.status, 201);
  assert.equal(paid.body.paymentStatus, 'confirmed');
  const after = await env.api('GET', '/api/finance/credits');
  assert.equal(after.body.orders.some((o) => o.id === id), false);
});

test('caixa fechado é imutável: anular recebimento de caixa fechado é recusado', async () => {
  await ensureCashClosed();
  await ensureCashOpen();
  const id = await pendingOrder();
  assert.equal((await env.api('POST', `/api/finance/orders/${id}/payments`, cashPayment(20))).status, 201);
  const paymentId = (await env.pool.query('SELECT id FROM payments WHERE order_id=$1', [id])).rows[0].id;
  await ensureCashClosed();

  const voided = await env.api('POST', `/api/finance/payments/${paymentId}/void`, { reason: 'tentativa depois de fechar' });
  assert.equal(voided.status, 409);
  const row = (await env.pool.query('SELECT status FROM payments WHERE id=$1', [paymentId])).rows[0];
  assert.equal(row.status, 'confirmed');
});
