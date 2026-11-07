// ---------- Receber e conferir ----------

import React, { useCallback, useEffect, useState } from 'react';
import { Banknote, QrCode } from 'lucide-react';
import { Badge, ErrorState, Spinner, useConfirm, useNow, useToast } from '../../components/ui.jsx';
import { dateTime, elapsed, money, time } from '../../lib/api.js';
import { PAYMENT_METHODS } from '../../lib/labels.js';
import { useAdmin, useLiveRefresh } from '../context.js';
import { OpenCashInline, OrderDetail, PaymentBadge, PaymentDialog, ServiceBadge } from '../shared.jsx';

export default function Receive({ cashOpen, goToCash }) {
  const { call } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const now = useNow(30000);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setData(await call('/finance/queue')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);

  const reject = async (order) => {
    const reason = await confirm({ title: `PIX não localizado · #${order.ticket}`, danger: true, confirmLabel: 'Registrar',
      message: 'O pedido volta para "Aguardando pagamento". Se o prazo do PIX já terminou, ele expira.', input: { label: 'Motivo', placeholder: 'Ex.: valor não consta no extrato' } });
    if (!reason) return;
    try { await call(`/finance/orders/${order.id}/reject-claim`, { method: 'POST', body: { reason } }); toast('Registrado.'); load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Spinner />;
  return <>
    {!cashOpen && <OpenCashInline onOpened={goToCash} />}
    <section className="panel">
      <h3><QrCode size={18} /> PIX aguardando conferência <Badge tone="info">{data.review.length}</Badge></h3>
      <p className="muted small">O comprador tocou em "Já paguei". Confira no extrato da conta antes de confirmar — o aviso do comprador não é recebimento.</p>
      {data.review.length === 0 ? <p className="muted">Nenhum PIX para conferir agora.</p>
        : <div className="table-wrap"><table className="table">
          <thead><tr><th>Senha / pedido</th><th>Cliente</th><th>Valor</th><th>Avisou às</th><th /></tr></thead>
          <tbody>{data.review.map((order) => <tr key={order.id}>
            <td><button type="button" className="link-btn" onClick={() => setOpenId(order.id)}><b>#{order.ticket}</b></button><small>{order.orderNumber}</small></td>
            <td>{order.buyerName}<small>{order.teamName}</small></td>
            <td><b>{money(order.balance)}</b>{order.status === 'expired' && <small>Pedido expirado</small>}</td>
            <td>{time(order.paymentClaimedAt)}<small>há {elapsed(order.paymentClaimedAt, now)}</small></td>
            <td className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(order)}>Confirmar recebimento</button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => reject(order)}>Não localizado</button></td>
          </tr>)}</tbody></table></div>}
    </section>
    <section className="panel">
      <h3><Banknote size={18} /> Pedidos aguardando pagamento <Badge tone="warning">{data.unpaid.length}</Badge></h3>
      <p className="muted small">Pedidos ativos dos últimos 3 dias sem pagamento completo. Use para receber no caixa (dinheiro, cartão ou PIX conferido).</p>
      {data.unpaid.length === 0 ? <p className="muted">Nenhum pedido pendente.</p>
        : <div className="table-wrap"><table className="table">
          <thead><tr><th>Senha / pedido</th><th>Cliente</th><th>Atendimento</th><th>Forma escolhida</th><th>Em aberto</th><th /></tr></thead>
          <tbody>{data.unpaid.map((order) => <tr key={order.id}>
            <td><button type="button" className="link-btn" onClick={() => setOpenId(order.id)}><b>#{order.ticket}</b></button><small>{order.orderNumber} · {dateTime(order.createdAt)}</small></td>
            <td>{order.buyerName}<small>{order.teamName}</small></td>
            <td><ServiceBadge order={order} /></td>
            <td>{PAYMENT_METHODS[order.paymentMethod]}{order.cashChangeFor ? <small>Troco p/ {money(order.cashChangeFor)}</small> : null}</td>
            <td><b>{money(order.balance)}</b><PaymentBadge order={order} /></td>
            <td className="actions"><button type="button" className="btn btn-sm btn-primary" onClick={() => setPaying(order)}>Receber</button></td>
          </tr>)}</tbody></table></div>}
    </section>
    {paying && <PaymentDialog order={paying} onClose={() => setPaying(null)} onDone={load} />}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </>;
}
