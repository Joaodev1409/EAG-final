import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trophy } from 'lucide-react';
import { ErrorState, Spinner } from '../../components/ui.jsx';
import { money } from '../../lib/api.js';
import { MODES, PAYMENT_METHODS, SERVICE_TYPES } from '../../lib/labels.js';
import { useAdmin, useLiveRefresh } from '../context.js';
import { PeriodFilter, usePeriod } from '../shared.jsx';
import ShareSheet from '../ShareSheet.jsx';
import { buildRanking, periodLabel, rankingImages, rankingText } from '../ranking.js';
import { Kpi, METHOD_ICONS, METHOD_ORDER } from './shared.jsx';

// Relação dos mais vendidos do período, em imagem e texto para divulgar.
function RankingSheet({ rows, from, to, onClose }) {
  const sections = useMemo(() => buildRanking(rows), [rows]);
  const period = periodLabel(from, to);
  const makeImages = useCallback(() => rankingImages(sections, { period }), [sections, period]);
  const count = sections.reduce((sum, s) => sum + s.items.length, 0);
  return <ShareSheet title="Itens mais vendidos" fileBase={`mais-vendidos-${period}`} subtitle={`${period} · ${count} produtos`}
    text={rankingText(sections, { period })} makeImages={makeImages} onClose={onClose} />;
}

// ---------- Visão geral ----------

export default function Overview() {
  const { call } = useAdmin();
  const period = usePeriod('today');
  const [filters, setFilters] = useState({ service: '', mode: '', method: '' });
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [ranking, setRanking] = useState(false);
  const query = `${period.query}&${new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()}`;
  const load = useCallback(async () => {
    try { setData(await call(`/finance/summary?${query}`)); setError(''); } catch (err) { setError(err.message); }
  }, [call, query]);
  useEffect(() => { load(); }, [load]);
  useLiveRefresh(load);
  const set = (key) => (event) => setFilters((current) => ({ ...current, [key]: event.target.value }));

  return <>
    <div className="filters-bar">
      <PeriodFilter period={period} />
      <select value={filters.service} onChange={set('service')} aria-label="Atendimento"><option value="">Todo atendimento</option>{Object.entries(SERVICE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.mode} onChange={set('mode')} aria-label="Catálogo"><option value="">Todos os catálogos</option>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <select value={filters.method} onChange={set('method')} aria-label="Forma de pagamento"><option value="">Todas as formas</option>{Object.entries(PAYMENT_METHODS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
    </div>
    {error ? <ErrorState message={error} onRetry={load} /> : !data ? <Spinner /> : <>
      <h3 className="section-title">Pedidos <small>(pela data do pedido)</small></h3>
      <div className="kpi-row">
        <Kpi label="Pedidos no período" value={data.orders.total} help="Todos os pedidos criados, inclusive cancelados e expirados." />
        <Kpi label="Pagos" value={data.orders.paid} tone="success" help="Pedidos ativos com pagamento confirmado pela equipe." />
        <Kpi label="Pendentes" value={data.orders.pending} tone="warning" help={`Ativos sem pagamento completo. ${data.orders.pix_review} com PIX em conferência.`} />
        <Kpi label="Cancelados" value={data.orders.cancelled} tone="danger" help="Não contam como venda." />
        <Kpi label="Expirados" value={data.orders.expired} help="PIX não pago no prazo. Não contam como venda." />
      </div>
      <h3 className="section-title">Valores</h3>
      <div className="kpi-row">
        <Kpi label="Vendas registradas" value={money(data.orders.sales)} help="Soma dos pedidos ativos do período. Não significa que o dinheiro já entrou." />
        <Kpi label="Recebido (líquido)" value={money(data.received.net)} tone="success" help={`Recebimentos confirmados pela equipe no período (pela data do recebimento), menos estornos de ${money(data.received.refunded)}.`} />
        <Kpi label="A receber" value={money(data.orders.pendingAmount)} tone="warning" help="Valor em aberto dos pedidos ativos do período (inclui fiados). Não entra no recebido." />
        <Kpi label="Fiado em aberto" value={money(data.credits.total)} help={`${data.credits.count} pedido(s) anotados, de todos os períodos. Veja a aba Fiados.`} />
      </div>

      <div className="grid-2 gap-lg">
        <section className="panel">
          <h3>Recebido por forma de pagamento</h3>
          <table className="table compact"><thead><tr><th>Forma</th><th>Lançamentos</th><th>Recebido</th><th>Estornos</th><th>Líquido</th></tr></thead>
            <tbody>{METHOD_ORDER.map((method) => { const m = data.methods[method]; const Icon = METHOD_ICONS[method]; return <tr key={method}>
              <td><Icon size={15} /> {PAYMENT_METHODS[method]}</td><td>{m.count}</td><td>{money(m.received)}</td><td>{m.refunded ? `−${money(m.refunded)}` : '—'}</td><td><b>{money(m.net)}</b></td></tr>; })}</tbody>
            <tfoot><tr><td>Total</td><td /><td>{money(data.received.gross)}</td><td>{data.received.refunded ? `−${money(data.received.refunded)}` : '—'}</td><td><b>{money(data.received.net)}</b></td></tr></tfoot>
          </table>
          <p className="muted small">Cartão: valores registrados no caixa, sem confirmação de liquidação bancária.</p>
        </section>
        <section className="panel">
          <h3>Por modalidade de atendimento</h3>
          <table className="table compact"><thead><tr><th>Modalidade</th><th>Pedidos</th><th>Vendas</th><th>Recebido</th></tr></thead>
            <tbody>{data.byService.map((row) => <tr key={row.serviceType}><td>{SERVICE_TYPES[row.serviceType]}</td><td>{row.orders}</td><td>{money(row.sales)}</td><td>{money(row.received)}</td></tr>)}</tbody>
          </table>
        </section>
      </div>

      <section className="panel">
        <div className="panel-head">
          <h3>Vendas por produto <small className="muted">(pedidos ativos)</small></h3>
          {data.byProduct.length > 0 && <button type="button" className="btn btn-outline btn-sm" onClick={() => setRanking(true)}><Trophy size={15} /> Relação dos mais vendidos</button>}
        </div>
        {data.byProduct.length === 0 ? <p className="muted">Sem vendas no período.</p>
          : <table className="table compact"><thead><tr><th>Produto</th><th>Categoria</th><th>Qtd.</th><th>Total</th></tr></thead>
            <tbody>{data.byProduct.map((row) => <tr key={`${row.name}-${row.mode}-${row.category}`}><td>{row.name}</td><td>{row.category}</td><td>{row.quantity}</td><td>{money(row.total)}</td></tr>)}</tbody></table>}
      </section>
      {ranking && <RankingSheet rows={data.byProduct} from={period.from} to={period.to} onClose={() => setRanking(false)} />}
    </>}
  </>;
}
