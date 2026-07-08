# Plan: Personality Editor Multi-Section

## Tujuan
Restruktur `personality.txt` jadi bab-bab jelas, dan UI editor bisa edit per bab.

## 1. Restruktur `personality.txt`
Standarisasi semua bagian jadi format `## ` heading (Markdown). ±10 bab:

| # | Bab | Isi |
|---|---|---|
| 1 | Identitas | Nama, usia, status, kehidupan |
| 2 | Background | Mahasiswa, introvert, hobi |
| 3 | Relasi dengan Owner | Panggilan, perhatian, cemburu |
| 4 | Kepribadian | Sifat, cara ngobrol, hadapi troll/AI question |
| 5 | Cara Ngomong | Vibe, panjang jawaban, fragment style |
| 6 | Variasi Suara | Vokal panjang, kapital, ketawa, aturan "aku/kamu" |
| 7 | Relasi (Umum) | Chat pribadi vs grup vs orang lain |
| 8 | Panjang Jawaban | Statistik panjang chat, aturan, pengecualian |
| 9 | Ngobrol sama Orang Lain | Sikap, batasan info, privasi |
| 10 | Aturan Khusus | Vision, [SEARCH], badword, auto-chat, aturan umum |

## 2. Parsing di `personality.js`
Tambah fungsi:
- `parseSections(content)` → `[{ key, title, content, order }]`
- `joinSections(sections)` → gabung balik jadi string
- `getSection(content, key)` / `setSection(content, key, newContent)`

## 3. API Endpoint Baru
| Endpoint | Method | Fungsi |
|---|---|---|
| `/api/personality` | GET/PUT | Tetap full text (backward compat) |
| `/api/personality/sections` | GET | Return `{ sections: [{ key, title, content, order }] }` |
| `/api/personality/section` | PUT | Terima `{ key, content }`, parse-replace-save |

## 4. UI Changes (Settings Page)
Ganti single textarea jadi list card per bab:
- **Collapsed** default (cuma nomor + judul)
- **Expand** → textarea + tombol Simpan
- Dirty state indicator (dot merah)
- Search/filter bab

## 5. File yang Diubah
| File | Perubahan |
|---|---|
| `personality.txt` | Standarisasi heading |
| `src/personality.js` | Tambah fungsi parsing |
| `src/api-skeleton.js` | Tambah endpoint sections |
| `dashboard/settings.html` | Ganti textarea ke section list |
| `dashboard/login.html` | CSS section cards + accordion |
| `dashboard/index.html` | Sama, copy login.html |
| `dashboard/app.js` | Update initSettings + per-section handler |

## Status
⏸️ **Ditunda** — akan dikerjakan setelah fitur prioritas lain selesai.
