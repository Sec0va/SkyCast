# Weather Multi Source Dashboard

Панель погоды, которая собирает данные из нескольких источников и отдает их через веб-интерфейс и API.

## Требования

- Node.js `>=18` (рекомендуется Node.js 20)
- npm

## Локальный запуск

```bash
npm install
npm start
```

Приложение поднимается на `http://localhost:3000` (или на порту из `PORT`).

## Переменные окружения

Можно оставить значения по умолчанию из `.env.example`:

- `PORT=3000`
- `UPDATE_INTERVAL_MS=30000`
- `STALE_AFTER_MS=25000`
- `FETCH_TIMEOUT_MS=12000`
- `RATE_WINDOW_MS=60000`
- `RATE_LIMIT_API=90`
- `RATE_LIMIT_REFRESH=30`
- `RATE_LIMIT_STREAM=45`

## Маршруты

- `GET /` - интерфейс
- `GET /health` - healthcheck для Railway
- `GET /api/weather?city=Москва` - получить снимок погоды (если `city` не передан, по умолчанию `Москва`)
- `POST /api/refresh?city=Москва` - принудительно обновить данные
- `GET /api/stream?city=Москва` - SSE-поток обновлений

## Деплой на Railway (через GitHub)

1. Запушь проект в GitHub.
2. В Railway создай новый сервис: `New` -> `Deploy from GitHub repo` -> выбери репозиторий.
3. Дождись первого деплоя.
4. Открой `Settings` -> `Networking` -> `Public Networking` -> `Generate Domain`, чтобы получить публичный URL.
5. Проверь:
   - `<твой-домен>/health` должен вернуть `200`
   - `<твой-домен>/` должен открыть UI

## Важно по текущему репозиторию

- В проекте есть `Dockerfile`. Railway обычно использует его автоматически, если он найден в корне.
- Файл `railway.json` уже настроен:
  - `startCommand`: `npm start`
  - `healthcheckPath`: `/health`
  - `healthcheckTimeout`: `120`
- Если меняешь переменные в Railway, изменения применяются после подтверждения staged changes и нового деплоя.

## Частые проблемы на Railway

- Деплой падает на healthcheck: проверь, что приложение слушает `process.env.PORT` (в этом проекте уже так сделано).
- Нет публичной ссылки: нужно отдельно нажать `Generate Domain` в `Public Networking`.
- Слишком много запросов к API: увеличь `RATE_LIMIT_*` или `RATE_WINDOW_MS`.

## Полезные ссылки Railway

- Services: https://docs.railway.com/services
- Variables: https://docs.railway.com/variables
- Healthchecks: https://docs.railway.com/deployments/healthchecks
- Domains: https://docs.railway.com/networking/domains
