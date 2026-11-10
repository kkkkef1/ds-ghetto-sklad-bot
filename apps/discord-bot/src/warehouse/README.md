# warehouse — проверка склада/машин фракций (прототип входа)

Сейчас готов только **вход на сайт и чтение одной страницы логов**. Подсчёт
нарушителей, команды настройки и расписание — следующие шаги.

## Файлы

| Файл | Что делает |
|---|---|
| `siteSession.ts` | Браузер (Playwright). Проходит: логин → код 2FA → «Админ вход» → подсеть / проверка безопасности → логи. Сам определяет, какое окно открыто. |
| `logsPage.ts` | Выставляет фильтры, жмёт «Поиск», читает таблицу `#logs_table`. |
| `io.ts`, `discordIO.ts` | Связь с вами: сообщения в личку Discord (код 2FA приходит ответом) или консоль. |
| `config.ts` | Настройки из `.env`. |
| `prototype.ts` | Запуск: `pnpm --filter @workspace/discord-bot run wh-proto`. |

## Запуск на VPS (схема деплоя через GitHub, /opt/bots/sklad-bot, пользователь bots)

1. На ПК: скопировать изменения в свой клон репозитория, выполнить `pnpm install`
   (обновит `pnpm-lock.yaml` — без этого `deploy.sh` с `--frozen-lockfile` упадёт),
   закоммитить всё, включая `pnpm-lock.yaml`, и отправить на GitHub.
2. На сервере: `sudo -u bots /opt/bots/sklad-bot/deploy/deploy.sh`.
3. Один раз поставить браузер (в общую папку, чтобы его видели и ручной запуск, и systemd):
   ```bash
   sudo mkdir -p /opt/bots/browsers && sudo chown bots:bots /opt/bots/browsers
   cd /opt/bots/sklad-bot/apps/discord-bot
   sudo -u bots env PLAYWRIGHT_BROWSERS_PATH=/opt/bots/browsers pnpm exec playwright install chromium
   sudo env PLAYWRIGHT_BROWSERS_PATH=/opt/bots/browsers pnpm exec playwright install-deps chromium
   ```
4. Добавить в `/opt/bots/sklad-bot/apps/discord-bot/.env` переменные `GTA_*`, `WH_OWNER_ID`
   (см. `.env.example`) и `PLAYWRIGHT_BROWSERS_PATH=/opt/bots/browsers`.
5. Запуск прототипа:
   ```bash
   cd /opt/bots/sklad-bot
   sudo -u bots pnpm --filter @workspace/discord-bot run wh-proto
   ```

Память: на 1 ГБ включите swap (2 ГБ) — Chromium иногда съедает 400–600 МБ.

## Правила безопасности, заложенные в код

- Каждое действие входа пробуется не более 2 раз (защита от блокировки паролем).
- Кнопка «Отключить Google Auth» никогда не нажимается.
- Cloudflare и капчи не обходятся: при проблеме бот присылает скриншот и останавливается.
- Профиль браузера (`data/browser-profile`) содержит сессию — храните как пароль, не копируйте в git.
