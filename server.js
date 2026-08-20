import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import { createServer } from "http";
import { Server } from "socket.io";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const DOWNLOADS_FILE = path.join(DATA_DIR, "downloads.json");
const CHAT_FILE = path.join(DATA_DIR, "chat.json");
const BROADCAST_FILE = path.join(DATA_DIR, "broadcast.json");

const MAX_DOWNLOAD_LOG = 200;
const MAX_CHAT_LOG = 300;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const port = process.env.PORT || 3000;

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json());

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || "ganti-secret-ini",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

app.use(express.static("public"));

// ==================== Helper baca/tulis file JSON ====================

async function bacaJSON(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function tulisJSON(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function buatId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function usernameValid(username) {
  return typeof username === "string" && /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

// ==================== Middleware ====================

function wajibLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ success: false, message: "Silakan login terlebih dahulu." });
  }
  next();
}

function wajibAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ success: false, message: "Akses ditolak. Khusus admin." });
  }
  next();
}

// ==================== Rute Autentikasi ====================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!usernameValid(username)) {
      return res.status(400).json({ success: false, message: "Username harus 3-20 karakter, hanya huruf/angka/underscore." });
    }
    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ success: false, message: "Kata sandi minimal 6 karakter." });
    }
    if (username.toLowerCase() === "admin") {
      return res.status(400).json({ success: false, message: "Username 'admin' dilindungi sistem." });
    }

    const users = await bacaJSON(USERS_FILE, []);
    const sudahAda = users.some(u => u.username.toLowerCase() === username.toLowerCase());
    if (sudahAda) {
      return res.status(409).json({ success: false, message: "Username sudah digunakan, silakan pilih yang lain." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ id: buatId(), username, passwordHash, role: "user", createdAt: new Date().toISOString() });
    await tulisJSON(USERS_FILE, users);

    return res.json({ success: true, message: "Pendaftaran berhasil. Silakan masuk." });
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal mendaftar.", error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ success: false, message: "Username dan kata sandi wajib diisi." });
    }

    if (username.toLowerCase() === "admin") {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword || password !== adminPassword) {
        return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
      }
      req.session.user = { username: "admin", role: "admin" };
      return req.session.save(() => res.json({ success: true, user: { username: "admin", role: "admin" } }));
    }

    const users = await bacaJSON(USERS_FILE, []);
    const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
    }

    const cocok = await bcrypt.compare(password, user.passwordHash);
    if (!cocok) {
      return res.status(401).json({ success: false, message: "Username atau kata sandi salah." });
    }

    req.session.user = { username: user.username, role: "user" };
    return req.session.save(() => res.json({ success: true, user: { username: user.username, role: "user" } }));
  } catch (error) {
    return res.status(500).json({ success: false, message: "Gagal login.", error: error.message });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ success: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (req.session.user) {
    return res.json({ success: true, user: req.session.user });
  }
  return res.status(401).json({ success: false, message: "Belum login." });
});

// ==================== Download (real + broadcast via Socket.IO) ====================

const apiMap = {
  tiktok: process.env.TIKTOK_API,
  instagram: process.env.INSTAGRAM_API,
  youtube: process.env.YOUTUBE_API
};

function detectPlatform(url) {
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  return null;
}

async function catatRiwayatDownload(entry) {
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);
  downloads.push(entry);
  while (downloads.length > MAX_DOWNLOAD_LOG) downloads.shift();
  await tulisJSON(DOWNLOADS_FILE, downloads);

  io.emit("download:new", entry);

  const all = await bacaJSON(DOWNLOADS_FILE, []);
  const total = all.length;
  const sukses = all.filter(d => d.success).length;
  io.emit("stats:update", { total, sukses, gagal: total - sukses });
}

app.post("/api/download", wajibLogin, async (req, res) => {
  const { url, platform } = req.body || {};
  const username = req.session.user.username;

  if (!url) {
    return res.status(400).json({ success: false, message: "URL wajib diisi." });
  }

  const detectedPlatform = platform || detectPlatform(url);

  if (!detectedPlatform || !apiMap[detectedPlatform]) {
    await catatRiwayatDownload({
      id: buatId(), username,
      filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
      platform: detectedPlatform || "unknown",
      success: false, message: "Platform tidak didukung.",
      createdAt: new Date().toISOString()
    });
    return res.status(400).json({ success: false, message: "Platform tidak didukung." });
  }

  try {
    const targetUrl = `${apiMap[detectedPlatform]}?url=${encodeURIComponent(url)}`;
    const response = await fetch(targetUrl);
    const rawText = await response.text();

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      data = { success: false, message: "API tidak mengembalikan JSON.", raw: rawText };
    }

    const berhasil = response.ok && data && data.success !== false;

    await catatRiwayatDownload({
      id: buatId(), username,
      filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
      platform: detectedPlatform,
      success: berhasil,
      message: berhasil ? "Sukses" : (data && data.message) || "Gagal",
      createdAt: new Date().toISOString()
    });

    if (!response.ok) return res.status(response.status).json(data);
    return res.json({ success: true, platform: detectedPlatform, data });
  } catch (error) {
    await catatRiwayatDownload({
      id: buatId(), username,
      filename: url.length > 40 ? url.slice(0, 40) + "..." : url,
      platform: detectedPlatform,
      success: false, message: error.message,
      createdAt: new Date().toISOString()
    });
    return res.status(500).json({ success: false, message: "Gagal menghubungi API downloader.", error: error.message });
  }
});

app.get("/api/downloads", wajibLogin, async (req, res) => {
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);
  return res.json({ success: true, downloads: downloads.slice(-50) });
});

app.get("/api/admin/stats", wajibLogin, wajibAdmin, async (req, res) => {
  const downloads = await bacaJSON(DOWNLOADS_FILE, []);
  const total = downloads.length;
  const sukses = downloads.filter(d => d.success).length;
  return res.json({ success: true, stats: { total, sukses, gagal: total - sukses } });
});

// ==================== Chat (real, broadcast via Socket.IO) ====================

app.get("/api/chat", wajibLogin, async (req, res) => {
  const chat = await bacaJSON(CHAT_FILE, []);
  return res.json({ success: true, messages: chat.slice(-100) });
});

app.delete("/api/chat", wajibLogin, wajibAdmin, async (req, res) => {
  await tulisJSON(CHAT_FILE, []);
  io.emit("chat:cleared");
  return res.json({ success: true });
});

// ==================== Broadcast admin (real, broadcast via Socket.IO) ====================

app.get("/api/broadcast", wajibLogin, async (req, res) => {
  const broadcast = await bacaJSON(BROADCAST_FILE, { text: "", image: "", active: false, updatedAt: null });
  return res.json({ success: true, broadcast });
});

app.delete("/api/broadcast", wajibLogin, wajibAdmin, async (req, res) => {
  const broadcast = { text: "", image: "", active: false, updatedAt: new Date().toISOString() };
  await tulisJSON(BROADCAST_FILE, broadcast);
  io.emit("broadcast:update", broadcast);
  return res.json({ success: true, broadcast });
});

app.get("/api/health", (req, res) => {
  res.json({ success: true, service: "SnapLam Downloader", time: new Date().toISOString() });
});

// ==================== Socket.IO real-time ====================

io.use((socket, next) => {
  const req = socket.request;
  if (req.session && req.session.user) {
    socket.user = req.session.user;
    return next();
  }
  next(new Error("Belum login."));
});

io.on("connection", socket => {
  socket.on("chat:send", async (payload, callback) => {
    const teks = (payload && payload.text || "").trim();
    if (!teks) {
      if (callback) callback({ success: false, message: "Pesan tidak boleh kosong." });
      return;
    }

    const pengirim = socket.user;
    const chat = await bacaJSON(CHAT_FILE, []);
    const pesanBaru = {
      id: buatId(),
      sender: pengirim.role === "admin" ? "👑 Admin" : pengirim.username,
      isAdmin: pengirim.role === "admin",
      text: teks.slice(0, 500),
      createdAt: new Date().toISOString()
    };
    chat.push(pesanBaru);
    while (chat.length > MAX_CHAT_LOG) chat.shift();
    await tulisJSON(CHAT_FILE, chat);

    io.emit("chat:new", pesanBaru);
    if (callback) callback({ success: true, chatMessage: pesanBaru });
  });

  socket.on("broadcast:send", async (payload, callback) => {
    if (!socket.user || socket.user.role !== "admin") {
      if (callback) callback({ success: false, message: "Akses ditolak. Khusus admin." });
      return;
    }

    const text = (payload && payload.text) || "";
    const image = (payload && payload.image) || "";
    if (!text && !image) {
      if (callback) callback({ success: false, message: "Isi pesan atau gambar wajib diisi." });
      return;
    }

    const broadcast = { text, image, active: true, updatedAt: new Date().toISOString() };
    await tulisJSON(BROADCAST_FILE, broadcast);

    io.emit("broadcast:update", broadcast);
    if (callback) callback({ success: true, broadcast });
  });
});

httpServer.listen(port, () => {
  console.log(`SnapLam (Socket.IO) berjalan di http://localhost:${port}`);
});
