# sliv-bot

Discord-бот для GTA5 RP-сервера (gta5rp.com). Ведёт учёт нарушений во фракциях и каптов, помогает
с собраниями и мероприятиями.

## Что умеет

| Модуль | Что делает | Команды |
|---|---|---|
| **Склад** (`warehouse`) | Сам заходит на сайт по расписанию, читает логи фракций и присылает в канал тех, кто взял со склада, из машин и из наборов слишком много | `/sklad …` |
| **Твинки** (`twink`) | По средам и воскресеньям к 09:00 МСК проверяет твинков во фракциях и выдаёт готовые строки `offwarn` | `/twink …` |
| **Слив склада** | По загруженным логам находит несовпадение «взял / положил» и формирует отчёт с наказанием | `/sliv`, `/stopsliv` |
| **Капты** (`capt-tracker`) | Ведёт дневные счётчики атак и защит, подсвечивает превышение лимита | `/capt …` |
| **МП и собрания** | Анонс, отметки «буду / не буду», проверка присутствия старшим, итоги | `/mp …`, `/snew`, `/meeting …` |
| **Публикация** | Сообщение от имени бота в любой канал | `/announce` |

Склад и твинки работают с сайта **одним аккаунтом**, поэтому заходят по очереди: кто начал, тот доделывает,
второй ждёт. Код Google Authenticator нужен один раз.

Подробности по модулям:

- [Склад](apps/discord-bot/src/warehouse/README.md) — правила, лимиты, вид отчёта, все команды `/sklad`
- [Твинки](apps/discord-bot/src/twink/README.md) — расписание, сбои, команды `/twink`
- [Бот целиком](apps/discord-bot/README.md) — Discord-приложение, права, капты, МП, доступ к командам
- [Деплой](deploy/README.md) — как устроен сервис на сервере

## Структура

```
apps/discord-bot/    сам бот (discord.js): команды, склад, твинки, капты, МП
lib/log-analyzer/    анализ логов для /sliv, без зависимости от Discord
deploy/              deploy.sh и systemd-юнит
```

pnpm-монорепо. Данные бота (настройки, сессия браузера) лежат в `apps/discord-bot/data/` и в git не попадают.

## Первая установка

```bash
pnpm install
cp apps/discord-bot/.env.example apps/discord-bot/.env     # заполнить, см. ниже
pnpm --filter @workspace/discord-bot run deploy-commands   # регистрация слэш-команд
pnpm --filter @workspace/discord-bot run dev               # запуск для проверки
```

Главное в `.env`:

| Переменная | Для чего |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` | Токен и ID Discord-приложения |
| `LOGS_CATEGORY_ID` | Категория, где `/sliv` создаёт каналы |
| `WH_OWNER_ID` | Ваш Discord ID: сюда в личку приходят запросы кода 2FA, ошибки и вопросы бота |
| `GTA_LOGIN`, `GTA_PASSWORD`, `GTA_ADMIN_PASSWORD` | Вход на сайт: общий аккаунт для склада и твинков |

Права бота и Message Content Intent описаны в [apps/discord-bot/README.md](apps/discord-bot/README.md).

После запуска в Discord:

1. `/sklad channel` и `/twink channel` — каналы для результатов.
2. `/sklad status` и `/twink status` — проверить расписание и настройки.

## Обновление

Схема: код на сервере в `/opt/bots/sklad-bot`, служба `discord-bot-sliv`, пользователь `bots`.

### 1. На ПК

1. Распакуйте новую версию поверх проекта с заменой файлов. `.env` и папку `apps/discord-bot/data` не удаляйте.
2. В корне проекта:
   ```bash
   pnpm install
   pnpm --filter @workspace/discord-bot run typecheck
   ```
   Ошибки на этом шаге нужно исправить до отправки на сервер.

### 2. На GitHub

```bash
git status          # новые файлы (Untracked) тоже должны попасть в коммит
git add -A
git commit -m "что изменилось"
git push
```

В списке `git status` не должно быть `.env` и `data/`: они в `.gitignore`. Если Git пишет `Untracked files`,
эти файлы нужно добавить (`git add -A`), иначе на сервер они не попадут.

### 3. На сервере

```bash
sudo -u bots /opt/bots/sklad-bot/deploy/deploy.sh
```

Скрипт сам делает `git pull`, `pnpm install`, сборку и перезапуск службы.

Если в обновлении добавились или изменились команды (новые подкоманды, поля), один раз зарегистрируйте их.
В Discord они появятся не сразу, до часа:

```bash
cd /opt/bots/sklad-bot && sudo -u bots pnpm --filter @workspace/discord-bot run deploy-commands
```

### 4. Проверить

- `/sklad status`: в строке «Сборка» должен быть новый номер (задаётся в `warehouse/runner.ts`, `BUILD_ID`).
  Старый номер значит, что обновление не дошло до сервера.
- Логи: `sudo journalctl -u discord-bot-sliv -n 50 --no-pager`

### Когда обновлять

- Не обновляйте за 3 часа до среды и воскресенья 09:00 МСК: в это время стартует проверка твинков.
- Перезапуск посреди проверки твинков безопасен, она продолжится с того же места. Проверку склада лучше не
  прерывать.
- Настройки в `data/*.json` менять не нужно, при первом запуске новой версии они обновляются сами.
- **Откат:** `git revert` последнего коммита, `git push`, затем снова `deploy.sh`.

## Разработка

```bash
pnpm --filter @workspace/log-analyzer run typecheck
pnpm --filter @workspace/discord-bot run typecheck
pnpm --filter @workspace/discord-bot run build      # esbuild → apps/discord-bot/dist/index.js
```

## Известные ограничения

- Активная сессия `/sliv` хранится в памяти: перезапуск посреди визарда её теряет (созданный канал остаётся).
- Список крайм-фракций для `/sliv` (`lib/log-analyzer/src/factions.ts`) содержит id конкретного сервера, при переносе
  на другой сервер его нужно заменить.
