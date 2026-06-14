# ProSub

`ProSub` — небольшой reverse-proxy для публикации 3x-ui subscription через Render.

Проект нужен для ситуации, когда основная ссылка подписки через Cloudflare Tunnel может быть недоступна у части пользователей, например из-за проблем с доступом к Cloudflare у отдельных мобильных операторов.

`ProSub` отдаёт пользователю subscription URL через Render, но внутри самой подписки исправляет endpoint на настоящий VPN-домен.

## Целевая схема

```text
Пользователь
  ↓
https://prosub.onrender.com/prosub/<subId>
  ↓
Render Web Service
  ↓
https://203.0.113.10:51801/prosub/<subId>
  ↓
Router / Firewall / NAT
  ↓
10.0.0.10:51801
  ↓
3x-ui subscription
```

При этом VPN endpoint внутри подписки должен быть не Render-доменом, а настоящим VPN endpoint:

```text
vpn.example.com:<port>
```

Например:

```text
vless://...@vpn.example.com:443
vless://...@vpn.example.com:2443
hysteria2://...@vpn.example.com:443
```

## Что делает проект

`ProSub`:

* принимает запросы вида `/prosub/<subId>`;
* проксирует их на origin 3x-ui subscription;
* получает base64-подписку от 3x-ui;
* декодирует её;
* заменяет ошибочные endpoints вида:

```text
prosub.onrender.com:<port>
sub.example.com:<port>
old-sub.example.com:<port>
```

на:

```text
vpn.example.com:<тот_же_port>
```

* обратно кодирует подписку в base64;
* отдаёт пользователю исправленную подписку;
* имеет `/health` endpoint для keep-alive Render Free.

## Файлы проекта

```text
Dockerfile
server.js
README.md
```

## Dockerfile

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY server.js /app/server.js

EXPOSE 10000

CMD ["node", "server.js"]
```

## Основные переменные в server.js

```js
const ORIGIN_HOST = "203.0.113.10";
const ORIGIN_PORT = 51801;
const ORIGIN_SNI = "sub.example.com";

const PUBLIC_SUB_HOSTS = [
  "prosub.onrender.com",
  "prosub.example.com",
  "old-sub.example.com",
  "sub.example.com",
];

const VPN_ENDPOINT_HOST = "vpn.example.com";
```

Где:

```text
ORIGIN_HOST
  внешний IP основного сервера / роутера / firewall

ORIGIN_PORT
  порт 3x-ui subscription

ORIGIN_SNI
  host/SNI, под которым origin нормально отдаёт подписку

PUBLIC_SUB_HOSTS
  домены подписки, которые 3x-ui может ошибочно подставить как VPN endpoint

VPN_ENDPOINT_HOST
  настоящий VPN endpoint, который должен оказаться внутри подписки
```

## Render

Создать Web Service:

```text
New → Web Service → Build and deploy from Git repository
```

Настройки:

```text
Name: prosub
Runtime: Docker
Branch: main
Instance Type: Free
```

После деплоя Render выдаст адрес:

```text
https://prosub.onrender.com
```

Проверка:

```bash
curl -L https://prosub.onrender.com/health
```

Ожидаемый ответ:

```text
ok
```

## Проверка подписки

```bash
curl -L 'https://prosub.onrender.com/prosub/<subId>' | base64 -d
```

Правильно:

```text
vless://...@vpn.example.com:443
vless://...@vpn.example.com:2443
hysteria2://...@vpn.example.com:443
```

Неправильно:

```text
vless://...@prosub.onrender.com:443
vless://...@prosub.onrender.com:2443
vless://...@sub.example.com:443
```

## Настройки 3x-ui

В 3x-ui:

```text
Настройки → Подписка
```

Указать:

```text
URI-путь:
/prosub/

URI обратного прокси:
https://prosub.onrender.com/prosub/
```

После изменения перезапустить 3x-ui:

```bash
systemctl restart x-ui
```

Теперь в карточке клиента 3x-ui должна формироваться ссылка:

```text
https://prosub.onrender.com/prosub/<subId>
```

## Router / Firewall / NAT

Доступ к `51801/tcp` должен быть открыт только для outbound-сетей Render.

Пример outbound-сетей Render:

```text
198.51.100.0/24
203.0.113.0/24
```

Пример для MikroTik:

```mikrotik
/ip firewall address-list add list=render-sub-proxy address=198.51.100.0/24 comment=render-sub-proxy
/ip firewall address-list add list=render-sub-proxy address=203.0.113.0/24 comment=render-sub-proxy
```

Создать NAT только для Render:

```mikrotik
/ip firewall nat add action=dst-nat chain=dstnat comment=sub-render-51801/tcp dst-port=51801 in-interface-list=WAN protocol=tcp src-address-list=render-sub-proxy to-addresses=10.0.0.10 to-ports=51801
```

Если старый общий проброс подписки был включён, отключить:

```mikrotik
/ip firewall nat disable [find comment="panel-sub"]
```

Проверить NAT:

```mikrotik
/ip firewall nat print where comment~"sub|render|panel-sub"
```

Если используется строгий firewall filter с drop в `forward`, добавить разрешающее правило выше drop:

```mikrotik
/ip firewall filter add action=accept chain=forward comment=allow-sub-render-51801 connection-nat-state=dstnat dst-address=10.0.0.10 dst-port=51801 protocol=tcp src-address-list=render-sub-proxy
```

## Проверка прямого доступа

С сервера, который не входит в Render-сети:

```bash
curl -k -I --connect-timeout 10 \
  'https://203.0.113.10:51801/prosub/<subId>'
```

Ожидаемо: прямой доступ не должен открываться.

Проверка через Render:

```bash
curl -L -I --connect-timeout 30 \
  'https://prosub.onrender.com/prosub/<subId>'
```

Ожидаемо:

```text
HTTP/2 200
```

## Keep-alive для Render Free

Бесплатный Render может засыпать при отсутствии входящих запросов.

Для keep-alive используется endpoint:

```text
https://prosub.onrender.com/health
```

Он отвечает сам Render-контейнер и не ходит на основной сервер 3x-ui.

### Скрипт keep-alive

На любом Linux-сервере:

```bash
cat > /usr/local/sbin/prosub-render-keepalive.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

URL="https://prosub.onrender.com/health"
LOCK="/run/prosub-render-keepalive.lock"

(
  flock -n 9 || exit 0

  HTTP_CODE="$(curl -fsS -o /dev/null -w "%{http_code}" --connect-timeout 10 --max-time 20 "$URL" || true)"

  if [ "$HTTP_CODE" != "200" ]; then
    echo "WARN: keepalive failed, http_code=${HTTP_CODE}"
    exit 1
  fi

  echo "OK: keepalive ${URL} http_code=${HTTP_CODE}"
) 9>"$LOCK"
EOF

chmod +x /usr/local/sbin/prosub-render-keepalive.sh
```

Проверка:

```bash
/usr/local/sbin/prosub-render-keepalive.sh
```

Ожидаемо:

```text
OK: keepalive https://prosub.onrender.com/health http_code=200
```

### systemd service

```bash
cat > /etc/systemd/system/prosub-render-keepalive.service <<'EOF'
[Unit]
Description=Keep Render ProSub service warm

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/prosub-render-keepalive.sh
EOF
```

### systemd timer

```bash
cat > /etc/systemd/system/prosub-render-keepalive.timer <<'EOF'
[Unit]
Description=Run ProSub Render keepalive every 3 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=3min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
EOF
```

Включить:

```bash
systemctl daemon-reload
systemctl enable --now prosub-render-keepalive.timer
```

Проверить:

```bash
systemctl status prosub-render-keepalive.timer --no-pager
systemctl list-timers | grep prosub
journalctl -u prosub-render-keepalive.service -n 20 --no-pager
```

Отключить при необходимости:

```bash
systemctl disable --now prosub-render-keepalive.timer
```

## Health endpoint

```bash
curl -L https://prosub.onrender.com/health
```

Ответ:

```text
ok
```

## Browser mode

Если открыть ссылку подписки в браузере:

```text
https://prosub.onrender.com/prosub/<subId>
```

будет показана простая HTML-страница с:

* ссылкой для приложения;
* кнопкой копирования;
* raw-режимом;
* декодированными конфигурациями внутри подписки.

Raw-режим:

```text
https://prosub.onrender.com/prosub/<subId>?raw=1
```

VPN-клиентам и `curl` отдаётся обычная base64-подписка.

## Безопасность

Рекомендации:

* не открывать `51801/tcp` всему интернету;
* разрешать `51801/tcp` только Render outbound-сетям;
* не публиковать панели через Render;
* использовать Render только для subscription;
* при утечке `subId` менять `subId` клиента;
* endpoints внутри подписки должны вести на `vpn.example.com`, а не на Render-домен.

## Итог

Пользователь получает:

```text
https://prosub.onrender.com/prosub/<subId>
```

Внутри подписки остаётся настоящий endpoint:

```text
vpn.example.com:<port>
```

Render используется только как публичный reverse-proxy для подписки.
