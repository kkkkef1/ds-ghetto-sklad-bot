// ===================== РАЗБОР СТРОК ЛОГА =====================
//
// Нас интересуют четыре вида строк («Действие» в логах фракции):
//   Повышает / Понижает Ник[ID] с … до … с причиной "…"
//   Увольняет Ник[ID] с причиной "…".          («Увольняется по собственному желанию» — без причины, не берём)
//   Устанавливает Имя Фамилия отдел …          (после слова «отдел» идёт название отдела — его и проверяем)
//   Входит на территорию войны за …            (ПВП-мероприятие)

import type { LogRow } from "../warehouse/logsPage.js";

export type ReasonKind = "promotion" | "demotion" | "dismissal" | "department";

export interface ReasonEvent {
  kind: ReasonKind;
  /** Текст причины (для отдела — название отдела). */
  reason: string;
  row: LogRow;
}

export interface PvpEntry {
  /** «война за ресурсы» */
  event: string;
  characterId: string;
  row: LogRow;
}

const ACTION_RE = /^(Повышает|Понижает|Увольняет)\s/iu;
// Причина в кавычках после «с причиной»; закрывающая кавычка и точка в конце необязательны.
const REASON_RE = /\sс причиной\s+["«“”„](.*?)["»“”]?\s*\.?\s*$/isu;
const DEPARTMENT_RE = /^Устанавливает\s+(.+?)\s+отдел\s+(.*?)\s*\.?\s*$/isu;
const PVP_RE = /^Входит на территорию войны за\s+(.+?)\s*\.?\s*$/iu;

const KIND_BY_WORD: Record<string, ReasonKind> = { повышает: "promotion", понижает: "demotion", увольняет: "dismissal" };

export function parseRow(row: LogRow): { reason?: ReasonEvent; pvp?: PvpEntry } {
  const text = row.text.replace(/\s+/g, " ").trim();

  const action = text.match(ACTION_RE);
  if (action) {
    const reason = text.match(REASON_RE);
    if (!reason) return {}; // например, увольнение без причины
    return { reason: { kind: KIND_BY_WORD[action[1].toLowerCase()], reason: reason[1].trim(), row } };
  }

  const dept = text.match(DEPARTMENT_RE);
  if (dept) {
    const name = dept[2].trim();
    return name ? { reason: { kind: "department", reason: name, row } } : {};
  }

  const pvp = text.match(PVP_RE);
  if (pvp) return { pvp: { event: `война за ${pvp[1].trim().toLowerCase()}`, characterId: row.characterId || row.character, row } };

  return {};
}
