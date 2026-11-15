import { findCategory, money, normalizeBalanceAmounts, parseAmount, parseBalances, sourceAmounts } from './ledger.mjs';

const maxImageBytes = 8 * 1024 * 1024;
const imageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function screenshotAttachment(message, caption) {
  const tagged = /^(?:скрин(?:шот)?|чек|прочитай|баланс|остаток)(?=$|[\s:])/iu.test(caption);
  const heading = /^(?:скрин(?:шот)?|чек|прочитай|баланс|остаток)\s*:?$/iu.test(caption.split(/\r?\n/u)[0]);
  if (caption && (!tagged || (!heading && sourceAmounts(caption).length))) return null;
  const photo = message.photo?.at(-1);
  if (photo) return photo;
  const file = message.document;
  return file && (imageTypes.has(file.mime_type) || /\.(?:png|jpe?g|webp)$/iu.test(file.file_name ?? '')) ? file : null;
}

export class ScreenshotError extends Error {}

function imageType(data) {
  if (data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new ScreenshotError('Отправьте изображение в формате PNG, JPG или WebP.');
}

export async function downloadScreenshot(token, attachment, telegram, request = fetch) {
  const tooLarge = 'Изображение больше 8 МБ. Отправьте его как фото или обрежьте нужный фрагмент.';
  if (attachment.file_size > maxImageBytes) throw new ScreenshotError(tooLarge);
  const file = await telegram('getFile', { file_id: attachment.file_id });
  if (file.file_size > maxImageBytes) throw new ScreenshotError(tooLarge);
  if (typeof file.file_path !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/u.test(file.file_path) || file.file_path.split('/').some(part => part === '.' || part === '..')) {
    throw new ScreenshotError('Telegram не предоставил файл изображения. Отправьте его ещё раз.');
  }
  const response = await request(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal: AbortSignal.timeout(12_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new ScreenshotError('Telegram не отдал изображение. Отправьте его ещё раз.');
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxImageBytes) throw new ScreenshotError(tooLarge);
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, length);
  return { data: data.toString('base64'), mimeType: imageType(data) };
}

const safeTitle = value => typeof value === 'string' && !/\d{4,}|@|https?:|\p{C}/iu.test(value)
  ? value.trim().replace(/\s+/gu, ' ').slice(0, 80) : '';

function captionBalances(caption) {
  const balances = [];
  for (const line of normalizeBalanceAmounts(caption).split(/\r?\n/u).slice(1)) {
    const [, value, account] = /^\s*(?:и\s+)?(.+?)\s+на\s+([^\d]{1,80})\s*$/iu.exec(line) ?? [];
    const amount = value && parseAmount(value, true);
    const title = safeTitle(account);
    if (amount?.currency === 'KZT' && title) balances.push({ ...amount, name: `account:${title.toLowerCase()}`, title });
  }
  return balances;
}

export function screenshotDraft(result, caption = '') {
  const supplemental = captionBalances(caption);
  if (!result || !Array.isArray(result.rows) || !result.rows.length || result.rows.length > 12) {
    return supplemental.length ? { kind: 'balances', balances: supplemental, unread: true } : null;
  }
  if (result.kind === 'balances') {
    const account = !supplemental.length && result.rows.length === 1 && result.rows[0]?.type === 'account';
    const lines = [];
    for (const row of result.rows) {
      if (!row || !['total', 'fund', 'account'].includes(row.type) || typeof row.amount !== 'string') return null;
      const amount = normalizeBalanceAmounts(row.amount).trim();
      if (parseAmount(amount, true)?.currency !== 'KZT') return null;
      const title = safeTitle(row.title).replace(/^на\s+/iu, '');
      if (row.type !== 'total' && !account && !title) return null;
      if (row.type === 'total' || account) lines.push(`сейчас всего ${amount}`);
      else if (row.type === 'fund') lines.push(`отложено на ${title} ${amount}`);
      else lines.push(`на счёте ${title} ${amount}`);
    }
    const parsed = parseBalances(lines.join('\n'));
    if (parsed?.kind !== 'balances') return null;
    const entries = new Map([...parsed.balances, ...supplemental].map(row => [row.name, row]));
    return { ...parsed, balances: [...entries.values()], account };
  }
  if (!['expense', 'income'].includes(result.kind) || result.rows.length !== 1) return null;
  const [row] = result.rows;
  if (!row || row.type !== 'transaction' || typeof row.amount !== 'string') return null;
  const amount = parseAmount(normalizeBalanceAmounts(row.amount).trim().replace(result.kind === 'expense' ? /^[-−]\s*/u : /^\+\s*/u, ''));
  if (!amount) return null;
  const title = safeTitle(row.title) || (result.kind === 'income' ? 'Поступление' : 'Покупка');
  if (result.kind === 'income') return { kind: 'income', inflow: { ...amount, title } };
  return { kind: 'expense', items: [{ ...amount, title, category: findCategory(typeof row.category === 'string' ? row.category : '') ?? 'Другое' }] };
}

export function screenshotPreview(draft) {
  if (draft.kind === 'balances') {
    if (draft.account) return `Баланс на скриншоте — ${money(draft.balances[0].minor, draft.balances[0].currency)}. Записать его как общий остаток?`;
    const entries = draft.balances.map(row => `${row.name === 'total' ? 'Общий остаток, включая цели' : row.name.startsWith('account:') ? `Остаток · ${row.title}` : `Отложено на ${row.title}`} — ${money(row.minor, row.currency)}`);
    if (draft.unread) entries.unshift('Изображение не разобрал. Из подписи:');
    return entries.join('\n');
  }
  const row = draft.inflow ?? draft.items[0];
  const title = draft.kind === 'income' ? 'Поступление' : 'Расход';
  return `${title} — ${money(row.minor, row.currency)} · ${row.title}${row.category ? ` · ${row.category}` : ''}`;
}
