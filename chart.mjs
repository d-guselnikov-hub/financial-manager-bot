import { dayAt, entriesFor, money } from './ledger.mjs';
import { periodLabel } from './period.mjs';

const palette = { ink: '#172e37', muted: '#4a666d', brand: '#106353', line: '#dcE9e4', paper: '#f2f7f4', card: '#ffffff' };
const number = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const escape = value => String(value).replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

function text(x, y, value, size, { color = palette.ink, weight = 400, anchor = 'start' } = {}) {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
}

function rect(x, y, width, height, color, corner = 0) {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${corner}" fill="${color}"/>`;
}

const add = (map, key, amount) => map.set(key, (map.get(key) ?? 0) + amount);

function chartData(state, period, timezone) {
  const groups = new Map();
  for (const record of entriesFor(state, period, timezone)) {
    if (!record.items?.length) continue;
    const day = dayAt(record.at, timezone);
    for (const item of record.items) {
      if (!groups.has(item.currency)) groups.set(item.currency, { code: item.currency, total: 0, categories: new Map(), days: new Map() });
      const group = groups.get(item.currency);
      group.total += item.minor;
      add(group.categories, item.category, item.minor);
      add(group.days, day, item.minor);
    }
  }
  return [...groups.values()];
}

function timeline(group) {
  const months = new Map();
  for (const [day, value] of group.days) add(months, day.slice(0, 7), value);
  const byMonth = months.size > 1;
  const periods = [...(byMonth ? months : group.days)].sort(([first], [second]) => first.localeCompare(second));
  const visible = periods.slice(-8);
  return { visible, title: `Расходы ${byMonth ? 'по месяцам' : 'по дням'}${periods.length > visible.length ? ' · последние 8 с тратами' : ''}` };
}

function panel(group, top) {
  const width = 920;
  const grouped = [...group.categories].sort(([, a], [, b]) => b - a);
  const categories = grouped.slice(0, 6);
  if (grouped.length > 6) categories.push(['Остальные', grouped.slice(6).reduce((sum, [, amount]) => sum + amount, 0)]);
  const maxCategory = Math.max(...categories.map(([, amount]) => amount));
  const y = top + 154;
  const { visible, title } = timeline(group);
  const trendY = y + categories.length * 52 + 40;
  const bottom = trendY + 208;
  const parts = [
    rect(40, top, width, bottom - top + 22, palette.card, 24),
    text(72, top + 46, 'Всего потрачено', 25, { color: palette.muted }),
    text(72, top + 99, money(group.total, group.code), 43, { color: palette.brand, weight: 700 }),
    text(72, top + 142, 'По категориям', 24, { weight: 700 }),
  ];
  for (const [index, [category, amount]] of categories.entries()) {
    const row = y + index * 52;
    parts.push(text(72, row + 31, category, 22));
    parts.push(rect(375, row + 16, 305, 22, palette.line, 10));
    parts.push(rect(375, row + 16, Math.max(3, Math.round(305 * amount / maxCategory)), 22, palette.brand, 10));
    parts.push(text(929, row + 32, money(amount, group.code), 21, { anchor: 'end', weight: 600 }));
  }
  parts.push(text(72, trendY, title, 24, { weight: 700 }));
  const max = Math.max(...visible.map(([, amount]) => amount));
  const step = 850 / visible.length;
  const barWidth = Math.min(76, step - 16);
  for (const [index, [period, amount]] of visible.entries()) {
    const x = 74 + index * step + step / 2;
    const baseline = trendY + 160;
    const height = Math.max(5, Math.round(105 * amount / max));
    const label = period.length === 7 ? `${period.slice(5)}.${period.slice(2, 4)}` : `${period.slice(8)}.${period.slice(5, 7)}`;
    parts.push(rect(x - barWidth / 2, baseline - height, barWidth, height, palette.brand, 6));
    parts.push(text(x, baseline - height - 9, number.format(amount / 100), 18, { anchor: 'middle', color: palette.muted }));
    parts.push(text(x, baseline + 29, label, 18, { anchor: 'middle', color: palette.muted }));
  }
  return { bottom: bottom + 22, svg: parts.join('') };
}

export async function expenseChart(state, period, timezone) {
  const groups = chartData(state, period, timezone);
  if (!groups.length) return null;
  let bottom = 125;
  const panels = [];
  for (const group of groups) {
    const rendered = panel(group, bottom + 22);
    bottom = rendered.bottom;
    panels.push(rendered.svg);
  }
  const title = text(48, 66, 'Расходы', 45, { weight: 700 });
  const description = text(50, 107, periodLabel(period), 24, { color: palette.muted });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${bottom + 38}" font-family="Noto Sans, Arial, sans-serif">${rect(0, 0, 1000, bottom + 38, palette.paper)}${title}${description}${panels.join('')}</svg>`;
  const { Resvg } = await import('@resvg/resvg-js');
  return new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Noto Sans' } }).render().asPng();
}
