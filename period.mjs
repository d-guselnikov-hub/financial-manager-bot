import { dayAt, monthAt } from './ledger.mjs';

const names = [
  'январь января', 'февраль февраля', 'март марта', 'апрель апреля', 'май мая', 'июнь июня',
  'июль июля', 'август августа', 'сентябрь сентября', 'октябрь октября', 'ноябрь ноября', 'декабрь декабря',
];
const months = new Map(names.flatMap((variants, index) => variants.split(' ').map(name => [name, index + 1])));
const pad = number => String(number).padStart(2, '0');
const utcDay = day => new Date(`${day}T00:00:00.000Z`);

function calendarDate(value, defaultYear) {
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const date = utcDay(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
  }
  const [, day, month, year] = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/u.exec(value) ?? [];
  if (!day || !month) return null;
  return calendarDate(`${year ?? defaultYear}-${pad(month)}-${pad(day)}`, defaultYear);
}

function range(from, to) {
  if (!from || !to || from > to) return null;
  const pretty = day => day.split('-').reverse().join('.');
  return { from, to, label: `с ${pretty(from)} по ${pretty(to)}` };
}

export function reportPeriod(input, now, timezone) {
  const current = monthAt(now, timezone);
  const [year, month] = current.split('-').map(Number);
  const text = input.trim().toLowerCase().replace(/[?!]+$/u, '').replace(/^за\s+/u, '');
  if (!text || /^(?:(?:этот|текущий) )?месяц$/u.test(text)) return current;
  if (/^(?:all|вся история|всю историю|всё время|все время)$/u.test(text)) return 'all';
  if (/^\d{4}-(0[1-9]|1[0-2])$/u.test(text)) return text;
  if (/^прошлы[йи] месяц$/u.test(text)) return month === 1 ? `${year - 1}-12` : `${year}-${pad(month - 1)}`;
  const [, monthName, givenYear] = /^(\p{L}+)(?:\s+(\d{4}))?$/u.exec(text) ?? [];
  const target = months.get(monthName);
  if (target) return `${givenYear ?? (target > month ? year - 1 : year)}-${pad(target)}`;
  const today = dayAt(now, timezone);
  if (text === 'сегодня' || text === 'день') return range(today, today);
  if (text === 'вчера') {
    const date = utcDay(today);
    date.setUTCDate(date.getUTCDate() - 1);
    const yesterday = date.toISOString().slice(0, 10);
    return range(yesterday, yesterday);
  }
  const [, countText] = /^(?:последни[ех]\s+)?(\d{1,3})\s+(?:день|дня|дней)$/u.exec(text) ?? [];
  const count = /^недел[юя]$/u.test(text) ? 7 : Number(countText);
  if (count >= 1 && count <= 366) {
    const start = utcDay(today);
    start.setUTCDate(start.getUTCDate() - count + 1);
    return range(start.toISOString().slice(0, 10), today);
  }
  const [, start, end] = /^с\s+(\S+)\s+по\s+(\S+)$/u.exec(text) ?? [];
  if (start) return range(calendarDate(start, year), calendarDate(end, year));
  return null;
}

export function periodLabel(period) {
  if (period === 'all') return 'за всю историю';
  return typeof period === 'string' ? `за ${period}` : period.label;
}
