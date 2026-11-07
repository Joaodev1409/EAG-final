// ---------- Resumo de caixa (usado no caixa aberto, no fechamento e no histórico) ----------

import React from 'react';
import { Banknote, CreditCard, QrCode } from 'lucide-react';
import { dateTime, money, moneyCents } from '../../lib/api.js';
import { PAYMENT_METHODS } from '../../lib/labels.js';

export const METHOD_ICONS = { pix: QrCode, cash: Banknote, debit: CreditCard, credit: CreditCard };
export const METHOD_ORDER = ['pix', 'cash', 'debit', 'credit'];

export function Kpi({ label, value, help, tone }) {
  return <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}><span>{label}</span><b>{value}</b>{help && <small>{help}</small>}</div>;
}

export function Diff({ cents }) {
  if (cents == null) return <span className="muted">não conferido</span>;
  if (cents === 0) return <span className="diff ok">Sem diferença</span>;
  return <span className={`diff ${cents > 0 ? 'over' : 'under'}`}>{cents > 0 ? 'Sobra de ' : 'Falta de '}{moneyCents(Math.abs(cents))}</span>;
}

export function SessionSummary({ summary, counted, differences }) {
  const s = summary;
  return <div className="session-summary">
    <div className="kpi-row">
      <Kpi label="Pedidos no período do caixa" value={s.orders.total} help={`${s.orders.paid} pagos · ${s.orders.pending} pendentes · ${s.orders.cancelled} cancelados`} />
      <Kpi label="Pedidos com recebimento neste caixa" value={s.paidOrders} />
      <Kpi label="Total recebido (líquido)" value={moneyCents(s.net)} tone="success" help={s.refunded ? `Inclui estornos de ${moneyCents(s.refunded)}` : 'Sem estornos'} />
      <Kpi label="Pendente de pagamento" value={moneyCents(s.orders.pending_cents)} tone="warning" help="Pedidos ativos sem pagamento completo. Não entram no total recebido." />
    </div>

    <table className="table compact"><thead><tr><th>Forma</th><th>Pedidos</th><th>Recebido</th><th>Estornos</th><th>Líquido</th>{counted && <th>Conferido</th>}{differences && <th>Diferença</th>}</tr></thead>
      <tbody>{METHOD_ORDER.map((method) => { const m = s.methods[method]; return <tr key={method}>
        <td>{PAYMENT_METHODS[method]}</td><td>{m.orders}</td><td>{moneyCents(m.received)}</td><td>{m.refunded ? `−${moneyCents(m.refunded)}` : '—'}</td><td><b>{moneyCents(m.net)}</b></td>
        {counted && <td>{method === 'cash' ? '—' : counted[method] == null ? <span className="muted">—</span> : moneyCents(counted[method])}</td>}
        {differences && <td>{method === 'cash' ? '—' : <Diff cents={differences[method]} />}</td>}
      </tr>; })}</tbody>
    </table>

    <div className="grid-2 gap-lg">
      <section className="panel soft">
        <h4><Banknote size={16} /> Dinheiro no caixa</h4>
        <div className="calc">
          <div><span>Valor inicial (troco)</span><b>{moneyCents(s.openingCash)}</b></div>
          <div><span>+ Vendas em dinheiro</span><b>{moneyCents(s.methods.cash.received)}</b></div>
          {s.methods.cash.refunded > 0 && <div><span>− Estornos em dinheiro</span><b>{moneyCents(s.methods.cash.refunded)}</b></div>}
          <div><span>− Sangrias</span><b>{moneyCents(s.withdrawals)}</b></div>
          <div><span>+ Suprimentos</span><b>{moneyCents(s.supplies)}</b></div>
          <div className="calc-total"><span>= Esperado no caixa</span><b>{moneyCents(s.expectedCash)}</b></div>
          {counted && <div><span>Contado</span><b>{moneyCents(counted.cash)}</b></div>}
          {differences && <div><span>Diferença</span><Diff cents={differences.cash} /></div>}
        </div>
        <p className="muted small">O valor inicial não entra no faturamento.</p>
      </section>
      <section className="panel soft">
        <h4><QrCode size={16} /> Conferência do PIX</h4>
        <div className="calc">
          <div><span>Pedidos pagos via PIX</span><b>{s.methods.pix.orders}</b></div>
          <div><span>Recebimentos PIX confirmados</span><b>{moneyCents(s.methods.pix.net)}</b></div>
          {counted && <div><span>Conferido no extrato</span><b>{counted.pix == null ? '—' : moneyCents(counted.pix)}</b></div>}
          {differences && <div><span>Diferença</span><Diff cents={differences.pix} /></div>}
          <div><span>Aguardando conferência</span><b>{s.pixPending.length} ({moneyCents(s.pixPending.reduce((sum, p) => sum + p.totalCents, 0))})</b></div>
        </div>
        <p className="muted small">Sem integração bancária: compare manualmente com o extrato da chave PIX. PIX em conferência não entra no total.</p>
      </section>
    </div>
    <section className="panel soft">
      <h4><CreditCard size={16} /> Cartão</h4>
      <p>Débito: <b>{moneyCents(s.methods.debit.net)}</b> ({s.methods.debit.count} lançamentos) · Crédito: <b>{moneyCents(s.methods.credit.net)}</b> ({s.methods.credit.count} lançamentos)</p>
      <p className="muted small">Vendas registradas em cartão. Não indicam que o valor já foi liquidado na conta bancária.</p>
    </section>
    {s.voided?.count > 0 && <p className="muted small">{s.voided.count} lançamento(s) anulado(s) neste caixa, somando {moneyCents(s.voided.cents)} (não contabilizados).</p>}
  </div>;
}

export function PaymentsTable({ payments }) {
  if (!payments?.length) return <p className="muted">Nenhum lançamento.</p>;
  return <div className="table-wrap"><table className="table compact">
    <thead><tr><th>Hora</th><th>Pedido</th><th>Tipo</th><th>Forma</th><th>Valor</th><th>Responsável</th></tr></thead>
    <tbody>{payments.map((p) => <tr key={p.id} className={p.status === 'voided' ? 'row-voided' : ''}>
      <td>{dateTime(p.createdAt)}</td><td>#{p.ticket} <small>{p.orderNumber}</small></td>
      <td>{p.kind === 'refund' ? 'Estorno' : 'Recebimento'}{p.status === 'voided' && <small>Anulado: {p.voidReason}</small>}</td>
      <td>{PAYMENT_METHODS[p.method]}</td><td>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</td><td>{p.createdBy}</td>
    </tr>)}</tbody></table></div>;
}
