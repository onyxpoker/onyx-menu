/*
  ONYX Poker Club — сервер заказов.

  Запуск (нужен Node.js 18+, больше ничего ставить не надо):
      STAFF_PIN=4821 node server.js
  Windows (PowerShell):
      $env:STAFF_PIN="4821"; node server.js

  Положите рядом с этим файлом index.html (меню) и staff.html (официанты).
    http://адрес:3000/        — меню для гостей
    http://адрес:3000/staff   — страница официантов (вход по PIN)
  Заказы хранятся в orders.json в этой же папке.

  Необязательные настройки: PORT (по умолчанию 3000),
  HISTORY_DAYS — сколько дней хранить выданные заказы (по умолчанию 30).
*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.STAFF_PIN || "");
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 30;
const DIR = __dirname;
const DATA = path.join(DIR, "orders.json");

if (PIN.length < 4) {
  console.error("Задайте PIN официантов (не короче 4 символов): STAFF_PIN=4821 node server.js");
  process.exit(1);
}

/* ---------- хранилище ---------- */
let db = { next: 1, orders: [] };
try { db = JSON.parse(fs.readFileSync(DATA, "utf8")); } catch (e) { /* первый запуск */ }

function prune() {
  const limit = Date.now() - HISTORY_DAYS * 864e5;
  db.orders = db.orders.filter(o => o.status !== "served" || Date.parse(o.servedAt) > limit);
}
function persist() {
  prune();
  const tmp = DATA + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA);
}

/* ---------- помощники ---------- */
function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(type ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 32 * 1024) { reject(new Error("too big")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}
const str = (v, max) => typeof v === "string" ? v.trim().slice(0, max) : "";
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max ? v : null;

/* ---------- защита страницы официантов ---------- */
const pinHash = crypto.createHash("sha256").update(PIN).digest();
const fails = new Map(); // ip -> {n, until}
function ipOf(req) { return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress; }
function staffOk(req, res) {
  const ip = ipOf(req), now = Date.now();
  let f = fails.get(ip);
  if (f && f.until && f.until <= now) f = null; // блокировка истекла
  if (f && f.until > now) { send(res, 429, { error: "Слишком много попыток. Подождите 10 минут." }); return false; }
  const given = crypto.createHash("sha256").update(String(req.headers["x-staff-pin"] || "")).digest();
  if (crypto.timingSafeEqual(given, pinHash)) { fails.delete(ip); return true; }
  const n = (f ? f.n : 0) + 1;
  fails.set(ip, { n, until: n >= 10 ? now + 10 * 60e3 : 0 });
  send(res, 401, { error: "Неверный PIN" });
  return false;
}

/* ---------- приём заказа от гостя ---------- */
const orderHits = new Map(); // ip -> [времена]
function createOrder(body) {
  const table = str(body.table, 4);
  const guestId = str(body.guestId, 20);
  if (!/^\d{1,4}$/.test(table)) return { error: "Неверный номер стола" };
  if (!guestId) return { error: "Не указан ID гостя" };
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 60) return { error: "Пустой заказ" };
  const items = [];
  for (const it of body.items) {
    const name = str(it && it.name, 120), size = str(it && it.size, 40);
    const price = int(it && it.price, 0, 100000), qty = int(it && it.qty, 1, 99);
    if (!name || price === null || qty === null) return { error: "Ошибка в позиции заказа" };
    items.push({ name, size, price, qty, sum: price * qty });
  }
  const order = {
    id: db.next++,
    table, guestId, items,
    total: items.reduce((s, i) => s + i.sum, 0),
    status: "new",
    createdAt: new Date().toISOString(),
    cookingAt: null,
    servedAt: null,
  };
  db.orders.push(order);
  persist();
  console.log(`Новый заказ №${order.id}: стол ${table}, ID ${guestId}, ${order.total} ₽`);
  return { order };
}

/* ---------- смена статуса официантом ---------- */
const NEXT = { new: ["cooking", "served"], cooking: ["served"], served: ["cooking"] }; // served → cooking = «вернуть в работу»
function setStatus(id, status) {
  const o = db.orders.find(x => x.id === id);
  if (!o) return { code: 404, error: "Заказ не найден" };
  if (o.status === status) return { order: o };
  if (!(NEXT[o.status] || []).includes(status)) return { code: 409, error: "Нельзя сменить статус" };
  const now = new Date().toISOString();
  if (status === "cooking") { o.cookingAt = o.cookingAt || now; o.servedAt = null; }
  if (status === "served") o.servedAt = now;
  o.status = status;
  persist();
  return { order: o };
}

/* ---------- маршруты ---------- */
const PAGES = { "/": "index.html", "/index.html": "index.html", "/staff": "staff.html", "/staff.html": "staff.html" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && PAGES[p]) {
      const html = fs.readFileSync(path.join(DIR, PAGES[p]));
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (p === "/api/orders" && req.method === "POST") {
      const ip = ipOf(req), now = Date.now();
      const hits = (orderHits.get(ip) || []).filter(t => now - t < 60e3);
      if (hits.length >= 10) return send(res, 429, { error: "Слишком много заказов, подождите минуту" });
      hits.push(now); orderHits.set(ip, hits);
      const r = createOrder(await readBody(req));
      if (r.error) return send(res, 400, { error: r.error });
      return send(res, 201, { id: r.order.id });
    }

    if (p === "/api/staff/orders" && req.method === "GET") {
      if (!staffOk(req, res)) return;
      const active = db.orders.filter(o => o.status !== "served");
      const history = db.orders.filter(o => o.status === "served")
        .sort((a, b) => Date.parse(b.servedAt) - Date.parse(a.servedAt)).slice(0, 300);
      return send(res, 200, { active, history, now: new Date().toISOString() });
    }

    const m = p.match(/^\/api\/staff\/orders\/(\d+)\/status$/);
    if (m && req.method === "POST") {
      if (!staffOk(req, res)) return;
      const body = await readBody(req);
      const r = setStatus(Number(m[1]), str(body.status, 20));
      if (r.error) return send(res, r.code, { error: r.error });
      return send(res, 200, { order: r.order });
    }

    send(res, 404, { error: "Не найдено" });
  } catch (e) {
    send(res, 400, { error: "Некорректный запрос" });
  }
});

server.listen(PORT, () => {
  console.log(`ONYX: меню      http://localhost:${PORT}/`);
  console.log(`ONYX: официанты http://localhost:${PORT}/staff`);
});
