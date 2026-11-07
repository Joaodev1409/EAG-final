// ---------- Lançamentos ----------

import React, { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Spinner } from '../../components/ui.jsx';
import { dateTime, money } from '../../lib/api.js';
import { PAYMENT_METHODS } from '../../lib/labels.js';
import { useAdmin, useLiveRefresh } from '../context.js';
import { OrderDetail, PeriodFilter, usePeriod } from '../shared.jsx';

export default function Entries() {
  const { call } = useAdmin();
  const period = usePeriod('today');
  const [method, setMethod] = useState('');
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setList(await call(`/finance/payments?${period.query}`)); setError(''); } catch (err) { setError(err.message); }
  }, [call, period.query]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);
  const rows = (list || []).filter((p) => !method || p.method === method);
  return <>
    <div className="filters-bar">
      <PeriodFilter period={period} />
      <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Forma"><option value="">Todas as formas</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    <p className="muted small">Para anular um lançamento errado, abra o pedido. Lançamentos de caixas fechados não podem ser alterados.</p>
    {error ? <ErrorState message={error} onRetry={load} /> : !list ? <Spinner /> : rows.length === 0 ? <EmptyState title="Nenhum lançamento no período" />
      : <div className="table-wrap"><table className="table">
        <thead><tr><th>Data</th><th>Pedido</th><th>Tipo</th><th>Forma</th><th>Valor</th><th>Troco</th><th>Caixa</th><th>Responsável</th></tr></thead>
        <tbody>{rows.map((p) => <tr key={p.id} className={`clickable ${p.status === 'voided' ? 'row-voided' : ''}`} onClick={() => setOpenId(p.orderId)}>
          <td>{dateTime(p.createdAt)}</td><td>#{p.ticket}<small>{p.orderNumber} · {p.buyerName}</small></td>
          <td>{p.kind === 'refund' ? 'Estorno' : 'Recebimento'}{p.status === 'voided' && <small>Anulado: {p.voidReason}</small>}</td>
          <td>{PAYMENT_METHODS[p.method]}</td><td>{p.kind === 'refund' ? '−' : ''}{money(p.amount)}</td><td>{p.change ? money(p.change) : '—'}</td>
          <td>{p.sessionId ? `nº ${p.sessionId}` : '—'}</td><td>{p.createdBy}</td>
        </tr>)}</tbody></table></div>}
    {openId && <OrderDetail orderId={openId} onClose={() => setOpenId(null)} onChanged={load} />}
  </>;
}
