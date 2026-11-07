// ---------- Caixa ----------

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Info, Lock, Unlock } from 'lucide-react';
import { Badge, ErrorState, Field, Modal, MoneyInput, Spinner, useConfirm, useToast } from '../../components/ui.jsx';
import { fullDateTime, money, moneyCents, parseMoney, time } from '../../lib/api.js';
import { useAdmin, useLiveRefresh } from '../context.js';
import { PaymentsTable, SessionSummary } from './shared.jsx';

function CloseDialog({ session, summary, onClose, onDone }) {
  const { call } = useAdmin();
  const confirm = useConfirm();
  const toast = useToast();
  const [form, setForm] = useState({ cash: '', pix: '', debit: '', credit: '', note: '' });
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cents = (text) => (text === '' ? null : Math.round(parseMoney(text) * 100));
  const counted = { cash: cents(form.cash), pix: cents(form.pix), debit: cents(form.debit), credit: cents(form.credit) };
  const invalid = Object.values(counted).some((v) => v != null && (Number.isNaN(v) || v < 0)) || counted.cash == null;
  const differences = {
    cash: counted.cash == null || Number.isNaN(counted.cash) ? null : counted.cash - summary.expectedCash,
    pix: counted.pix == null || Number.isNaN(counted.pix) ? null : counted.pix - summary.methods.pix.net,
    debit: counted.debit == null || Number.isNaN(counted.debit) ? null : counted.debit - summary.methods.debit.net,
    credit: counted.credit == null || Number.isNaN(counted.credit) ? null : counted.credit - summary.methods.credit.net
  };
  const submit = async () => {
    const ok = await confirm({ title: 'Fechar o caixa agora?', confirmLabel: 'Fechar caixa', danger: true,
      message: <>Depois de fechado, os valores ficam registrados e <b>não podem ser alterados</b>. Correções posteriores só por ajuste do administrador, com justificativa.</> });
    if (!ok) return;
    setBusy(true); setError('');
    try {
      await call('/finance/cash/close', { method: 'POST', body: { sessionId: session.id, countedCash: counted.cash / 100,
        countedPix: counted.pix == null ? null : counted.pix / 100, countedDebit: counted.debit == null ? null : counted.debit / 100,
        countedCredit: counted.credit == null ? null : counted.credit / 100, note: form.note, confirm: true } });
      toast('Caixa fechado. O resumo está em Fechamentos.');
      onDone();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  return <Modal title="Fechar caixa" subtitle={`Aberto por ${session.openedBy} em ${fullDateTime(session.openedAt)}`} size="lg" onClose={onClose}
    footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Voltar</button>
      <button type="button" className="btn btn-danger" disabled={busy || invalid || !checked} onClick={submit}><Lock size={16} /> {busy ? 'Fechando...' : 'Fechar caixa'}</button></>}>
    <p className="alert alert-info"><Info size={17} /> Revise o resumo, conte o dinheiro físico e informe os valores conferidos. Os campos de PIX e cartão são opcionais (extrato e relatório da maquininha).</p>
    <SessionSummary summary={summary} counted={counted} differences={differences} />
    <div className="grid-2">
      <Field label="Dinheiro contado no caixa *" hint={`Esperado: ${moneyCents(summary.expectedCash)}`}><MoneyInput value={form.cash} onChange={set('cash')} /></Field>
      <Field label="PIX conferido no extrato" hint={`Registrado: ${moneyCents(summary.methods.pix.net)}`}><MoneyInput value={form.pix} onChange={set('pix')} /></Field>
      <Field label="Débito (relatório da maquininha)" hint={`Registrado: ${moneyCents(summary.methods.debit.net)}`}><MoneyInput value={form.debit} onChange={set('debit')} /></Field>
      <Field label="Crédito (relatório da maquininha)" hint={`Registrado: ${moneyCents(summary.methods.credit.net)}`}><MoneyInput value={form.credit} onChange={set('credit')} /></Field>
    </div>
    <Field label="Observações do fechamento"><textarea rows={2} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
    <label className="check-line"><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> Conferi os valores e sou responsável por este fechamento.</label>
    {error && <p className="alert alert-error">{error}</p>}
  </Modal>;
}

export default function CashTab({ onChanged }) {
  const { call, can } = useAdmin();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState({ cash: '', note: '' });
  const [movement, setMovement] = useState({ type: 'withdrawal', amount: '', reason: '' });
  const [closing, setClosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setData(await call('/finance/cash')); setError(''); } catch (err) { setError(err.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);

  const open = async (event) => {
    event.preventDefault();
    const value = opening.cash === '' ? 0 : parseMoney(opening.cash);
    if (Number.isNaN(value) || value < 0) { toast('Valor inicial inválido.', 'error'); return; }
    setBusy(true);
    try { await call('/finance/cash/open', { method: 'POST', body: { openingCash: value, note: opening.note } }); toast('Caixa aberto.'); setOpening({ cash: '', note: '' }); load(); onChanged(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const addMovement = async (event) => {
    event.preventDefault();
    const value = parseMoney(movement.amount);
    if (Number.isNaN(value) || value <= 0) { toast('Informe um valor maior que zero.', 'error'); return; }
    if (movement.reason.trim().length < 3) { toast('Informe o motivo.', 'error'); return; }
    setBusy(true);
    try { await call('/finance/cash/movements', { method: 'POST', body: { type: movement.type, amount: value, reason: movement.reason } }); toast(movement.type === 'withdrawal' ? 'Sangria registrada.' : 'Suprimento registrado.'); setMovement({ ...movement, amount: '', reason: '' }); load(); }
    catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Spinner />;
  if (!data.session) return <section className="panel narrow-panel">
    <h3><Unlock size={18} /> Abrir caixa</h3>
    <p className="muted">Nenhum caixa aberto. Recebimentos só podem ser registrados com o caixa aberto.</p>
    {can('finance.cash') ? <form onSubmit={open} className="stack">
      <Field label="Valor inicial em dinheiro (troco)" hint="Não entra no faturamento."><MoneyInput value={opening.cash} onChange={(v) => setOpening({ ...opening, cash: v })} /></Field>
      <Field label="Observações (opcional)"><input value={opening.note} maxLength={300} onChange={(e) => setOpening({ ...opening, note: e.target.value })} /></Field>
      <button className="btn btn-primary" disabled={busy}>Abrir caixa</button>
    </form> : <p className="alert alert-info">Seu perfil não pode abrir o caixa.</p>}
  </section>;

  const { session, summary } = data;
  return <>
    <section className="panel cash-head">
      <div><Badge tone="success" icon={<Unlock size={13} />}>Caixa aberto</Badge>
        <p>Aberto por <b>{session.openedBy}</b> em {fullDateTime(session.openedAt)} · Valor inicial {money(session.openingCash)}{session.openingNote ? ` · ${session.openingNote}` : ''}</p></div>
      {can('finance.cash') && <button type="button" className="btn btn-danger" onClick={() => setClosing(true)}><Lock size={16} /> Fechar caixa</button>}
    </section>
    <SessionSummary summary={summary} />
    <div className="grid-2 gap-lg">
      <section className="panel">
        <h3>Sangria e suprimento</h3>
        {can('finance.cash') && <form onSubmit={addMovement} className="movement-form">
          <div className="segmented">
            <button type="button" className={movement.type === 'withdrawal' ? 'active' : ''} onClick={() => setMovement({ ...movement, type: 'withdrawal' })}><ArrowUpCircle size={15} /> Sangria (retirada)</button>
            <button type="button" className={movement.type === 'supply' ? 'active' : ''} onClick={() => setMovement({ ...movement, type: 'supply' })}><ArrowDownCircle size={15} /> Suprimento (entrada)</button>
          </div>
          <MoneyInput value={movement.amount} onChange={(v) => setMovement({ ...movement, amount: v })} aria-label="Valor" />
          <input value={movement.reason} maxLength={300} placeholder="Motivo" onChange={(e) => setMovement({ ...movement, reason: e.target.value })} />
          <button className="btn btn-outline" disabled={busy}>Registrar</button>
        </form>}
        {summary.movements.length === 0 ? <p className="muted">Nenhuma movimentação.</p>
          : <ul className="movements">{summary.movements.map((m) => <li key={m.id}>
            <span>{m.type === 'withdrawal' ? 'Sangria' : 'Suprimento'} · {time(m.createdAt)}<small>{m.reason} — {m.createdBy}</small></span>
            <b className={m.type === 'withdrawal' ? 'neg' : 'pos'}>{m.type === 'withdrawal' ? '−' : '+'}{money(m.amount)}</b></li>)}</ul>}
      </section>
      <section className="panel">
        <h3>PIX aguardando conferência</h3>
        {summary.pixPending.length === 0 ? <p className="muted">Nenhum.</p>
          : <ul className="movements">{summary.pixPending.map((p) => <li key={p.id}><span>#{p.ticket} · {p.buyerName}<small>Avisou às {time(p.claimedAt)}</small></span><b>{moneyCents(p.totalCents)}</b></li>)}</ul>}
      </section>
    </div>
    <section className="panel">
      <h3>Lançamentos deste caixa</h3>
      <PaymentsTable payments={summary.payments} />
    </section>
    {closing && <CloseDialog session={session} summary={summary} onClose={() => setClosing(false)} onDone={() => { setClosing(false); load(); onChanged(); }} />}
  </>;
}
