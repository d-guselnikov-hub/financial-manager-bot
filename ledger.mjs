const categories = [
  ['Табак и никотин', /снюс|табак|сигарет|сиги|стики/iu, 'На эту статью можно поставить отдельный лимит.', true],
  ['Алкоголь', /пиво|алкоголь|вино|водка/iu, 'На эту статью можно поставить отдельный лимит.', true],
  ['Сервисы и подписки', /подписк|премиум|домен|vps|чатгпт|chatgpt|клод|claude/iu, 'Проверьте, какими платными сервисами пользуетесь регулярно.', true],
  ['Документы и услуги', /нотариус|документ|распечатк/iu, 'Редкие платежи за услуги удобно учитывать отдельно.'],
  ['Маркетплейсы', /wildberries|вайлдберриз|пиндодо|pinduoduo|temu|тему|маркетплейс/iu, 'Сравните итоговую цену с учётом доставки перед повторной покупкой.', true],
  ['Погашение долгов', /(?:вернул[аи]?.*долг|долг.*вернул[аи]?|погасил[аи]?.*долг)/iu, 'Отдельная категория поможет видеть, сколько ушло на погашение.'],
  ['Продукты', /продукт|супермаркет|пят[её]рочк|перекр[её]сток|вкусвилл|молок|хлеб|овощ|магнит|магнум|смолл|творож|бомбар|яблок|банан/iu, 'Список покупок на неделю поможет реже докупать по мелочи.'],
  ['Кафе и доставка', /кафе|ресторан|кофе|доставк|суши|пицц|обед|ужин|завтрак|бургер|шаурм|донер/iu, 'Если такое повторяется, можно выделить на кафе и доставку недельный лимит.', true],
  ['Транспорт', /такси|метро|трамва|автобус|бензин|парков|проезд|заправ|каршеринг|билет|онай/iu, 'Регулярные поездки удобно считать отдельной строкой бюджета.'],
  ['Жильё и счета', /квартир|аренд|жкх|коммунал|электрич|интернет|связь|ипотек/iu, 'Если платёж регулярный, заложите его в бюджет следующего месяца.'],
  ['Здоровье', /аптек|врач|лекарств|стоматолог|таблет|клиник|анализ/iu, 'Для регулярных расходов на здоровье удобно предусмотреть отдельную сумму.'],
  ['Дом и быт', /хозтовар|бытов|мебел|ремонт|посуд|порошок/iu, 'Для повторяющихся покупок можно сравнивать цену за единицу.'],
  ['Одежда и уход', /одежд|обув|кроссов|маникюр|стрижк|косметик|парикмах|куртк/iu, 'Если трата повторяется, её проще планировать заранее.', true],
  ['Развлечения', /кино|театр|концерт|игр[ауы]|музе|развлечен|мероприяти/iu, 'Посмотрите, сколько хотите выделить на развлечения в следующий месяц.', true],
  ['Подарки', /подар|цветы|букет/iu, 'На ближайшие праздники можно заранее выделить отдельную сумму.', true],
  ['Другое', /$^/u, 'Если такие покупки повторяются, их можно выделить в отдельную статью бюджета.'],
  ['Без назначения', /$^/u, ''],
];

const moneyPattern = /(?<![\p{L}\p{N}_])(?:([₸₽$€])[ \t]*)?([+−-]?\d+(?:[ \u00a0\u202f]\d{3}(?!\d))*(?:[,.]\d{1,2})?)(?:[ \t\u00a0\u202f]*(тыс\.?|[кk])(?![\p{L}\p{N}_]))?(?:[ \t\u00a0\u202f]*(тенге|тн?г\.?|KZT|руб(?:лей|ля|ль|\.)?|р\.|RUB|USD|EUR|[₸₽$€]))?(?![\p{L}\p{N}_])/giu;
const amountLimit = 100_000_000_000;
const currencyCodes = new Map([['₸', 'KZT'], ['₽', 'RUB'], ['$', 'USD'], ['€', 'EUR']]);

function currency(mark) {
  if (!mark) return undefined;
  if (/^(тенге|тн?г\.?)$/iu.test(mark)) return 'KZT';
  return currencyCodes.get(mark) ?? (/^(KZT|USD|EUR)$/i.test(mark) ? mark.toUpperCase() : 'RUB');
}

export function parseAmount(value) {
  const [match, second] = value.matchAll(moneyPattern);
  if (!match || second || match[0] !== value) return null;
  const [, prefix, digits, thousands, suffix] = match;
  const suffixCurrency = currency(suffix);
  if (prefix && suffixCurrency && currency(prefix) !== suffixCurrency) return null;
  const minor = Math.round(Number(digits.replace(/[ \u00a0\u202f]/gu, '').replace(',', '.')) * (thousands ? 100_000 : 100));
  if (!Number.isSafeInteger(minor) || minor <= 0 || minor > amountLimit) return null;
  return { minor, currency: currency(prefix) ?? suffixCurrency ?? 'KZT' };
}

export function sourceAmounts(text) {
  return [...text.matchAll(moneyPattern)].map(match => match[0]);
}

const incomeSource = /(?<!\p{L})(?:з\/?п|зарплат\p{L}*|аванс\p{L}*|преми\p{L}*|доход\p{L}*|поступлени\p{L}*|подработк\p{L}*|выплат\p{L}*|гонорар\p{L}*)(?!\p{L})/iu;

export function parseIncome(text, force = false, context = '') {
  if (!force && !incomeSource.test(text)) return null;
  if (!force && /(?<!\p{L})(?:потратил\p{L}*|купил\p{L}*|заплатил\p{L}*|оплатил\p{L}*)(?!\p{L})/iu.test(text)) return null;
  if (!force && /[?]|(?<!\p{L})(?:будет|будут|жду|ждём|ждем|ожидаем|должны|когда|планирую|остаток|из|погашение|за[её]м|кредит|перевод между)(?!\p{L})/iu.test(text)) {
    return { kind: 'ignore' };
  }
  const [source, extra] = sourceAmounts(text);
  const amount = source && !extra && parseAmount(source);
  if (!amount || /[£¥₴₾₿]|\b(?:BYN|UAH|CNY|GBP|JPY|TRY|AED|GEL|AMD|USDT)\b/iu.test(text)) return { kind: 'pending', flow: 'income' };
  const description = text.replace(source, '').replace(/^[\s:–—-]+|[\s:–—.!-]+$/gu, '').replace(/\s+/gu, ' ');
  const sourceName = description || context.match(incomeSource)?.[0] || 'Поступление';
  const title = /^з\/?п$/iu.test(sourceName) ? 'Зарплата' : sourceName;
  return { kind: 'income', inflow: { ...amount, title: title.slice(0, 160) } };
}

function parseLine(line, force) {
  const [description, categoryName, extra] = line.split('|').map(part => part.trim());
  const matched = categories.find(([, pattern]) => pattern.test(description));
  if (!force && matched?.[0] !== 'Погашение долгов' && /^(?:перев[её]л[аи]?|перевод|возврат|вернул[аи]?|получил[аи]?|зарплата|доход|отложил[аи]?|пополнил[аи]?|в долг)(?!\p{L})/iu.test(description)) return { kind: 'ignore' };
  const intent = /(?:^|\s)(?:купил[аи]?|потратил[аи]?|оплатил[аи]?|заплатил[аи]?|списал[ио]?)(?!\p{L})/iu.test(description);
  const amounts = [...description.matchAll(moneyPattern)];
  const hasCurrency = amounts.some(([, prefix, , , suffix]) => prefix || suffix);
  const endsWithAmount = amounts.some(match => match.index === 0 || /^[\s.!…]*$/u.test(description.slice(match.index + match[0].length)));
  const possible = force || Boolean(categoryName || intent || hasCurrency || (amounts.length && (matched || endsWithAmount)));
  if (!possible) return { kind: 'ignore' };
  const pending = { kind: 'pending' };
  if (amounts.length !== 1 || extra !== undefined) return pending;
  if (!force && /[?]|(?:^|\s)(?:может|хочу|хотим|будет|будут|стоит|стоят|планирую|планируем|надо|примерно|около)(?!\p{L})|(?:^|\s)до\s+\d/iu.test(description)) return pending;
  // Unsupported currency markers and quantities require an explicit correction.
  if (/[£¥₴₾₿]|\b(?:BYN|UAH|CNY|GBP|JPY|TRY|AED|GEL|AMD|USDT)\b/iu.test(description)) return pending;
  const [match] = amounts;
  const amount = parseAmount(match[0].replace(/^[-−]/u, ''));
  const before = description.slice(0, match.index);
  const after = description.slice(match.index + match[0].length);
  if ((/[+−-]$/u.test(before.trimEnd()) && !/\p{L}/u.test(before)) || /^(?:[,.]\d|\s*(?:шт|кг|грамм|чел|минут|час|дн[ея])(?:$|[\s.,])|\s*[%:])/iu.test(after)) return pending;
  const title = `${before} ${after}`.replace(/^[\s:–—-]+|[\s:–—.!-]+$/gu, '').replace(/\s+/gu, ' ');
  const explicit = categoryName && categories.find(([name]) => name.toLowerCase() === categoryName.toLowerCase());
  if (!amount || !/\p{L}/u.test(title) || (categoryName && !explicit)) return pending;
  if (!explicit && !matched && !intent && !hasCurrency && !force) return pending;
  return { kind: 'expense', item: { ...amount, title: title.slice(0, 160), category: (explicit || matched)?.[0] ?? 'Другое' } };
}

export function parseExpense(message, force = false) {
  const parsed = message.split(/\r?\n/u).map(line => line.trim()).filter(Boolean).map(line => parseLine(line, force));
  const expenses = parsed.filter(result => result.kind === 'expense');
  if (parsed.some(result => result.kind === 'pending') || (expenses.length && expenses.length < parsed.length)) return { kind: 'pending' };
  return expenses.length ? { kind: 'expense', items: expenses.map(result => result.item) } : { kind: 'ignore' };
}

const formats = new Map();
export function money(minor, code) {
  if (!formats.has(code)) {
    formats.set(code, new Intl.NumberFormat('ru-RU', {
      style: 'currency', currency: code, currencyDisplay: code === 'KZT' ? 'narrowSymbol' : 'symbol',
      minimumFractionDigits: 0, maximumFractionDigits: 2,
    }));
  }
  return formats.get(code).format(minor / 100);
}

const monthFormats = new Map();
export function monthAt(timestamp, timezone) {
  if (!monthFormats.has(timezone)) monthFormats.set(timezone, new Intl.DateTimeFormat('en', { timeZone: timezone, year: 'numeric', month: '2-digit' }));
  const parts = monthFormats.get(timezone).formatToParts(timestamp);
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

function groupByCurrency(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.currency)) groups.set(item.currency, { total: 0, count: 0, categories: new Map() });
    const group = groups.get(item.currency);
    group.total += item.minor;
    group.count++;
    group.categories.set(item.category, (group.categories.get(item.category) ?? 0) + item.minor);
  }
  return groups;
}

export function entriesFor(state, period, timezone) {
  return Object.values(state.records).filter(record => period === 'all' || monthAt(record.at, timezone) === period);
}

export function findCategory(value) {
  return categories.find(([name]) => name.toLowerCase() === value.trim().toLowerCase())?.[0];
}

export function monthlyBudget(state, period, timezone) {
  const months = new Map();
  let firstDate = Infinity;
  for (const record of Object.values(state.records)) {
    if (!record.items?.length) continue;
    const month = monthAt(record.at, timezone);
    if (month > period) continue;
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(...record.items);
    firstDate = Math.min(firstDate, record.at);
  }
  const firstMonth = Number.isFinite(firstDate) ? monthAt(firstDate, timezone) : '';
  const firstDay = firstMonth ? new Intl.DateTimeFormat('en', { timeZone: timezone, day: 'numeric' }).format(firstDate) : '';
  const basis = [...months.keys()].filter(month => month < period && (month !== firstMonth || firstDay === '1')).sort().slice(-2);
  const historical = groupByCurrency(basis.flatMap(month => months.get(month)));
  const current = groupByCurrency(months.get(period) ?? []);
  const totals = [];
  const byCategory = [];
  for (const [currency, group] of historical) {
    totals.push({ currency, minor: Math.round(group.total / basis.length), automatic: true });
    for (const [category, amount] of group.categories) {
      if (category === 'Без назначения') continue;
      byCategory.push({ currency, category, minor: Math.round(amount / basis.length), automatic: true });
    }
  }
  if (state.budget) {
    const index = totals.findIndex(row => row.currency === state.budget.currency);
    if (index >= 0) totals[index] = state.budget;
    else totals.push(state.budget);
  }
  for (const [category, limit] of Object.entries(state.categoryBudgets ?? {})) {
    const index = byCategory.findIndex(row => row.category === category && row.currency === limit.currency);
    if (index >= 0) byCategory[index] = { ...limit, category };
    else byCategory.push({ ...limit, category });
  }
  return {
    basis,
    totals: totals.map(row => ({ ...row, spent: current.get(row.currency)?.total ?? 0 })),
    categories: byCategory.map(row => ({ ...row, spent: current.get(row.currency)?.categories.get(row.category) ?? 0 })),
  };
}

function budgetLine(row) {
  const { category, currency: code, minor, spent, automatic } = row;
  const remaining = minor - spent;
  const label = category ?? 'Общий бюджет';
  const kind = automatic ? 'ориентир' : 'лимит';
  const balance = remaining >= 0 ? 'осталось' : 'превышение';
  return `${label} — ${kind} ${money(minor, code)} · ${balance} ${money(Math.abs(remaining), code)}`;
}

function categoryAvailable(row, totals) {
  const remaining = row.minor - row.spent;
  const total = totals.find(limit => limit.currency === row.currency);
  return total ? Math.min(remaining, Math.max(0, total.minor - total.spent)) : remaining;
}

function categoryBudgetLine(row, totals, detailed) {
  const remaining = row.minor - row.spent;
  const available = categoryAvailable(row, totals);
  const shown = money(Math.abs(available), row.currency);
  if (!detailed) return `${row.category} — ${available < 0 ? 'перерасход' : 'доступно'} ${shown}`;
  if (available === remaining) return budgetLine(row);
  const kind = row.automatic ? 'ориентир' : 'лимит';
  return `${row.category} — ${kind} ${money(row.minor, row.currency)} · доступно ${shown} из общего остатка (запас категории ${money(remaining, row.currency)})`;
}

const compactCategories = ['Кафе и доставка', 'Продукты', 'Транспорт'];

export function budgetOverview(state, period, timezone, detailed = false) {
  const plan = monthlyBudget(state, period, timezone);
  const sorted = plan.categories.sort((a, b) => b.minor - a.minor);
  if (!plan.totals.length && !sorted.length) return 'Пока нет лимитов и данных за завершённый месяц. Можно задать общий лимит сообщением «бюджет 60000».';
  const preferred = compactCategories.flatMap(name => sorted.filter(row => row.category === name));
  const visible = detailed ? sorted : [...preferred, ...sorted.filter(row => !compactCategories.includes(row.category))].slice(0, 3);
  const lines = [
    `Бюджет на ${period}`,
    ...plan.totals.map(budgetLine),
    ...visible.map(row => categoryBudgetLine(row, plan.totals, detailed)),
  ];
  if (visible.some(row => plan.totals.some(total => total.currency === row.currency))) {
    lines.push('', 'Любая трата уменьшает общий остаток.');
  }
  if (!detailed && sorted.length > visible.length) lines.push('Все категории — «бюджет подробно».');
  if (detailed && [...plan.totals, ...visible].some(row => row.automatic)) lines.push('', `Ориентиры рассчитаны по расходам за ${plan.basis.join(', ')}.`);
  return lines.join('\n');
}

export function budgetForExpense(state, record, period, timezone) {
  if (monthAt(record.at, timezone) !== period) return [];
  const plan = monthlyBudget(state, period, timezone);
  return [
    ...plan.categories.filter(row => record.items.some(item => item.currency === row.currency && item.category === row.category))
      .map(row => categoryBudgetLine(row, plan.totals, true)),
    ...plan.totals.filter(row => record.items.some(item => item.currency === row.currency)).map(budgetLine),
  ];
}

function incomeTotals(records) {
  const totals = new Map();
  for (const { inflow } of records) {
    if (inflow) totals.set(inflow.currency, (totals.get(inflow.currency) ?? 0) + inflow.minor);
  }
  return totals;
}

export function savingsOverview(state, period, timezone) {
  const records = entriesFor(state, period, timezone);
  const incomes = incomeTotals(records);
  if (!incomes.size) return 'Добавьте поступление за этот месяц, например «зп 350 000 ₸» или /income 350000 зарплата. Тогда я смогу оценить, сколько отложить.';
  const spend = groupByCurrency(records.flatMap(record => record.items ?? []));
  const plan = monthlyBudget(state, period, timezone);
  const lines = [`Сколько можно отложить за ${period}`];
  for (const [code, income] of incomes) {
    const spent = spend.get(code)?.total ?? 0;
    const balance = income - spent;
    lines.push(`Поступило ${money(income, code)} · потрачено ${money(spent, code)}.`);
    lines.push(`${balance < 0 ? 'По записям расходы выше поступлений на' : 'Остаток по записям'} ${money(Math.abs(balance), code)}.`);
    const budget = plan.totals.find(row => row.currency === code);
    if (!budget) {
      lines.push('Задайте месячный лимит через /budget, чтобы учесть предстоящие расходы.');
      continue;
    }
    const reserved = Math.max(0, budget.minor - spent);
    const available = Math.max(0, balance - reserved);
    if (reserved) lines.push(`На оставшиеся расходы по ${budget.automatic ? 'ориентиру' : 'лимиту'} оставьте ${money(reserved, code)}.`);
    if (spent > budget.minor) lines.push('Лимит расходов уже превышен. Учтите оставшиеся платежи, если они ещё предстоят.');
    lines.push(`Можно отложить до ${money(available, code)} по записанным поступлениям и расходам.`);
    if (state.goal?.currency === code) {
      const target = Math.ceil(state.goal.minor / state.goal.months);
      lines.push(`План по цели — ${money(target, code)} в месяц. ${available >= target ? 'Этот взнос помещается в расчёт.' : `До полного взноса по плану не хватает ${money(target - available, code)}.`}`);
    }
  }
  lines.push('Если уже отложили деньги или ожидаются платежи сверх бюджета, вычтите их из доступной суммы.');
  return lines.join('\n');
}

export function summarize(state, period, timezone) {
  const records = entriesFor(state, period, timezone);
  const grouped = groupByCurrency(records.flatMap(record => record.items ?? []));
  const lines = [period === 'all' ? 'Расходы за всю историю' : `Расходы за ${period}`];
  if (!grouped.size) lines.push('Подтверждённых расходов пока нет.');
  for (const [code, group] of grouped) {
    lines.push('', `Итого ${money(group.total, code)} · записей ${group.count}`);
    for (const [category, total] of [...group.categories].sort((a, b) => b[1] - a[1])) {
      lines.push(`• ${category} — ${money(total, code)} (${Math.round(total / group.total * 100)}%)`);
    }
  }
  const pending = records.filter(record => record.kind === 'pending').length;
  if (pending) lines.push('', `Ждут уточнения: ${pending}. Посмотреть список — /review.`);
  const incomes = incomeTotals(records);
  for (const [code, total] of incomes) lines.push(`Записанные поступления — ${money(total, code)}.`);
  if (period === monthAt(Date.now(), timezone)) {
    const plan = monthlyBudget(state, period, timezone);
    if (plan.totals.length) lines.push('', ...plan.totals.map(budgetLine), 'По категориям — /budget.');
    if (incomes.size) lines.push('Оценка накоплений — /savings.');
  }
  return lines.join('\n');
}

export function advice(state, period, timezone) {
  const groups = groupByCurrency(entriesFor(state, period, timezone).flatMap(record => record.items ?? []));
  const optional = new Set(categories.filter(category => category[3]).map(([name]) => name));
  const lines = [period === 'all' ? 'Идеи на основе расходов за всю историю' : `Идеи на основе расходов за ${period}`];
  for (const [code, group] of groups) {
    const [largest] = [...group.categories].filter(([name]) => optional.has(name)).sort((a, b) => b[1] - a[1]);
    if (!largest) continue;
    const [name, total] = largest;
    lines.push(`• ${name} — ${money(total, code)}. Если сократить эту статью на 10%, освободится ${money(Math.round(total / 10), code)} при таком же уровне трат.`);
  }
  if (lines.length === 1) lines.push('Когда накопятся записи по гибким статьям, здесь появится расчёт экономии.');
  if (state.goal) {
    const { minor, currency: code, months } = state.goal;
    lines.push(`• Чтобы накопить ${money(minor, code)} с нуля за ${months} мес., нужно откладывать ${money(Math.ceil(minor / months), code)} в месяц.`);
  } else {
    lines.push('• Можно задать цель. Например, /goal 120000 12 рассчитает взнос для 120 000 ₸ за 12 месяцев.');
  }
  return lines.join('\n');
}

export function comment(items, id, note) {
  if (items.some(item => item.category === 'Транспорт' && /такси/iu.test(item.title))) {
    note = 'Если поездка была без спешки и есть удобный маршрут, в следующий раз автобус или метро помогут сэкономить.';
  }
  return items.map(({ minor, currency: code, title, category }) => {
    const tip = categories.find(([name]) => name === category)[2];
    const label = category === 'Без назначения' ? category : `${category} · ${title}`;
    return `Записал ${money(minor, code)} · ${label}${note || !tip ? '' : `\n${tip}`}`;
  }).join('\n\n') + `${note ? `\n${note}` : ''}\n#${id}`;
}

export const categoryNames = categories.map(([name]) => name).join(', ');
