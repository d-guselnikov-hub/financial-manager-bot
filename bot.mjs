import { mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { advice, balancesOverview, budgetForExpense, budgetOverview, categoryNames, comment, findCategory, money, monthAt, parseAmount, parseBalances, parseExpense, parseIncome, savingsOverview, summarize } from './ledger.mjs';
import { GeminiError, makeGemini } from './gemini.mjs';
import { downloadScreenshot, ScreenshotError, screenshotAttachment, screenshotDraft, screenshotPreview } from './screenshot.mjs';

const menuRows = [
  [['Этот месяц', '/total'], ['Вся история', '/total all']],
  [['Бюджет', '/budget'], ['Сколько отложить', '/savings']],
  [['Советы', '/advice'], ['Уточнить записи', '/review']],
  [['Накопления', '/funds']],
];
const menuCommands = new Map(menuRows.flat().map(([label, command]) => [label.toLowerCase(), command]));
export const menuText = 'Кнопки «Финансового управляющего» под полем ввода. Траты и поступления можно писать обычными сообщениями.';
export const menuKeyboard = {
  keyboard: menuRows.map(row => row.map(([text]) => ({ text }))),
  is_persistent: true,
  resize_keyboard: true,
  input_field_placeholder: 'Трата или поступление',
};

const instructions = `Финансовый управляющий
Напишите в чат «такси 2500» или «продукты 12 500 ₸». Суммы без обозначения валюты считаю в тенге. Несколько покупок можно записать отдельными строками.
/menu — показать кнопки
/total — сводка за текущий месяц
/total all — сводка за всю историю
/total 2026-10 — сводка за выбранный месяц
/advice — как сократить расходы и сколько откладывать
/budget — общий бюджет, лимиты категорий и остатки
/budget 60000 — задать общий месячный лимит
/budget Транспорт | 25000 — задать месячный лимит категории
/income 350000 зарплата — записать поступление. Можно просто написать «зп 350 000 ₸».
/savings — сколько можно отложить в этом месяце
/funds — текущие деньги и накопления по целям
«сейчас всего 450000» и «отложено на отпуск 150000» — обновить суммы
Фото чека или скриншот с подписью «скрин» — распознать и проверить перед записью
«прочитай» в ответ на старое фото или сообщение об остатке — обработать его заново
/goal 120000 12 — задать сумму и срок накопления в месяцах
/review — расходы, которые ждут уточнения
/add кофе 250 — записать расход явно
/fix 12 кофе 230 — изменить запись #12
/skip 12 — исключить запись #12
Категорию можно указать после |. Например: /add кофемолка 2000 | Дом и быт
/categories — список категорий`;

const question = 'Уточните сумму и назначение. Например, «продукты 9 500 ₸». Если это не расход, используйте /skip';
const validPeriod = period => period === 'all' || /^\d{4}-(0[1-9]|1[0-2])$/u.test(period);

function commandText(text) {
  const menu = menuCommands.get(text.toLowerCase());
  if (menu) return menu;
  const [, value] = /^бюджет\s+(.+)$/iu.exec(text) ?? [];
  if (!value) return text;
  if (value.toLowerCase() === 'подробно') return '/budget details';
  if (parseAmount(value) || value.toLowerCase() === 'off' || value.includes('|')) return `/budget ${value}`;
  const [, label, amount] = /^(.*?)\s+([+\d][\s\S]*|off)$/iu.exec(value) ?? [];
  return label && findCategory(label) ? `/budget ${label} | ${amount}` : text;
}

const project = dirname(fileURLToPath(import.meta.url));
const chatIdPattern = /^-[1-9]\d*$/u;

async function optionalFile(file) {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

async function settings(env, mode) {
  const database = resolve(project, env.DATA_FILE?.trim() || 'data/ledger.json');
  const chatFile = resolve(dirname(database), 'chat-id');
  const chat = env.TELEGRAM_CHAT_ID?.trim() || await optionalFile(chatFile);
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim() || await optionalFile(resolve(project, '0. opt/tg_bot_token.txt'));
  if ((chat || !['discover', 'serve', 'check'].includes(mode)) && !chatIdPattern.test(chat)) throw new Error('Подключите группу или укажите её ID в TELEGRAM_CHAT_ID.');
  if (['run', 'serve', 'discover', 'check'].includes(mode) && !/^\d+:[\w-]+$/u.test(telegramToken)) throw new Error('Укажите токен бота в 0. opt/tg_bot_token.txt или TELEGRAM_BOT_TOKEN.');
  const timezone = env.TIME_ZONE?.trim() || 'Asia/Yekaterinburg';
  monthAt(Date.now(), timezone);
  const key = env.GEMINI_API_KEY?.trim() ?? await optionalFile(resolve(project, '0. opt/gemini_api_key.txt'));
  if (key && !/^[\w.-]+$/u.test(key)) throw new Error('Файл Gemini должен содержать только ключ, одной строкой.');
  const gemini = key && mode !== 'discover' ? makeGemini(key, env.GEMINI_MODEL?.trim() || 'gemini-3.8-flash') : null;
  return { chat, chatFile, telegramToken, timezone, gemini, database };
}

function api(token, request = fetch) {
  return async (method, payload, timeout = 15_000) => {
    let response;
    let body;
    try {
      response = await request(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout),
      });
      body = await response.json();
    } catch {
      throw new Error(`Telegram API недоступен (${method}).`);
    }
    if (!response.ok || !body.ok) {
      const error = new Error(`Telegram API вернул HTTP ${body.error_code ?? response.status} (${method}).`);
      error.status = body.error_code ?? response.status;
      error.retryAfter = body.parameters?.retry_after;
      throw error;
    }
    return body.result;
  };
}

async function openState(file, chat) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { version: 1, chat, next: 1, records: {}, prompts: {} };
  }
  const state = JSON.parse(raw);
  if (state.version !== 1 || state.chat !== chat) throw new Error('Файл данных относится к другой группе или версии бота. Проверьте DATA_FILE и TELEGRAM_CHAT_ID.');
  return state;
}

async function saveState(file, state) {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state), 'utf8');
  await rename(temporary, file);
}

function put(state, key, at, parsed, text, balanceOwner) {
  const previous = state.records[key];
  const record = { at: previous?.at ?? at, kind: parsed.kind };
  if (parsed.kind !== 'ignore' || previous?.id) record.id = previous?.id ?? state.next++;
  if (parsed.kind === 'pending') {
    record.text = text;
    if (parsed.flow) record.flow = parsed.flow;
    if (parsed.draft) record.draft = parsed.draft;
  }
  if (parsed.kind === 'expense') record.items = parsed.items;
  if (parsed.kind === 'income') record.inflow = parsed.inflow;
  if (parsed.kind === 'balances') record.balances = parsed.balances;
  const owner = previous?.balanceOwner ?? balanceOwner;
  if (owner && (parsed.kind === 'balances' || ['balances', 'image'].includes(parsed.flow))) record.balanceOwner = owner;
  state.records[key] = record;
  if (record.kind !== 'pending') {
    for (const [prompt, target] of Object.entries(state.prompts)) {
      if (target === key) delete state.prompts[prompt];
    }
  }
  return record;
}

function amountOnly(text) {
  const amount = parseAmount(text.trim());
  return amount ? { kind: 'expense', items: [{ ...amount, category: 'Без назначения', title: 'Назначение не указано' }] } : null;
}

function localEntry(text) {
  return parseBalances(text) ?? parseIncome(text) ?? amountOnly(text);
}

function classifyLocally(text, clarification) {
  if (!clarification) return amountOnly(text) ?? parseExpense(text);
  return parseAmount(clarification) ? parseExpense(`${text} ${clarification}`) : parseExpense(clarification, true);
}

async function classify(text, config, clarification) {
  if (!clarification) {
    const known = localEntry(text);
    if (known) return known;
  }
  if (!config.gemini) return classifyLocally(text, clarification);
  try {
    const [result] = await config.gemini.classify([{ text, clarification }]);
    return result;
  } catch (error) {
    if (!(error instanceof GeminiError)) throw error;
    console.error(error.message);
    const local = classifyLocally(text, clarification);
    if (local.kind === 'expense') return local;
    return { kind: 'pending', quiet: !clarification && local.kind === 'ignore', note: 'Gemini временно недоступен. Уточните расход в формате «такси 2500 ₸».' };
  }
}

function needsCategory(record) {
  return record?.kind === 'expense' && record.items.length === 1 && record.items[0].category === 'Без назначения';
}

function responseFor(parsed, record, key, state, period, timezone) {
  if (parsed.kind === 'balances') return { text: `Обновил остатки. #${record.id}\n\n${savingsOverview(state, period, timezone)}` };
  if (parsed.kind === 'income') {
    const { minor, currency, title } = record.inflow;
    const lines = [`Записал поступление ${money(minor, currency)} · ${title}\n#${record.id}`];
    if (monthAt(record.at, timezone) === period) lines.push('', savingsOverview(state, period, timezone));
    return { text: lines.join('\n') };
  }
  if (parsed.kind === 'expense') {
    const lines = [comment(parsed.items, record.id, parsed.note), ...budgetForExpense(state, record, period, timezone)];
    if (needsCategory(record)) lines.push('На что ушла сумма? Ответьте на это сообщение, например «такси» или «Продукты».');
    return { text: lines.join('\n'), prompt: needsCategory(record) ? key : undefined };
  }
  if (parsed.kind === 'pending' && !parsed.quiet) {
    if (parsed.flow === 'image') return { text: `${screenshotPreview(parsed.draft)}\n\nОтветьте «да», чтобы записать, или «нет», чтобы отменить.\n#${record.id}`, prompt: key };
    if (parsed.flow === 'balances') return { text: `Укажите одну сумму на строку. Например, «сейчас всего 450000» или «отложено на отпуск 150000».\n#${record.id}`, prompt: key };
    if (parsed.flow === 'income') return { text: `Сколько поступило? Ответьте, например, «350 000 ₸ зарплата».\n#${record.id}`, prompt: key };
    return { text: `${parsed.note || `${question} ${record.id}.`}\n#${record.id}`, prompt: key };
  }
}

function review(state, after) {
  const rows = Object.values(state.records).filter(record => record.kind === 'pending' && record.id > after).sort((a, b) => a.id - b.id);
  if (!rows.length) return 'Записей, которые ждут уточнения, больше нет.';
  const page = rows.slice(0, 8);
  const lines = page.map(record => `#${record.id} · ${(record.text ?? '').replace(/\s+/gu, ' ').slice(0, 150)}`);
  lines.push('', 'Уточнить — /fix 12 такси 480. Исключить — /skip 12. Подставьте номер записи.');
  if (rows.length > page.length) lines.push(`Следующая страница — /review ${page.at(-1).id}`);
  return lines.join('\n');
}

export async function handleUpdate(state, config, update, bot) {
  const incoming = update.message ?? update.edited_message;
  if (!incoming || String(incoming.chat.id) !== config.chat || incoming.from?.is_bot) return;
  const quoted = incoming.reply_to_message;
  const requestedScan = /^прочитай[.!]?$/iu.test(incoming.text?.trim() ?? '') ||
    /^\/scan(?:@(\w+))?$/iu.test(incoming.text?.trim() ?? '') && (!incoming.text.includes('@') || incoming.text.toLowerCase().endsWith(`@${bot.username.toLowerCase()}`));
  const quotedText = (quoted?.text ?? quoted?.caption ?? '').trim();
  const replay = requestedScan && !update.edited_message && quoted && String(quoted.chat?.id) === config.chat && !quoted.from?.is_bot &&
    (screenshotAttachment(quoted, quotedText) || parseBalances(quotedText));
  const message = replay ? quoted : incoming;
  const text = (message.text ?? message.caption ?? '').trim();
  const key = `tg:${message.message_id}`;
  const at = message.date * 1_000;
  const owner = message.from?.id ? { id: String(message.from.id), title: (message.from.first_name ?? '').replace(/\p{C}/gu, '').slice(0, 40) } : undefined;
  const command = commandText(text);
  const cmd = /^\/([a-z]+)(?:@(\w+))?(?:\s|$)/iu.exec(command);
  const say = text => ({ text });
  const period = monthAt(Date.now(), config.timezone);
  const expenseReply = (parsed, record, target) => responseFor(parsed, record, target, state, period, config.timezone);
  if (cmd) {
    if (update.edited_message || (cmd[2] && cmd[2].toLowerCase() !== bot.username.toLowerCase())) return;
    const argument = command.slice(cmd[0].length).trim();
    switch (cmd[1].toLowerCase()) {
      case 'start': case 'help': return say(instructions);
      case 'menu': return say(menuText);
      case 'categories': return say(categoryNames);
      case 'funds': return say(balancesOverview(state));
      case 'savings': return say(savingsOverview(state, period, config.timezone));
      case 'total': {
        const selected = argument.toLowerCase() || period;
        if (!validPeriod(selected)) return say('Используйте /total, /total all или /total 2026-10.');
        return say(summarize(state, selected, config.timezone));
      }
      case 'advice': {
        const selected = argument.toLowerCase() || period;
        if (!validPeriod(selected)) return say('Используйте /advice, /advice all или /advice 2026-10.');
        const ideas = advice(state, selected, config.timezone);
        const summary = selected === period ? `${ideas}\n\n${savingsOverview(state, period, config.timezone)}` : ideas;
        if (!config.gemini) return say(summary);
        try {
          const expenseState = { ...state, records: Object.fromEntries(Object.entries(state.records).filter(([, record]) => record.kind !== 'income')) };
          const idea = await config.gemini.advice(summarize(expenseState, selected, config.timezone));
          return say(idea ? `${summary}\n• ${idea}` : summary);
        } catch (error) {
          if (!(error instanceof GeminiError)) throw error;
          console.error(error.message);
          return say(summary);
        }
      }
      case 'budget': {
        if (!argument) return say(budgetOverview(state, period, config.timezone));
        if (argument.toLowerCase() === 'details') return say(`${budgetOverview(state, period, config.timezone, true)}\n\nИзменить лимит можно сообщением «бюджет 750000» или «бюджет транспорт 30000».`);
        const [label, raw, extra] = argument.split('|').map(part => part.trim());
        const category = raw === undefined ? undefined : findCategory(label);
        if (extra !== undefined || (raw !== undefined && !category)) return say('Укажите категорию из /categories. Например, /budget Транспорт | 25000.');
        const value = raw ?? label;
        if (value.toLowerCase() === 'off') {
          if (category) delete state.categoryBudgets?.[category];
          else delete state.budget;
          return say(`${category ?? 'Общий бюджет'} — ручной лимит снят. Текущий план — /budget.`);
        }
        const amount = parseAmount(value);
        if (!amount) return say('Укажите месячный лимит. Например, /budget 60000 или /budget Транспорт | 25000. Для снятия лимита укажите off вместо суммы.');
        if (category) (state.categoryBudgets ??= {})[category] = amount;
        else state.budget = amount;
        return say(`${category ?? 'Общий бюджет'} — месячный лимит ${money(amount.minor, amount.currency)}.`);
      }
      case 'goal': {
        if (argument === 'off') {
          delete state.goal;
          return say('Цель снята.');
        }
        const [, raw, monthsText] = /^(.*?)\s+(\d{1,3})$/u.exec(argument) ?? [];
        const amount = raw && parseAmount(raw.trim());
        const months = Number(monthsText);
        if (!amount || !months || months > 600) return say('Укажите сумму и число месяцев. Например, /goal 120000 12. Снять цель — /goal off.');
        state.goal = { ...amount, months };
        return say(`Для цели ${money(amount.minor, amount.currency)} откладывайте ${money(Math.ceil(amount.minor / months), amount.currency)} в месяц в течение ${months} мес.`);
      }
      case 'review': return /^\d*$/u.test(argument) ? say(review(state, Number(argument))) : say('Используйте /review или /review 12.');
      case 'income': {
        const parsed = parseIncome(argument, true);
        if (parsed.kind !== 'income') return say('Укажите одно поступление. Например, /income 350000 зарплата.');
        return expenseReply(parsed, put(state, key, at, parsed, argument), key);
      }
      case 'add': {
        const parsed = parseExpense(argument, true);
        if (parsed.kind !== 'expense') return say('Укажите назначение и сумму. Например, /add такси 2500 ₸.');
        return expenseReply(parsed, put(state, key, at, parsed, argument), key);
      }
      case 'fix': case 'skip': {
        const [, id, correction] = /^(\d+)(?:\s+([\s\S]+))?$/u.exec(argument) ?? [];
        const [target, previous] = Object.entries(state.records).find(([, record]) => record.id === Number(id)) ?? [];
        if (!previous) return say('Запись с таким номером не найдена.');
        if (cmd[1].toLowerCase() === 'skip') {
          put(state, target, previous.at, { kind: 'ignore' }, '');
          return say(`Запись #${id} исключена из итогов.`);
        }
        const correctingIncome = previous.kind === 'income' || previous.flow === 'income';
        const correctingBalances = previous.kind === 'balances' || previous.flow === 'balances';
        const parsed = parseBalances(correction ?? '') ?? (correctingBalances ? { kind: 'pending' } : correctingIncome
          ? parseIncome(correction ?? '', true, previous.inflow?.title ?? previous.text)
          : parseIncome(correction ?? '') ?? parseExpense(correction ?? '', true));
        if (!['expense', 'income', 'balances'].includes(parsed.kind)) {
          const example = correctingBalances ? 'отложено на отпуск 150000' : correctingIncome ? '350000 зарплата' : 'такси 2500 ₸';
          return say(`Формат исправления — /fix ${id} ${example}.`);
        }
        const record = put(state, target, previous.at, parsed, correction, owner);
        const reply = expenseReply(parsed, record, target);
        return { ...reply, text: `Исправил запись.\n${reply.text}` };
      }
      default: return;
    }
  }
  const replyId = replay ? undefined : message.reply_to_message?.message_id;
  const referencedKey = state.prompts[replyId] ?? `tg:${replyId}`;
  const referred = state.records[referencedKey];
  if (text && !update.edited_message && (referred?.kind === 'pending' || (state.prompts[replyId] && needsCategory(referred)))) {
    if (state.records[key]) return;
    let parsed;
    if (needsCategory(referred)) {
      const [original] = referred.items;
      const namedCategory = findCategory(text);
      if (namedCategory && namedCategory !== original.category) {
        parsed = { kind: 'expense', items: [{ ...original, category: namedCategory, title: namedCategory }] };
      } else {
        const decimal = (original.minor / 100).toFixed(2);
        const input = `${text} ${decimal} ${original.currency}`;
        const local = parseExpense(input, true);
        parsed = local.kind === 'expense' && local.items[0].category !== 'Другое' ? local : await classify(input, config);
        if (parsed.kind !== 'expense' || parsed.items.length !== 1 || parsed.items[0].minor !== original.minor || parsed.items[0].currency !== original.currency || parsed.items[0].category === original.category) {
          return { text: `Укажите назначение без суммы, например «такси», или название категории из /categories. Для исправления суммы — /fix ${referred.id}.`, prompt: referencedKey };
        }
      }
    } else if (referred.flow === 'image') {
      if (/^(?:да|верно|подтверждаю|запиши)[.!]?$/iu.test(text)) parsed = referred.draft;
      else if (/^(?:нет|отмена|отмени)[.!]?$/iu.test(text)) parsed = { kind: 'ignore' };
      else {
        parsed = parseBalances(text) ?? parseIncome(text) ?? (referred.draft.kind === 'expense' ? parseExpense(text, true) : null);
        if (!parsed || !['expense', 'income', 'balances'].includes(parsed.kind)) {
          return { text: 'Ответьте «да» или «нет». Для исправления можно ввести запись целиком, например «такси 2500» или «сейчас всего 450000».', prompt: referencedKey };
        }
      }
    } else if (referred.flow === 'balances') {
      const completed = parseAmount(text, true) ? parseBalances(`${referred.text} ${text}`) : null;
      parsed = parseBalances(text) ?? completed ?? { kind: 'pending', flow: 'balances' };
    } else if (referred.flow === 'income') {
      parsed = parseIncome(text, true, referred.text);
    } else {
      const explicit = parseExpense(text, true);
      parsed = explicit.kind === 'expense' ? explicit : await classify(referred.text, config, text);
    }
    put(state, key, at, { kind: 'ignore' }, '');
    if (parsed.kind === 'ignore') {
      put(state, referencedKey, referred.at, parsed, '');
      return say(`Запись #${referred.id} исключена из итогов.`);
    }
    const record = put(state, referencedKey, referred.at, parsed, [referred.text, text].filter(Boolean).join('\n').slice(-4000));
    return expenseReply(parsed, record, referencedKey);
  }
  const previous = state.records[key];
  if (replay && previous && !['pending', 'ignore'].includes(previous.kind)) return say(`Это сообщение уже учтено в записи #${previous.id}.`);
  if (previous && !update.edited_message && !replay) return;
  const attachment = screenshotAttachment(message, text);
  if (attachment && update.edited_message) return;
  if (attachment) {
    if (!config.readScreenshot) return say('Чтение изображений требует настроенного Gemini. Пока сумму можно указать в подписи.');
    let draft;
    try {
      draft = await config.readScreenshot(attachment, text);
    } catch (error) {
      if (error instanceof ScreenshotError) return say(error.message);
      console.error(error instanceof GeminiError ? error.message : 'Чтение изображения не удалось.');
      return say('Сейчас прочитать изображение не получилось. Отправьте скриншот ещё раз или напишите сумму в подписи.');
    }
    if (!draft) return say('Не удалось однозначно прочитать сумму. Пришлите фрагмент с одной операцией или укажите сумму в подписи.');
    const parsed = { kind: 'pending', flow: 'image', draft };
    const record = put(state, key, at, parsed, `Скриншот · ${screenshotPreview(draft)}`, owner);
    return expenseReply(parsed, record, key);
  }
  if (!text) {
    if (previous && previous.kind !== 'ignore') {
      put(state, key, at, { kind: 'ignore' }, '');
      return say(`После правки запись #${previous.id} исключена из итогов.`);
    }
    return;
  }
  if (text.startsWith('/')) return;
  const replacement = previous?.kind === 'balances' && previous.balances.length === 1 ? parseAmount(text, true) : null;
  let parsed;
  if (replacement?.currency === 'KZT') parsed = { kind: 'balances', balances: [{ ...previous.balances[0], ...replacement }] };
  else if (previous?.kind === 'income' && parseAmount(text)) parsed = parseIncome(text, true, previous.inflow.title);
  else parsed = await classify(text, config);
  if (parsed.kind === 'ignore' && !previous) return;
  const record = put(state, key, at, parsed, text, owner);
  if (parsed.kind === 'ignore' && ['expense', 'income', 'balances'].includes(previous.kind)) return say(`После правки запись #${record.id} исключена из итогов.`);
  return expenseReply(parsed, record, key);
}

export async function importHistory(state, config, file, until, onBatch = async () => {}) {
  const history = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
  if (!Array.isArray(history.messages) || !Number.isSafeInteger(history.id)) throw new Error('Нужен JSON-экспорт одного чата из Telegram Desktop.');
  const chatId = Number(config.chat);
  const isSupergroup = history.type === 'private_supergroup' || history.type === 'public_supergroup';
  const sameSupergroup = isSupergroup && chatId < -1_000_000_000_000 && (chatId === history.id || chatId === -1_000_000_000_000 - history.id);
  const botId = config.telegramToken?.split(':')[0];
  if (!sameSupergroup && !until) throw new Error('Для архива с отдельными идентификаторами укажите --before и время первого сообщения, обработанного ботом.');
  const cutoff = until ? Date.parse(until) : Infinity;
  if (Number.isNaN(cutoff)) throw new Error('Укажите --before в ISO-формате со смещением, например 2026-11-15T13:00:00+05:00.');
  const counts = { scanned: 0, expenses: 0, pending: 0, duplicate: 0, skipped: 0 };
  const queued = [];
  const seen = new Set();
  const batchSize = config.gemini ? 25 : 500;
  let lastGeminiRequest = 0;
  const commit = async () => {
    if (!queued.length) return;
    const local = queued.map(row => localEntry(row.text));
    const remaining = queued.filter((_, index) => !local[index]);
    let classified = [];
    if (config.gemini && remaining.length) {
      const delay = 7_000 - (Date.now() - lastGeminiRequest);
      if (delay > 0) await sleep(delay);
      lastGeminiRequest = Date.now();
      classified = await config.gemini.classify(remaining);
    } else {
      classified = remaining.map(row => parseExpense(row.text));
    }
    let next = 0;
    for (const [index, row] of queued.entries()) {
      const parsed = local[index] ?? classified[next++];
      put(state, row.key, row.at, parsed, row.text);
      if (parsed.kind === 'expense') counts.expenses += parsed.items.length;
      if (parsed.kind === 'pending') counts.pending++;
    }
    queued.length = 0;
    await onBatch();
  };
  for (const row of history.messages) {
    counts.scanned++;
    const at = row.date_unixtime ? Number(row.date_unixtime) * 1_000 : Date.parse(row.date);
    const text = typeof row.text === 'string' ? row.text : Array.isArray(row.text) ? row.text.map(part => typeof part === 'string' ? part : part?.text ?? '').join('') : '';
    if (row.type !== 'message' || (botId && row.from_id === `user${botId}`) || !Number.isSafeInteger(row.id) || !Number.isFinite(at) || at >= cutoff || !text.trim() || text.trimStart().startsWith('/')) {
      counts.skipped++;
      continue;
    }
    const key = sameSupergroup ? `tg:${row.id}` : `history:${history.id}:${row.id}`;
    if (state.records[key] || seen.has(key)) {
      counts.duplicate++;
      continue;
    }
    seen.add(key);
    queued.push({ key, at, text });
    if (queued.length >= batchSize) await commit();
  }
  await commit();
  return counts;
}

async function discover(tg) {
  console.log('Напишите /id в группе с ботом. Если нужно, укажите /id@имя_бота.');
  let offset;
  while (true) {
    const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 35_000);
    for (const { update_id, message } of updates) {
      if (['group', 'supergroup'].includes(message?.chat?.type) && /^\/id(?:@\w+)?(?:\s|$)/iu.test(message.text ?? '')) {
        console.log(`TELEGRAM_CHAT_ID=${message.chat.id}`);
        return;
      }
      offset = update_id + 1;
    }
  }
}

async function enroll(config, tg) {
  const code = await optionalFile(resolve(project, '0. opt/enrollment_code.txt'));
  if (!/^[a-f0-9]{24}$/u.test(code)) throw new Error('Не найден код подключения в 0. opt/enrollment_code.txt.');
  const bot = await tg('getMe', {});
  const webhook = await tg('getWebhookInfo', {});
  if (webhook.url) throw new Error('Сначала отключите webhook этого бота.');
  console.log(`@${bot.username} ожидает первую привязку группы через /setup.`);
  let offset;
  while (true) {
    const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message'] }, 35_000);
    for (const { update_id, message } of updates) {
      offset = update_id + 1;
      if (!['group', 'supergroup'].includes(message?.chat?.type) || message.from?.is_bot) continue;
      const [, name, supplied] = /^\/setup(?:@(\w+))?\s+([a-f0-9]{24})$/iu.exec(message.text?.trim() ?? '') ?? [];
      if (supplied !== code || (name && name.toLowerCase() !== bot.username.toLowerCase())) continue;
      config.chat = String(message.chat.id);
      await writeFile(config.chatFile, `${config.chat}\n`, { flag: 'wx', mode: 0o600 });
      console.log('Группа подключена.');
      await tg('sendMessage', {
        chat_id: config.chat, message_thread_id: message.is_topic_message ? message.message_thread_id : undefined,
        text: 'Группа подключена. Напишите /help или первую трату, например «такси 2500».',
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      }).catch(error => console.error(error.message));
      return;
    }
    if (!updates.length) offset = undefined;
  }
}

async function flush(state, config, tg) {
  if (!state.outbox) return;
  const { text, prompt, messageId, thread } = state.outbox;
  try {
    const sent = await tg('sendMessage', {
      chat_id: config.chat, message_thread_id: thread,
      text: text.length > 3900 ? `${text.slice(0, 3890)}…` : text,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
      reply_markup: prompt ? { force_reply: true, selective: true } : menuKeyboard,
      link_preview_options: { is_disabled: true },
    });
    if (prompt && (state.records[prompt]?.kind === 'pending' || needsCategory(state.records[prompt]))) state.prompts[sent.message_id] = prompt;
  } catch (error) {
    if (![400, 403].includes(error.status)) throw error;
    console.error(error.message, 'Запись сохранена, ответ в чат не доставлен.');
  }
  delete state.outbox;
  await saveState(config.database, state);
}

async function run(state, config, tg) {
  if (config.gemini) config.readScreenshot = async (attachment, caption) => {
    const image = await downloadScreenshot(config.telegramToken, attachment, tg);
    return screenshotDraft(await config.gemini.readScreenshot(image, caption), caption);
  };
  const bot = await tg('getMe', {});
  if (!bot.can_read_all_group_messages) console.log('Для обычных сообщений отключите Group Privacy в BotFather и заново добавьте бота в группу, либо добавьте его как администратора.');
  const webhook = await tg('getWebhookInfo', {});
  if (webhook.url) throw new Error('У бота уже настроен webhook. Для этой версии создайте отдельного бота или отключите его webhook.');
  console.log(`«Финансовый управляющий» запущен. ${config.gemini ? 'Gemini подключён в конфигурации.' : 'Включён локальный разбор.'}`);
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let offset;
  try {
    while (!stopping) {
      try {
        await flush(state, config, tg);
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'edited_message'] }, 35_000);
        for (const update of updates) {
          if (stopping) break;
          if (state.lastUpdate !== update.update_id) {
            // Commit changes and the outgoing reply together before confirming the update.
            const next = structuredClone(state);
            const reply = await handleUpdate(next, config, update, bot);
            const source = update.message ?? update.edited_message;
            next.lastUpdate = update.update_id;
            if (reply) next.outbox = { ...reply, messageId: source.message_id, thread: source.is_topic_message ? source.message_thread_id : undefined };
            await saveState(config.database, next);
            state = next;
            await flush(state, config, tg);
          }
          offset = update.update_id + 1;
        }
        if (!updates.length) offset = undefined;
      } catch (error) {
        if ([401, 409].includes(error.status)) throw error;
        console.error(error.message);
        await sleep(Math.max(2, Math.min(error.retryAfter ?? 0, 60)) * 1_000);
      }
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

async function main() {
  const [mode = 'run', file, flag, before] = process.argv.slice(2);
  if (!['run', 'serve', 'discover', 'check', 'import', 'summary'].includes(mode)) throw new Error('Доступные действия: run, serve, discover, check, import, summary.');
  const config = await settings(process.env, mode);
  if (mode === 'discover') return discover(api(config.telegramToken));
  if (mode === 'check') {
    const bot = await api(config.telegramToken)('getMe', {});
    console.log(`Telegram: @${bot.username}, чтение всех сообщений разрешено в BotFather: ${Boolean(bot.can_read_all_group_messages)}.`);
    if (!config.gemini) return console.log('Gemini: включён локальный режим.');
    const [result] = await config.gemini.classify([{ text: 'Такси 2500 тг' }]);
    if (result.kind !== 'expense' || result.items[0]?.minor !== 250_000 || result.items[0]?.currency !== 'KZT') throw new Error('Gemini не распознал тестовый расход.');
    return console.log('Gemini: подтверждено распознавание тестового расхода 2 500 ₸.');
  }
  if (mode === 'summary') return console.log(summarize(await openState(config.database, config.chat), 'all', config.timezone));
  await mkdir(dirname(config.database), { recursive: true });
  const lock = `${config.database}.lock`;
  const managedLock = process.env.LEDGER_LOCK_MANAGED === '1';
  if (!managedLock) {
    try {
      await mkdir(lock);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('Учёт уже открыт. Остановите бот перед импортом. При аварийном завершении см. README.');
      throw error;
    }
  }
  try {
    if (mode === 'serve' && !config.chat) await enroll(config, api(config.telegramToken));
    const state = await openState(config.database, config.chat);
    if (mode === 'run' || mode === 'serve') return await run(state, config, api(config.telegramToken));
    if (!file || (flag && (flag !== '--before' || !before))) throw new Error('Используйте import result.json [--before дата-время].');
    let batches = 0;
    const counts = await importHistory(state, config, file, before, async () => {
      await saveState(config.database, state);
      if (++batches % 10 === 0) console.log(`Обработано пакетов: ${batches}`);
    });
    console.log(`Просмотрено сообщений: ${counts.scanned}. Новых расходов: ${counts.expenses}. Ждут уточнения: ${counts.pending}. Уже обработано: ${counts.duplicate}. Пропущено по формату или дате: ${counts.skipped}.`);
    console.log(summarize(state, 'all', config.timezone));
  } finally {
    if (!managedLock) await rmdir(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
