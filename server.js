const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 10000;

// Основной сервер, где реально работает 3x-ui subscription.
// Примерный публичный IP из документационного диапазона.
const ORIGIN_HOST = "203.0.113.10";
const ORIGIN_PORT = 51801;

// Host/SNI, под которым origin нормально отдаёт подписку.
const ORIGIN_SNI = "cssub.example.com";

const ORIGIN_TIMEOUT_MS = 7000;

// Домены подписки, которые 3x-ui может ошибочно подставить внутрь конфигов как endpoint.
// Их заменяем на настоящий VPN endpoint.
const PUBLIC_SUB_HOSTS = [
  "sub.onrender.com",
  "prosub.example.com",
  "sub1.example.com",
  "sub2.example.com",
  "s.example.com",
  "cssub.example.com",
];

// Настоящий VPN endpoint.
const VPN_ENDPOINT_HOST = "cs.example.com";

// Порты по странам/названиям профилей.
// match ищется в названии профиля после #.
// Например:
// #🇸🇪 Pro
// #🇩🇪 Hysteria
// #FI Hysteria
//
// Если 3x-ui всем Hysteria2-ссылкам подставит :443,
// этот блок исправит порт по названию профиля.
const COUNTRY_PORT_RULES = [
  { match: "🇸🇪", port: "443" },
  { match: "SE", port: "443" },
  { match: "Sweden", port: "443" },

  { match: "🇩🇪", port: "2443" },
  { match: "DE", port: "2443" },
  { match: "Germany", port: "2443" },

  { match: "🇫🇮", port: "3443" },
  { match: "FI", port: "3443" },
  { match: "Finland", port: "3443" },

  // Пример для будущей страны:
  // { match: "🇳🇱", port: "4443" },
  // { match: "NL", port: "4443" },
  // { match: "Netherlands", port: "4443" },
];

// Протоколы, у которых нужно переписывать основной endpoint.
const SUPPORTED_LINK_PREFIXES = [
  "vless://",
  "hysteria2://",
  "hy2://",
];

function filterHeaders(headers) {
  const result = { ...headers };

  delete result.host;
  delete result.connection;
  delete result["keep-alive"];
  delete result["proxy-authenticate"];
  delete result["proxy-authorization"];
  delete result.te;
  delete result.trailer;
  delete result["transfer-encoding"];
  delete result.upgrade;
  delete result["content-length"];

  // Просим origin не сжимать ответ.
  // Так проще безопасно переписывать тело подписки.
  delete result["accept-encoding"];

  return result;
}

function looksLikeBase64Subscription(body) {
  const text = body.toString("utf8").trim();

  if (!text) return false;
  if (text.includes("<html") || text.includes("<!DOCTYPE")) return false;

  return /^[A-Za-z0-9+/=\r\n]+$/.test(text);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function getRemarkFromLine(line) {
  const hashIndex = line.indexOf("#");

  if (hashIndex === -1) {
    return "";
  }

  return safeDecodeURIComponent(line.slice(hashIndex + 1));
}

function getPortForRemark(remark) {
  for (const rule of COUNTRY_PORT_RULES) {
    if (remark.includes(rule.match)) {
      return rule.port;
    }
  }

  return null;
}

function isSupportedSubscriptionLine(line) {
  return SUPPORTED_LINK_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function rewriteMainEndpoint(line) {
  if (!isSupportedSubscriptionLine(line)) {
    return line;
  }

  const remark = getRemarkFromLine(line);
  const forcedPort = getPortForRemark(remark);

  // Разбираем только основной endpoint в начале строки:
  //
  // scheme://userinfo@host:port?params#remark
  //
  // Не трогаем query-параметры:
  // sni=...
  // obfs-password=...
  // pbk=...
  const match = line.match(
    /^([a-zA-Z0-9+.-]+:\/\/)([^@\s#]+@)(\[[^\]]+\]|[^:/?#\s]+)(?::(\d+))?([\s\S]*)$/
  );

  if (!match) {
    return line;
  }

  const scheme = match[1];
  const userInfo = match[2];
  const originalHost = match[3];
  const originalPort = match[4] || "";
  const rest = match[5] || "";

  let newHost = originalHost;
  let newPort = originalPort;

  // Меняем host только если он из списка публичных subscription-доменов
  // или уже равен правильному VPN endpoint.
  if (
    PUBLIC_SUB_HOSTS.includes(originalHost) ||
    originalHost === VPN_ENDPOINT_HOST
  ) {
    newHost = VPN_ENDPOINT_HOST;
  }

  // Если по названию профиля задан порт — применяем его.
  // Это лечит ситуацию, когда 3x-ui всем Hysteria2 генерит :443.
  if (forcedPort) {
    newPort = forcedPort;
  }

  const portPart = newPort ? `:${newPort}` : "";

  return `${scheme}${userInfo}${newHost}${portPart}${rest}`;
}

function rewriteSubscriptionText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        return trimmed;
      }

      return rewriteMainEndpoint(trimmed);
    })
    .join("\n");
}

function rewriteSubscriptionBody(body) {
  const originalText = body.toString("utf8").trim();

  if (!looksLikeBase64Subscription(body)) {
    const changedPlainText = rewriteSubscriptionText(originalText);

    if (changedPlainText === originalText) {
      return body;
    }

    return Buffer.from(changedPlainText, "utf8");
  }

  let decoded;
  try {
    decoded = Buffer.from(originalText, "base64").toString("utf8");
  } catch (e) {
    return body;
  }

  const changed = rewriteSubscriptionText(decoded);

  if (changed === decoded) {
    return body;
  }

  return Buffer.from(changed, "utf8").toString("base64");
}

function wantsHtml(req) {
  const accept = req.headers.accept || "";
  const ua = (req.headers["user-agent"] || "").toLowerCase();

  return (
    accept.includes("text/html") &&
    !ua.includes("clash") &&
    !ua.includes("hiddify") &&
    !ua.includes("v2ray") &&
    !ua.includes("sing-box") &&
    !ua.includes("nekobox") &&
    !ua.includes("nekoray") &&
    !ua.includes("happ")
  );
}

function htmlEscape(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderBrowserPage(req, decoded) {
  const url = `https://${req.headers.host}${req.url}`;
  const rawUrl = url.includes("?") ? `${url}&raw=1` : `${url}?raw=1`;

  const safeUrl = htmlEscape(url);
  const safeRawUrl = htmlEscape(rawUrl);
  const safeDecoded = htmlEscape(decoded);

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ProSub</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #111318;
      color: #f3f3f3;
    }
    .wrap {
      max-width: 900px;
      margin: 40px auto;
      padding: 24px;
    }
    .card {
      background: #1d2028;
      border: 1px solid #333846;
      border-radius: 14px;
      padding: 22px;
    }
    h1 {
      margin-top: 0;
      font-size: 24px;
    }
    h2 {
      font-size: 18px;
      margin-top: 24px;
    }
    .url {
      background: #101218;
      border: 1px solid #333846;
      border-radius: 10px;
      padding: 12px;
      word-break: break-all;
      margin: 14px 0;
    }
    textarea {
      width: 100%;
      min-height: 240px;
      box-sizing: border-box;
      background: #101218;
      color: #f3f3f3;
      border: 1px solid #333846;
      border-radius: 10px;
      padding: 12px;
      font-family: monospace;
      line-height: 1.4;
    }
    button, a.btn {
      display: inline-block;
      background: #3b82f6;
      color: white;
      border: 0;
      border-radius: 10px;
      padding: 10px 14px;
      text-decoration: none;
      cursor: pointer;
      margin-right: 8px;
      margin-top: 10px;
      font-size: 14px;
    }
    .muted {
      color: #a8adba;
      font-size: 14px;
    }
    .ok {
      display: inline-block;
      background: #12351f;
      color: #7ee787;
      border: 1px solid #245c37;
      padding: 6px 10px;
      border-radius: 999px;
      font-size: 13px;
      margin-bottom: 12px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="ok">Subscription proxy online</div>
      <h1>ProSub подписка</h1>

      <div class="muted">Ссылка для приложения:</div>
      <div class="url" id="url">${safeUrl}</div>

      <button onclick="navigator.clipboard.writeText('${safeUrl}')">Скопировать ссылку</button>
      <a class="btn" href="${safeRawUrl}">Открыть raw</a>

      <h2>Конфигурации внутри подписки</h2>
      <textarea readonly>${safeDecoded}</textarea>
    </div>
  </div>
</body>
</html>`;
}

function getOriginPath(reqUrl) {
  const parsed = new URL(reqUrl, "http://localhost");
  parsed.searchParams.delete("raw");
  return `${parsed.pathname}${parsed.search}`;
}

function fetchOrigin(req, callback) {
  const options = {
    hostname: ORIGIN_HOST,
    port: ORIGIN_PORT,
    path: getOriginPath(req.url),
    method: req.method,
    servername: ORIGIN_SNI,
    rejectUnauthorized: false,
    timeout: ORIGIN_TIMEOUT_MS,
    headers: {
      ...filterHeaders(req.headers),
      Host: ORIGIN_SNI,
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": req.headers.host || "",
      "X-Forwarded-For": req.socket.remoteAddress || "",
      "X-Real-IP": req.socket.remoteAddress || "",
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    const chunks = [];

    proxyRes.on("data", (chunk) => chunks.push(chunk));

    proxyRes.on("end", () => {
      callback(null, proxyRes, Buffer.concat(chunks));
    });
  });

  proxyReq.setTimeout(ORIGIN_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error("Origin timeout"));
  });

  proxyReq.on("error", (err) => {
    callback(err);
  });

  req.pipe(proxyReq);
}

const server = http.createServer((req, res) => {
  console.log(`${req.method} ${req.url}`);

  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("ok\n");
    return;
  }

  if (!req.url.startsWith("/prosub/")) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found\n");
    return;
  }

  fetchOrigin(req, (err, proxyRes, originalBody) => {
    if (err) {
      console.error("Proxy error:", err.message);
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Bad Gateway\n");
      return;
    }

    const rewrittenBody = rewriteSubscriptionBody(originalBody);

    if (
      wantsHtml(req) &&
      !req.url.includes("raw=1") &&
      looksLikeBase64Subscription(rewrittenBody)
    ) {
      const decoded = Buffer.from(
        rewrittenBody.toString("utf8").trim(),
        "base64"
      ).toString("utf8");

      const html = renderBrowserPage(req, decoded);

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    const headers = filterHeaders(proxyRes.headers);
    headers["content-length"] = Buffer.byteLength(rewrittenBody);
    headers["cache-control"] = "no-store";

    res.writeHead(proxyRes.statusCode || 502, headers);
    res.end(rewrittenBody);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Subscription proxy listening on port ${PORT}`);
});
