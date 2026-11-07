// ---------- Histórico de fechamentos ----------

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Printer } from 'lucide-react';
import { Badge, EmptyState, ErrorState, Modal, Spinner, useConfirm, useToast } from '../../components/ui.jsx';
import { download, fullDateTime, money, moneyCents, parseMoney } from '../../lib/api.js';
import { PAYMENT_METHODS } from '../../lib/labels.js';
import { useAdmin, useLiveRefresh } from '../context.js';
import { Diff, PaymentsTable, SessionSummary } from './shared.jsx';

function SessionDetail({ id, onClose }) {
  const { call, can, token } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [adjust, setAdjust] = useState({ method: 'cash', amount: '', reason: '' });
  const load = useCallback(async () => {
    try { setData(await call(`/finance/cash/sessions/${id}`)); } catch (err) { setError(err.message); }
  }, [call, id]);
  useEffect(() => { load(); }, [load]);

  const print = () => {
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => document.body.classList.remove('printing'), 500);
  };
  const addAdjustment = async (event) => {
    event.preventDefault();
    const value = parseMoney(adjust.amount.replace(/^-/, ''));
    const negative = adjust.amount.trim().startsWith('-');
    if (Number.isNaN(value) || value === 0) { toast('Informe o valor do ajuste.', 'error'); return; }
    const ok = await confirm({ title: 'Registrar ajuste?', message: 'O ajuste fica registrado separadamente, com seu nome e justificativa. Os valores originais do fechamento não são alterados.', confirmLabel: 'Registrar ajuste' });
    if (!ok) return;
    try { await call(`/finance/cash/sessions/${id}/adjustments`, { method: 'POST', body: { method: adjust.method || null, amount: negative ? -value : value, reason: adjust.reason } }); toast('Ajuste registrado.'); setAdjust({ method: 'cash', amount: '', reason: '' }); load(); }
    catch (err) { toast(err.message, 'error'); }
  };

  return <Modal title={`Caixa nº ${id}`} onClose={onClose} size="lg">
    {error ? <p className="alert alert-error">{error}</p> : !data ? <Spinner /> : <div className="print-area">
      <div className="print-header"><img src="/brand/la-em-gracas-lanches.png" alt="" /><img src="/brand/eag-gracas.png" alt="" /><h2>Resumo do caixa nº {id}</h2></div>
      <div className="session-meta">
        <Badge tone={data.session.status === 'closed' ? 'neutral' : 'success'}>{data.session.status === 'closed' ? 'Fechado' : 'Aberto'}</Badge>
        <p>Aberto por <b>{data.session.openedBy}</b> em {fullDateTime(data.session.openedAt)}{data.session.closedAt && <> · Fechado por <b>{data.session.closedBy}</b> em {fullDateTime(data.session.closedAt)}</>}</p>
        {data.session.closingNote && <p>Observações: {data.session.closingNote}</p>}
      </div>
      <SessionSummary summary={data.summary} counted={data.summary.counted} differences={data.summary.differences} />
      {data.adjustments.length > 0 && <section className="panel">
        <h3>Ajustes após o fechamento</h3>
        <ul className="movements">{data.adjustments.map((a) => <li key={a.id}><span>{a.method ? PAYMENT_METHODS[a.method] : 'Geral'} · {fullDateTime(a.createdAt)}<small>{a.reason} — {a.createdBy}</small></span><b className={a.amount < 0 ? 'neg' : 'pos'}>{a.amount > 0 ? '+' : ''}{money(a.amount)}</b></li>)}</ul>
      </section>}
      <section className="panel"><h3>Lançamentos</h3><PaymentsTable payments={data.summary.payments} /></section>
      <div className="btn-row no-print">
        <button type="button" className="btn btn-outline" onClick={print}><Printer size={16} /> Imprimir</button>
        <button type="button" className="btn btn-outline" onClick={() => download(`/finance/cash/sessions/${id}/export.csv`, token, `caixa-${id}.csv`).catch((err) => toast(err.message, 'error'))}><Download size={16} /> Exportar CSV</button>
      </div>
      {data.session.status === 'closed' && can('finance.adjust') && <form className="panel no-print adjust-form" onSubmit={addAdjustment}>
        <h3>Ajuste autorizado (administrador)</h3>
        <p className="muted small">Use para corrigir algo identificado depois do fechamento. Para diminuir, use valor negativo (ex.: -5,00).</p>
        <div className="grid-3">
          <select value={adjust.method} onChange={(e) => setAdjust({ ...adjust, method: e.target.value })}><option value="">Geral</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input value={adjust.amount} inputMode="decimal" placeholder="Valor (ex.: 5,00 ou -5,00)" onChange={(e) => setAdjust({ ...adjust, amount: e.target.value.replace(/[^\d,.-]/g, '') })} />
          <input value={adjust.reason} maxLength={500} placeholder="Justificativa (mín. 10 caracteres)" onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
        </div>
        <button className="btn btn-outline btn-sm" disabled={adjust.reason.trim().length < 10}>Registrar ajuste</button>
      </form>}
    </div>}
  </Modal>;
}

export default function History() {
  const { call } = useAdmin();
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const load = useCallback(async () => {
    try { setList(await call('/finance/cash/sessions')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load, ['cash']);
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState title="Nenhum caixa registrado">Abra o primeiro caixa na aba Caixa.</EmptyState>;
  return <div className="table-wrap"><table className="table">
    <thead><tr><th>Caixa</th><th>Abertura / fechamento</th><th>Responsável</th><th>Pedidos pagos</th><th>PIX</th><th>Dinheiro</th><th>Cartão</th><th>Total recebido</th><th>Dinheiro: esperado × contado</th><th>Situação</th></tr></thead>
    <tbody>{list.map((s) => { const sum = s.summary; return <tr key={s.id} className="clickable" onClick={() => setOpenId(s.id)}>
      <td><b>nº {s.id}</b></td>
      <td>{fullDateTime(s.openedAt)}<small>{s.closedAt ? `até ${fullDateTime(s.closedAt)}` : 'em andamento'}</small></td>
      <td>{s.closedBy || s.openedBy}</td>
      {sum ? <>
        <td>{sum.paidOrders}</td><td>{moneyCents(sum.methods.pix.net)}</td><td>{moneyCents(sum.methods.cash.net)}</td>
        <td>{moneyCents(sum.methods.debit.net + sum.methods.credit.net)}</td><td><b>{moneyCents(sum.net)}</b></td>
        <td>{moneyCents(sum.expectedCash)} × {moneyCents(sum.counted.cash)}<small><Diff cents={sum.differences.cash} /></small></td>
      </> : <td colSpan={6} className="muted">Caixa aberto — veja a aba Caixa</td>}
      <td>{s.status === 'closed' ? <Badge tone="neutral" icon={<CheckCircle2 size={12} />}>Fechado</Badge> : <Badge tone="success">Aberto</Badge>}{s.adjustments ? <small>Ajustes: {money(s.adjustments)}</small> : null}</td>
    </tr>; })}</tbody>
  </table>
  {openId && <SessionDetail id={openId} onClose={() => setOpenId(null)} />}
  </div>;
}
