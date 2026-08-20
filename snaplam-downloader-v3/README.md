# SnapLam Downloader — v3 (Socket.IO, real-time sungguhan)

## Cara menjalankan

```bash
npm install
npm run dev
```

Buka `http://localhost:3000`.

## Perubahan dari v2 → v3

Polling (cek server tiap 3 detik) diganti **Socket.IO** — event terkirim
instan lewat WebSocket, tanpa jeda:

- `download:new` — riwayat/terminal log muncul instan di semua browser yang terbuka
- `stats:update` — statistik admin (Total/Sukses/Gagal) update instan
- `chat:new` — pesan chat muncul instan ke semua pengguna online
- `chat:cleared` — saat admin bersihkan chat, semua browser ikut bersih instan
- `broadcast:update` — pengumuman admin langsung muncul di semua layar user

Socket.IO memakai sesi login yang sama dengan HTTP (`express-session`)
lewat `io.engine.use(sessionMiddleware)`, jadi koneksi socket otomatis
ditolak kalau belum login.

## UI

Struktur, layout, warna, dan semua class Tailwind di `public/index.html`
dipertahankan **persis sama** seperti desain aslinya — hanya logika JavaScript
di bagian bawah yang diganti dari simulasi/polling menjadi Socket.IO.

## Struktur data

Sama seperti v2 — data tetap disimpan di file JSON (`data/*.json`) untuk
persistensi (chat/riwayat/broadcast tidak hilang saat server restart),
tapi pengiriman ke browser sekarang lewat event Socket.IO, bukan polling.

## Sebelum production

1. Ganti `SESSION_SECRET` dan `ADMIN_PASSWORD` di `.env`.
2. Set `NODE_ENV=production` untuk cookie session lewat HTTPS saja.
3. Kalau deploy dengan banyak instance server (load balancer), Socket.IO
   perlu adapter tambahan (`@socket.io/redis-adapter`) supaya event
   tersinkron antar instance.
