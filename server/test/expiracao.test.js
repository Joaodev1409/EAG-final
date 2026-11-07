// Expiração de pedidos PIX não pagos: só expira o que está no prazo vencido, sem pagamento e ainda não em produção.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startEnv } from './helpers.js';

let env;
let expireDueOrders;
before(async () => {
  env = await startEnv();
  ({ expireDueOrders } = await import('../src/lib/expiry.js'));
});
after(async () => { await env?.stop(); });

const INITIAL_STOCK = 10;
const QUANTITY = 2;

const stockOf = async () => (await env.pool.query('SELECT stock FROM products WHERE id=$1', [env.productId])).rows[0].stock;

// Pedido de 2 itens (estoque controlado: 10 → 8), marcado como PIX do site aguardando pagamento.
// `expiresIn` é um intervalo SQL (ex.: '-1 minute' = já vencido).
async function pixOrder({ expiresIn = '-1 minute', set = '' } = {}) {
  await env.pool.query('UPDATE products SET stock=$1 WHERE id=$2', [INITIAL_STOCK, env.productId]);
  const sale = await env.sell({ quantity: QUANTITY, payment: { type: 'later', method: 'cash' } });
  assert.equal(sale.status, 201);
  const id = sale.body.id;
  await env.pool.query(`UPDATE orders SET payment_method='pix', expires_at=NOW()+$2::interval ${set} WHERE id=$1`, [id, expiresIn]);
  assert.equal(await stockOf(), INITIAL_STOCK - QUANTITY);
  return id;
}

const historyOf = async (id, status) =>
  (await env.pool.query('SELECT * FROM order_history WHERE order_id=$1 AND status=$2', [id, status])).rows;

test('PIX sem pagamento, em produção "new" e vencido vira expired, devolve estoque e grava histórico', async () => {
  const id = await pixOrder();

  assert.equal(await expireDueOrders(env.pool), 1);

  const order = await env.order(id);
  assert.equal(order.status, 'expired');
  assert.equal(order.restocked, true);
  assert.equal(await stockOf(), INITIAL_STOCK);
  assert.equal((await historyOf(id, 'expired')).length, 1);
});

test('PIX com expires_at no futuro não é expirado', async () => {
  const id = await pixOrder({ expiresIn: '10 minutes' });

  assert.equal(await expireDueOrders(env.pool), 0);

  const order = await env.order(id);
  assert.equal(order.status, 'active');
  assert.equal(order.restocked, false);
  assert.equal(await stockOf(), INITIAL_STOCK - QUANTITY);
  assert.equal((await historyOf(id, 'expired')).length, 0);
});

test('pedido com pagamento ou fora de produção "new" não é expirado', async () => {
  const paid = await pixOrder({ set: ', paid_cents=500' });
  const inProduction = await pixOrder({ set: ", production_status='in_production'" });

  assert.equal(await expireDueOrders(env.pool), 0);

  for (const id of [paid, inProduction]) {
    const order = await env.order(id);
    assert.equal(order.status, 'active');
    assert.equal(order.restocked, false);
    assert.equal((await historyOf(id, 'expired')).length, 0);
  }
});

test('rodar duas vezes não devolve o estoque em dobro e a segunda chamada retorna 0', async () => {
  const id = await pixOrder();

  assert.equal(await expireDueOrders(env.pool), 1);
  assert.equal(await expireDueOrders(env.pool), 0);
  assert.equal(await expireDueOrders(env.pool, { orderId: id }), 0);

  assert.equal(await stockOf(), INITIAL_STOCK);
  assert.equal((await historyOf(id, 'expired')).length, 1);
});
