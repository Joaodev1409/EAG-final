// Funções puras de período e fuso horário (server/src/lib/time.js). Não usa banco.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/lib/http.js';
import { TIMEZONE, localDate, readPeriod, periodSql } from '../src/lib/time.js';

const erro400 = (err) => err instanceof HttpError && err.status === 400;

test('localDate: meia-noite UTC cai no dia anterior em America/Fortaleza', { skip: TIMEZONE !== 'America/Fortaleza' }, () => {
  // 02:30Z = 23:30 do dia 7 em Fortaleza (UTC-3).
  assert.equal(localDate(new Date('2026-11-08T02:30:00Z')), '2026-11-07');
  // 03:30Z = 00:30 do dia 8: já é o dia seguinte.
  assert.equal(localDate(new Date('2026-11-08T03:30:00Z')), '2026-11-08');
});

test('localDate: devolve AAAA-MM-DD', () => {
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/);
});

test('readPeriod: sem parâmetros usa hoje no fuso da operação', () => {
  const hoje = localDate();
  assert.deepEqual(readPeriod({}), { from: hoje, to: hoje });
});

test('readPeriod: só "from" faz "to" igual a "from"', () => {
  assert.deepEqual(readPeriod({ from: '2026-03-10' }), { from: '2026-03-10', to: '2026-03-10' });
});

test('readPeriod: from e to informados são mantidos', () => {
  assert.deepEqual(readPeriod({ from: '2026-03-10', to: '2026-03-15' }), { from: '2026-03-10', to: '2026-03-15' });
});

test('readPeriod: formato inválido lança HttpError 400', () => {
  assert.throws(() => readPeriod({ from: '10/03/2026' }), erro400);
  assert.throws(() => readPeriod({ from: '2026-3-1' }), erro400);
  assert.throws(() => readPeriod({ from: '2026-03-10', to: 'amanhã' }), erro400);
});

test('readPeriod: data inexistente lança HttpError 400', () => {
  assert.throws(() => readPeriod({ from: '2026-02-30' }), erro400);
  assert.throws(() => readPeriod({ from: '2026-03-01', to: '2026-13-01' }), erro400);
});

test('readPeriod: from > to lança HttpError 400', () => {
  assert.throws(() => readPeriod({ from: '2026-03-15', to: '2026-03-10' }), erro400);
});

test('periodSql: usa $n, $n+1 e $n+2 nas posições esperadas', () => {
  const sql = periodSql('o.created_at', 3);
  assert.match(sql, /^o\.created_at >= \(\$3::date\)::timestamp AT TIME ZONE \$5\b/);
  assert.match(sql, /o\.created_at < \(\(\$4::date\) \+ 1\)::timestamp AT TIME ZONE \$5\b/);
  assert.doesNotMatch(sql, /\$6/);
});

test('periodSql: começando em $1', () => {
  const sql = periodSql('paid_at', 1);
  assert.ok(sql.includes('$1::date'));
  assert.ok(sql.includes('$2::date'));
  assert.equal(sql.match(/AT TIME ZONE \$3/g).length, 2);
});
