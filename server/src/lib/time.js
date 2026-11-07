// Datas "do dia" seguem o fuso da operação (o banco normalmente roda em UTC).
import { HttpError } from './http.js';

export const TIMEZONE = process.env.APP_TIMEZONE || 'America/Fortaleza';

export function localDate(date = new Date()) {
  // en-CA formata como AAAA-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Confere o formato e se o dia existe no calendário (Date.parse aceita 2026-02-30).
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Lê ?from=AAAA-MM-DD&to=AAAA-MM-DD (padrão: hoje no fuso da operação).
export function readPeriod(query) {
  const today = localDate();
  const from = query.from ? String(query.from) : today;
  const to = query.to ? String(query.to) : from;
  if (!isRealDate(from) || !isRealDate(to)) {
    throw new HttpError(400, 'Período inválido.');
  }
  if (from > to) throw new HttpError(400, 'A data inicial deve ser anterior à final.');
  return { from, to };
}

// Fragmento SQL para filtrar uma coluna timestamptz pelo período local.
// Usa três parâmetros consecutivos a partir de `index`: from, to, timezone.
export function periodSql(column, index) {
  return `${column} >= ($${index}::date)::timestamp AT TIME ZONE $${index + 2}
    AND ${column} < (($${index + 1}::date) + 1)::timestamp AT TIME ZONE $${index + 2}`;
}
