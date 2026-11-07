import React, { useCallback, useEffect, useState } from 'react';
import { Lock, Unlock } from 'lucide-react';
import { Badge } from '../components/ui.jsx';
import { useAdmin, useLiveRefresh } from './context.js';
import Overview from './finance/Overview.jsx';
import Receive from './finance/Receive.jsx';
import CashTab from './finance/CashTab.jsx';
import History from './finance/History.jsx';
import Entries from './finance/Entries.jsx';

const SUBTABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'receive', label: 'Receber e conferir' },
  { id: 'cash', label: 'Caixa' },
  { id: 'history', label: 'Fechamentos' },
  { id: 'entries', label: 'Lançamentos' }
];

export default function FinancePage() {
  const { call } = useAdmin();
  const [tab, setTab] = useState('overview');
  const [cashOpen, setCashOpen] = useState(null);
  const checkCash = useCallback(() => call('/finance/cash').then((data) => setCashOpen(Boolean(data.session))).catch(() => {}), [call]);
  useEffect(() => { checkCash(); }, [checkCash]);
  useLiveRefresh(checkCash, ['cash']);

  return <div className="admin-page">
    <header className="admin-page-head">
      <div><h1>Financeiro</h1><p>Vendas, conferência de recebimentos e fechamento de caixa.</p></div>
      {cashOpen != null && <Badge tone={cashOpen ? 'success' : 'warning'} icon={cashOpen ? <Unlock size={13} /> : <Lock size={13} />}>{cashOpen ? 'Caixa aberto' : 'Caixa fechado'}</Badge>}
    </header>
    <nav className="subtabs">{SUBTABS.map((item) => <button type="button" key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    {tab === 'overview' && <Overview />}
    {tab === 'receive' && <Receive cashOpen={cashOpen} goToCash={checkCash} />}
    {tab === 'cash' && <CashTab onChanged={checkCash} />}
    {tab === 'history' && <History />}
    {tab === 'entries' && <Entries />}
  </div>;
}
