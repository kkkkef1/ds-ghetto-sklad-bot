// ===================== ПРОВЕРКА ТВИНКОВ =====================
//
// Для каждой активной фракции бот открывает список участников, у каждого игрока нажимает «(ч)»,
// читает окно со списком его персонажей и проверяет сочетание фракций (правила — в rules.ts).
// Логика расширения «Twink Checker» перенесена без изменений; добавлено:
//   • пауза перед каждым нажатием (по умолчанию 5000 мс, не меньше 4000);
//   • не нажимать «(ч)» у тех, чьи ID уже встретились (отключается);
//   • капча / сброс сессии → пауза, сообщение владельцу, продолжение командой /twink resume;
//   • состояние сохраняется в файл: после перезапуска бота проверка идёт дальше с того же места;
//   • доступ к сайту через общую очередь со складом (siteLock.ts);
//   • сообщение о ходе проверки в канале результатов, обновляется раз в 10 минут.

import type { Client, TextBasedChannel } from "discord.js";
import type { Page } from "playwright";
import { loadSiteConfig } from "../warehouse/config.js";
import { ClientIO } from "../warehouse/discordIO.js";
import type { OperatorIO } from "../warehouse/io.js";
import { LoginError, SiteSession } from "../warehouse/siteSession.js";
import { withSiteLock } from "../warehouse/siteLock.js";
import { getFactions, KNOWN_FACTIONS } from "../warehouse/store.js";
import { askAboutUnknownFactions } from "./unknown.js";
import { buildGroup, judge, type CardFaction } from "./rules.js";
import { fmtDuration, hm, progressOf, renderProgress, renderResults } from "./report.js";
import { getRun, getSettings, linkFor, markDone, MIN_DELAY_MS, persist, setLastRun, setRun, type RunState } from "./store.js";

const MEMBER_SELECTOR = 'a.link_lock[onclick*="Mi.showMemberChars"]';

export const ownerId = (): string | null => process.env.WH_OWNER_ID?.trim() || null;

class BlockedError extends Error {}

// ---------- скрипты, выполняемые в странице ----------

/** Помечает кнопки «(ч)» атрибутом data-tw и возвращает их список. */
const COLLECT_SCRIPT = String.raw`(() => {
  var out = [];
  var n = 0;
  document.querySelectorAll('a.link_lock[onclick*="Mi.showMemberChars"]').forEach(function (el) {
    if ((el.textContent || '').trim() !== '(ч)') return;
    el.setAttribute('data-tw', String(n));
    var onclick = el.getAttribute('onclick') || '';
    var am = onclick.match(/showMemberChars\s*\(([^)]*)\)/);
    var args = am ? am[1].replace(/['"\s]/g, '') : '';
    var tr = el.closest('tr');
    var rowText = tr ? (tr.textContent || '').replace(/\s+/g, ' ').trim() : '';
    var rm = rowText.match(/\[(\d{3,9})\]/) || rowText.match(/ID:?\s*(\d{3,9})/i);
    out.push({ i: n, key: args || ('i' + n), rowId: rm ? rm[1] : '', onclick: n < 1 ? onclick.slice(0, 140) : '', row: n < 1 ? rowText.slice(0, 140) : '' });
    n++;
  });
  return out;
})()`;

const CLICK_SCRIPT = (i: number): string => `(() => {
  var el = document.querySelector('[data-tw="${i}"]');
  if (!el) return false;
  try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
  return true;
})()`;

/**
 * Читает карточки персонажей так же, как расширение: «ID: N» и строки «Фракция: …».
 * Учитываются только видимые карточки: у «реактивных» окон прошлые карточки могут оставаться в
 * странице скрытыми, и их нельзя принимать за данные текущего игрока.
 * Страница при этом НЕ изменяется (ничего не закрываем и не удаляем): сайт сам перерисовывает окно.
 */
const PARSE_SCRIPT = String.raw`(() => {
  function vis(e) { return e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; }
  var list = Array.prototype.filter.call(document.querySelectorAll('.modal .card'), vis);
  if (!list.length) list = Array.prototype.filter.call(document.querySelectorAll('.card'), vis);
  var pairs = [];
  var ids = [];
  var cards = 0;
  list.forEach(function (card) {
    cards++;
    var m = (card.textContent || '').match(/ID:\s*(\d+)/);
    var id = m ? m[1] : null;
    if (id) ids.push(id);
    card.querySelectorAll('.list-group-item').forEach(function (li) {
      var text = (li.textContent || '').trim();
      if (text.indexOf('Фракция:') !== -1) {
        var f = text.replace(/Фракция:|\(rank:\s*\d+\)/g, '').trim();
        if (f && id) pairs.push([f, id]);
      }
    });
  });
  return { pairs: pairs, ids: ids, cards: cards };
})()`;

/** Что сейчас в странице про окна: для диагностики, когда окно не открывается. */
const DIAG_SCRIPT = String.raw`(() => {
  var out = { url: location.href, cardsInPage: document.querySelectorAll('.card').length, modals: [] };
  document.querySelectorAll('.modal').forEach(function (m, i) {
    if (i >= 6) return;
    out.modals.push({ cls: m.className, shown: m.getClientRects().length > 0, cards: m.querySelectorAll('.card').length, text: (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) });
  });
  return out;
})()`;

interface Item {
  i: number;
  key: string;
  rowId: string;
  onclick: string;
  row: string;
}

interface Parsed {
  pairs: CardFaction[];
  ids: string[];
  cards: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- состояние выполнения ----------

let stopRequested = false;
/** Номер запуска: устаревшие (отменённые в очереди) задания узнают о себе по несовпадению. */
let launchSeq = 0;
const seenIds = new Set<string>();
/** Сверка «ID из строки списка найден среди ID в окне»: пока всё сходится, повторы можно пропускать. */
let idChecks = 0;
let idMatches = 0;
let skipWarned = false;
/** Сколько раз подряд окно не удалось прочитать. */
let unreadInRow = 0;
/** Три и более подряд — это не случайность, а поломка: проверка встаёт на паузу. */
const MAX_UNREAD_IN_ROW = 3;
/** Минимум ожидания окна: ответ сайта бывает медленнее 1,2 с, а без данных проверка бессмысленна. */
const MIN_WAIT_MODAL_MS = 4000;

export const isRunActive = (): boolean => getRun() !== null;

// ---------- сообщения ----------

async function channelOf(client: Client): Promise<TextBasedChannel | null> {
  const { channelId } = getSettings();
  if (!channelId) return null;
  const ch = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
  return ch && "send" in ch ? ch : null;
}

/** Последний отправленный текст: если он не изменился, сообщение не правим. */
let lastProgressText: string | null = null;

async function updateProgress(client: Client): Promise<void> {
  const run = getRun();
  if (!run) return;
  const channel = await channelOf(client);
  if (!channel) return;
  const content = renderProgress(run, Date.now());
  if (content === lastProgressText) return;
  lastProgressText = content;
  if (run.progressMessageId) {
    try {
      const msg = await channel.messages.fetch(run.progressMessageId);
      await msg.edit({ content, allowedMentions: { parse: [] } });
      return;
    } catch {
      // Сообщение удалили — пишем новое.
    }
  }
  try {
    const sent = await channel.send({ content, allowedMentions: { parse: [] } });
    run.progressMessageId = sent.id;
    persist();
  } catch (err) {
    console.error("[twink] Не удалось отправить сообщение о ходе проверки:", err);
  }
}

async function notifyOwner(client: Client, text: string): Promise<void> {
  const owner = ownerId();
  if (owner) await new ClientIO(client, owner).notify(text);
}

// ---------- запуск / остановка / продолжение ----------

export interface StartOptions {
  kind: "auto" | "manual";
  /** Ключ для расписания (дата публикации) — по нему запуск считается выполненным. */
  runId: string;
  publishAtMs?: number;
  startedBy?: string;
  /** Проверить только эти фракции (коды сайта), даже если их нет в общем списке со складом. */
  onlyFactions?: string[];
}

export function startRun(client: Client, opts: StartOptions): { ok: true } | { ok: false; reason: string } {
  if (getRun()) return { ok: false, reason: "Проверка твинков уже идёт или стоит на паузе (/twink status)." };
  if (!ownerId()) return { ok: false, reason: "Не задан WH_OWNER_ID в .env — боту некуда присылать запрос кода входа." };
  if (!getSettings().channelId) return { ok: false, reason: "Не задан канал для результатов (/twink channel)." };
  const factions = opts.onlyFactions?.length ? KNOWN_FACTIONS.filter((f) => opts.onlyFactions!.includes(f.code)) : getFactions();
  if (!factions.length) return { ok: false, reason: "Не выбрано ни одной фракции (/sklad faction add)." };
  const noLink = factions.filter((f) => !linkFor(f.code));
  if (noLink.length) return { ok: false, reason: `Нет ссылки на список участников для: ${noLink.map((f) => f.name).join(", ")} (/twink link).` };

  seenIds.clear();
  idChecks = 0;
  idMatches = 0;
  skipWarned = false;
  unreadInRow = 0;
  setRun({
    id: opts.runId,
    kind: opts.kind,
    startedAt: Date.now(),
    publishAtMs: opts.publishAtMs ?? null,
    status: "queued",
    pauseReason: null,
    factions: factions.map((f) => ({ code: f.code, name: f.name, total: null, done: [], finished: false })),
    seenIds: [],
    findings: [],
    clicked: 0,
    skipped: 0,
    unread: 0,
    workMs: 0,
    progressMessageId: null,
    startedBy: opts.startedBy ?? null,
  });
  launch(client);
  return { ok: true };
}

export function resumeRun(client: Client): { ok: true } | { ok: false; reason: string } {
  const run = getRun();
  if (!run) return { ok: false, reason: "Нет проверки, которую можно продолжить." };
  if (run.status !== "paused") return { ok: false, reason: "Проверка не на паузе — она уже идёт или ждёт очереди." };
  run.status = "queued";
  run.pauseReason = null;
  persist();
  launch(client);
  return { ok: true };
}

/** Остановка: найденное к этому моменту публикуется в канал. */
export async function stopRun(client: Client): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const run = getRun();
  if (!run) return { ok: false, reason: "Сейчас нет проверки твинков." };
  if (run.status === "running") {
    stopRequested = true;
    run.status = "stopping";
    persist();
    return { ok: true, text: "Останавливаю: доделаю текущего игрока и опубликую то, что найдено к этому моменту." };
  }
  // На паузе или в очереди браузер не работает — завершаем сразу.
  launchSeq++;
  await finish(client, run, "stopped");
  return { ok: true, text: "Проверка остановлена, найденное отправлено в канал." };
}

/** Вызывать один раз при старте бота: незавершённая проверка продолжается с того же места. */
export function resumeAfterRestart(client: Client): void {
  const run = getRun();
  if (!run) return;
  seenIds.clear();
  run.seenIds.forEach((id) => seenIds.add(id));
  if (run.status === "paused") return; // ждёт команды /twink resume
  console.log(`[twink] Бот перезапущен посреди проверки (${run.id}) — продолжаю с того же места.`);
  launch(client);
}

function launch(client: Client): void {
  const run = getRun();
  if (!run) return;
  const seq = ++launchSeq;
  void execute(client, run, seq).catch((err) => console.error("[twink] Сбой проверки:", err));
}

type Outcome = "done" | "paused" | "stopped" | "aborted";

async function execute(client: Client, run: RunState, seq: number): Promise<void> {
  stopRequested = run.status === "stopping";
  if (!stopRequested) run.status = "queued";
  persist();
  lastProgressText = null;
  await updateProgress(client);
  // Период обновления берётся из настроек при каждом круге, поэтому /twink options действует сразу.
  let ticking = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleTick = (): void => {
    timer = setTimeout(() => {
      void updateProgress(client)
        .catch(() => {})
        .finally(() => {
          if (ticking) scheduleTick();
        });
    }, Math.max(10, getSettings().progressSeconds) * 1000);
  };
  scheduleTick();
  let outcome: Outcome;
  try {
    outcome = await withSiteLock("твинки", () => work(client, run, seq));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[twink] Ошибка проверки:", err);
    await pause(client, run, `ошибка: ${reason}`);
    outcome = "aborted";
  } finally {
    ticking = false;
    if (timer) clearTimeout(timer);
  }
  if (outcome === "done" || outcome === "stopped") await finish(client, run, outcome);
}

async function pause(client: Client, run: RunState, reason: string): Promise<void> {
  run.status = "paused";
  run.pauseReason = reason;
  persist();
  const p = progressOf(run);
  await notifyOwner(
    client,
    `Проверка твинков приостановлена: ${reason}.\nВыполнено ${p.done} из ${p.total || "?"} (${p.percent}%). ` +
      "Решите вопрос на сайте и продолжите командой /twink resume — проверка пойдёт с того же места. Остановить и опубликовать найденное: /twink stop."
  );
  await updateProgress(client);
}

// ---------- сама работа ----------

async function work(client: Client, run: RunState, seq: number): Promise<Outcome> {
  if (seq !== launchSeq || getRun() !== run) return "aborted"; // отменили, пока ждали очередь
  if (stopRequested) return "stopped";
  run.status = "running";
  persist();
  await updateProgress(client);

  const owner = ownerId();
  if (!owner) throw new Error("не задан WH_OWNER_ID");
  const io = new ClientIO(client, owner);
  const cfg = loadSiteConfig();
  const session = await SiteSession.open(cfg, io);
  try {
    // 1. Считаем участников у каждой фракции — нужно для процентов и времени окончания.
    for (const f of run.factions) {
      if (f.finished || f.total !== null) continue;
      if (stopRequested) return "stopped";
      const page = await session.ensureMembersPage(linkFor(f.code)!, MEMBER_SELECTOR);
      f.total = (await collect(page)).length;
      persist();
    }
    await updateProgress(client);

    // 2. Проверяем по фракциям.
    let first = run.factions.every((f) => f.done.length === 0);
    for (const f of run.factions) {
      if (f.finished) continue;
      const page = await session.ensureMembersPage(linkFor(f.code)!, MEMBER_SELECTOR);
      const items = await collect(page);
      f.total = items.length;
      persist();
      if (first && items[0]) {
        first = false;
        await io.notify(
          `Проверка твинков началась. Участников у «${f.name}»: ${items.length}.\n` +
            `Пример строки для проверки разбора: onclick «${items[0].onclick}», ID в строке: ${items[0].rowId || "не найден"}, текст: «${items[0].row}».` +
            (getSettings().skipSeen && !items[0].rowId ? "\nID игрока в строке не распознан — повторы пропускаться не будут (проверка просто будет дольше)." : "")
        );
      }
      const done = new Set(f.done);
      for (const item of items) {
        if (done.has(item.key)) continue;
        if (stopRequested) return "stopped";
        const started = Date.now();
        const proceed = await processItem(session, page, f.name, item, io);
        if (!proceed) return "stopped";
        f.done.push(item.key);
        done.add(item.key);
        run.workMs += Date.now() - started;
        persist();
      }
      f.finished = true;
      persist();
      await updateProgress(client);
    }
    return "done";
  } catch (err) {
    if (err instanceof BlockedError) {
      await pause(client, run, err.message);
      return "aborted";
    }
    if (err instanceof LoginError) {
      await pause(client, run, `не удалось войти на сайт (${err.message})`);
      return "aborted";
    }
    throw err;
  } finally {
    await session.close();
  }
}

/** Кнопки «(ч)» на странице: ждём, пока список перестанет подгружаться. */
async function collect(page: Page): Promise<Item[]> {
  let items = await page.evaluate<Item[]>(COLLECT_SCRIPT);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(1000);
    const next = await page.evaluate<Item[]>(COLLECT_SCRIPT);
    const stable = next.length === items.length;
    items = next;
    if (stable) break;
  }
  // Ключи должны быть уникальными, иначе проценты и пропуск уже проверенных собьются.
  const used = new Map<string, number>();
  for (const it of items) {
    const n = used.get(it.key) ?? 0;
    used.set(it.key, n + 1);
    if (n > 0) it.key = `${it.key}#${n}`;
  }
  return items;
}

/** false — проверку остановили, не дожидаясь нажатия. */
async function processItem(session: SiteSession, page: Page, factionName: string, item: Item, io: OperatorIO): Promise<boolean> {
  const run = getRun()!;
  const settings = getSettings();

  // Этот игрок уже встречался в окне другого игрока (его ID был в списке персонажей) — не нажимаем.
  // Только после сверки: ID из строки должен совпадать с ID в окне (иначе мы не знаем, что это за число).
  const calibrated = idChecks >= 3 && idMatches === idChecks;
  if (settings.skipSeen && calibrated && item.rowId && seenIds.has(item.rowId)) {
    run.skipped++;
    return true;
  }

  // Пауза перед каждым нажатием. Короче MIN_DELAY_MS быть не может, случайная добавка — сверху.
  const pauseMs = Math.max(MIN_DELAY_MS, settings.delayMs) + Math.floor(Math.random() * (Math.max(0, settings.jitterMs) + 1));
  for (let waited = 0; waited < pauseMs; waited += 500) {
    if (stopRequested) return false;
    await sleep(Math.min(500, pauseMs - waited));
  }
  if (stopRequested) return false;

  // Окно НЕ закрываем и в странице ничего не удаляем (как расширение): сайт сам перерисует его для нового игрока.
  // Новые данные узнаём по тому, что набор ID в окне изменился.
  const waitMs = Math.max(MIN_WAIT_MODAL_MS, settings.waitModalMs);
  const before = await page.evaluate<Parsed>(PARSE_SCRIPT);
  const beforeSig = signature(before);
  let parsed: Parsed | null = null;
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    const clicked = await page.evaluate<boolean>(CLICK_SCRIPT(item.i));
    if (!clicked) {
      throw new BlockedError((await session.blockReason()) ?? "страница списка изменилась: кнопка «(ч)» не найдена (сессия сброшена или обновился сайт)");
    }
    if (attempt === 0) run.clicked++;
    parsed = await waitForNewCards(page, beforeSig, item.rowId, waitMs);
    if (!parsed) {
      const reason = await session.blockReason();
      if (reason) throw new BlockedError(reason);
    }
  }
  if (!parsed) {
    // Окно не прочиталось даже со второй попытки. Раньше это молча считалось «нарушений нет» — теперь учитываем.
    run.unread = (run.unread ?? 0) + 1;
    unreadInRow++;
    persist();
    if (unreadInRow >= MAX_UNREAD_IN_ROW) {
      await reportUnreadDiagnostics(session, page, io);
      run.unread = Math.max(0, (run.unread ?? 0) - 1); // этот игрок будет проверен заново после /twink resume
      run.clicked--;
      unreadInRow = 0;
      throw new BlockedError(`окно со списком персонажей не открывается после нажатия «(ч)» (${MAX_UNREAD_IN_ROW} раза подряд) — подробности и скриншот отправил в личку`);
    }
    return true;
  }
  unreadInRow = 0;

  if (item.rowId) {
    idChecks++;
    if (parsed.ids.includes(item.rowId)) idMatches++;
    else if (!skipWarned) {
      skipWarned = true;
      await io.notify(`Пропуск повторов отключён: ID из строки списка (${item.rowId}) не нашёлся в окне этого игрока (ID в окне: ${parsed.ids.join(", ") || "—"}). Проверка идёт без пропусков, просто дольше.`).catch(() => {});
    }
  }

  for (const id of parsed.ids) {
    if (!seenIds.has(id)) {
      seenIds.add(id);
      run.seenIds.push(id);
    }
  }

  const verdict = judge(parsed.pairs, settings.customFactions);
  if (verdict.unknown.length) {
    // Группа пропускается (как в расширении); владельцу уходит вопрос, куда отнести фракцию.
    await askAboutUnknownFactions(io, verdict.unknown).catch((err) => console.error("[twink] Вопрос про фракцию:", err));
    return true;
  }
  if (verdict.violation) {
    const group = buildGroup(parsed.pairs, settings.customFactions, settings.nickname);
    if (!run.findings.some((f) => f.groupKey === group.key)) {
      run.findings.push({ factionName, groupKey: group.key, header: group.header, offwarn: group.offwarn });
    }
  }
  return true;
}

function signature(p: Parsed): string {
  return [...p.ids].sort().join(",");
}

/**
 * Ждёт, пока в окне появятся данные НОВОГО игрока (набор ID изменился либо в нём есть ID из строки списка),
 * и ещё немного — пока содержимое перестанет перерисовываться. null — окно не появилось за timeoutMs.
 */
async function waitForNewCards(page: Page, beforeSig: string, rowId: string, timeoutMs: number): Promise<Parsed | null> {
  const deadline = Date.now() + timeoutMs;
  let last: Parsed | null = null;
  let lastSig = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(200);
    const now = await page.evaluate<Parsed>(PARSE_SCRIPT);
    if (!now.cards) continue;
    const sig = signature(now);
    if (!(sig !== beforeSig || (rowId && now.ids.includes(rowId)))) continue; // это ещё окно прошлого игрока
    if (sig !== lastSig) {
      last = now;
      lastSig = sig;
      stableSince = Date.now();
      continue;
    }
    if (Date.now() - stableSince >= 300) return last;
  }
  return last;
}

/** Когда окно не открывается: что сейчас в странице + скриншот — владельцу в личку. */
async function reportUnreadDiagnostics(session: SiteSession, page: Page, io: OperatorIO): Promise<void> {
  try {
    const info = await page.evaluate<unknown>(DIAG_SCRIPT);
    let shot: string | undefined;
    try {
      shot = `${loadSiteConfig().debugDir}/twink-nowindow-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
      await page.screenshot({ path: shot });
    } catch {
      shot = undefined;
    }
    const text = `Диагностика: после нажатия «(ч)» окно со списком персонажей не появилось.\n\`\`\`json\n${JSON.stringify(info, null, 1).slice(0, 1500)}\n\`\`\``;
    await io.notify(text, shot);
  } catch (err) {
    console.error("[twink] Диагностика окна не удалась:", err);
  }
  void session;
}

// ---------- завершение ----------

async function finish(client: Client, run: RunState, outcome: "done" | "stopped"): Promise<void> {
  const settings = getSettings();
  const channel = await channelOf(client);
  const p = progressOf(run);
  const names = run.factions.map((f) => f.name);
  const spent = fmtDuration(Date.now() - run.startedAt);

  const unread = run.unread ?? 0;
  // Если часть окон не прочиталась, «нарушений нет» было бы неправдой — честно говорим, что результат неполный.
  const incomplete = unread > 0;
  const bad = run.clicked > 0 && unread / run.clicked > 0.1;
  const head =
    outcome === "stopped"
      ? `⏹ **Проверка твинков остановлена** (проверено ${p.percent}%). Ниже — то, что найдено к этому моменту.`
      : bad
        ? "⚠️ **Проверка твинков завершена с ошибками чтения**"
        : "✅ **Проверка твинков завершена**";
  const perFaction = run.factions.map((f) => `• ${f.name}: ${run.findings.filter((x) => x.factionName === f.name).length}`).join("\n");
  const summary = [
    head,
    `Найдено групп с нарушением: **${run.findings.length}**`,
    perFaction,
    `Нажато «(ч)»: ${run.clicked}, пропущено повторов: ${run.skipped}. Время: ${spent}.`,
    incomplete ? `⚠️ Не удалось прочитать окно у ${unread} из ${run.clicked} игроков — по ним результат неизвестен.` : "",
    run.findings.length ? "" : incomplete ? "Среди прочитанных нарушений не найдено (результат неполный)." : "Нарушений не найдено.",
  ]
    .filter((l) => l !== "")
    .join("\n");
  const messages = renderResults(run.findings, names, settings.codeBlock);

  let delivered = false;
  if (channel) {
    try {
      let edited = false;
      if (run.progressMessageId) {
        edited = await channel.messages
          .fetch(run.progressMessageId)
          .then((m) => m.edit({ content: summary, allowedMentions: { parse: [] } }))
          .then(() => true)
          .catch(() => false);
      }
      if (!edited) await channel.send({ content: summary, allowedMentions: { parse: [] } });
      for (const content of messages) await channel.send({ content, allowedMentions: { parse: [] } });
      delivered = true;
    } catch (err) {
      console.error("[twink] Не удалось отправить результат в канал:", err);
    }
  }
  if (!delivered) {
    // Канал недоступен — результат не должен пропасть: отправляем владельцу в личку.
    await notifyOwner(client, `Канал для результатов твинков недоступен (/twink channel). Результат проверки:\n${summary}`);
    for (const content of messages) await notifyOwner(client, content);
  }

  setLastRun(`${outcome === "stopped" ? "остановлена" : "завершена"}, групп с нарушением: ${run.findings.length}, нажатий ${run.clicked}, пропущено ${run.skipped}${unread ? `, НЕ ПРОЧИТАНО ${unread}` : ""}, ${spent}`, run.kind);
  if (run.kind === "auto") markDone(run.id);
  stopRequested = false;
  seenIds.clear();
  setRun(null);
}

/** Текст для /twink status. */
export function describeRun(): string {
  const run = getRun();
  if (!run) return "Сейчас проверка не идёт.";
  const p = progressOf(run);
  const state = { queued: "ждёт очереди на сайте", running: "идёт", paused: `на паузе (${run.pauseReason ?? "причина не указана"})`, stopping: "останавливается" }[run.status];
  const lines = [
    `**Проверка:** ${state}, ${run.kind === "auto" ? "по расписанию" : "ручная"}, старт ${hm(run.startedAt)} МСК`,
    `**Прогресс:** ${p.percent}% (${p.done} из ${p.total || "?"}), нажато ${run.clicked}, пропущено повторов ${run.skipped}${run.unread ? `, не прочитано ${run.unread}` : ""}`,
    `**Найдено групп:** ${run.findings.length}`,
  ];
  if (run.status === "running" && p.etaMs !== null) lines.push(`**Примерное окончание:** ≈ ${hm(Date.now() + p.etaMs)} МСК`);
  return lines.join("\n");
}
