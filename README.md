# KING ZIEL APP — Internal Data Hub

Aplikasi internal untuk pencarian data terpusat dan pembaruan dataset dari Excel/CSV. Frontend di-host di Netlify, sedangkan data disimpan di PostgreSQL melalui Netlify Database.

## Fitur

- Pencarian data dari backend SQL dengan pagination server-side.
- Dataset/kategori dapat dibuat dari menu Update Database.
- Import `.xlsx`, `.xls`, dan `.csv` (baris pertama adalah header; sheet bisa dipilih).
- File diproses di browser dan dikirim ke backend dalam potongan JSON kecil, bukan satu request besar.
- Preview sebelum commit: jumlah data unik, duplikat dalam file, duplikat yang sudah ada di database, calon update, data baru, dan benturan kunci.
- Duplikat persis hanya dihitung jika **semua kolom dari file yang diimpor dan nilainya sama**. Satu kolom yang sama saja tidak membuat baris dianggap duplikat.
- Upsert hanya berjalan jika pengguna memilih kolom identitas. Kolom identitas bisa berupa satu kolom atau kombinasi beberapa kolom.
- Jika tidak ada kolom identitas yang dipilih, sistem berjalan dalam mode tambah-saja (append-only), sambil tetap melewati duplikat persis.
- Jika kunci identitas mengarah ke beberapa record atau bentrok di dalam file, commit diblokir sampai pilihan kunci diperbaiki.
- Record yang tidak ada di file terbaru tidak otomatis dihapus.
- Riwayat import dan rollback untuk import yang belum disentuh oleh import berikutnya.
- Tidak ada akun per karyawan. Semua orang memakai satu link aplikasi yang sama.

## Arsitektur

```text
Browser (Netlify site)
   ├── Pencarian / filter / pagination
   └── Pembacaan Excel + upload bertahap
              |
              v
       Netlify Function API
              |
              v
       Netlify Database (PostgreSQL)
       ├── datasets
       ├── customer_records
       ├── import_batches
       ├── import_staging_rows
       └── import_change_log
```

**Catatan format database:** backend production menggunakan PostgreSQL terkelola, bukan file SQLite `.db` yang dibaca langsung dari folder website. File `.db` SQLite tidak cocok dijadikan database live yang ditulis oleh Netlify Functions karena filesystem Function bersifat sementara. PostgreSQL memberi transaksi, indeks, dan update serentak untuk beberapa pengguna.

## Isi project

```text
index.html
netlify.toml
package.json
netlify/
  database/migrations/0001_create_data_hub.sql
  functions/api.mjs
  functions/lib/import-utils.mjs
```

## Cara pasang ke repository GitHub yang sudah ada

1. Backup repository yang sekarang.
2. Salin **isi folder project ini** ke root repository GitHub (jangan membuat folder project bertingkat di dalam root).
3. Pastikan `index.html`, `netlify.toml`, `package.json`, dan folder `netlify/` berada di root repository.
4. Commit dan push ke branch production yang dipakai Netlify (biasanya `main`).
5. Di Netlify, buka site yang terhubung ke repository itu.
6. Buat/aktifkan database melalui menu **Data & Storage → Database** pada project Netlify. Alternatif untuk setup dari terminal adalah `netlify database init`.
7. Deploy ulang. Karena package `@netlify/database` dan migration SQL sudah ada, Netlify akan menyiapkan PostgreSQL dan menjalankan migration pada proses deploy.
8. Pastikan **Publish directory** adalah `.` dan **Functions directory** adalah `netlify/functions` (keduanya sudah ditulis di `netlify.toml`). Build command tidak diperlukan untuk project statis ini.

Dokumentasi Netlify Database: https://docs.netlify.com/build/data-and-storage/netlify-database/

## Keamanan — penting sebelum memasukkan data customer asli

Aplikasi ini sengaja tidak memakai username, password per orang, atau halaman login/logout. Namun, link yang tidak dibagikan bukan kontrol keamanan: siapa pun yang mengetahui URL dapat mengakses API jika API tidak diberi pembatas.

Untuk membatasi akses tanpa membuat akun karyawan:

1. Buat satu kunci internal yang panjang dan acak.
2. Di Netlify Site configuration → Environment variables, tambahkan `APP_ACCESS_KEY` dengan nilai kunci itu.
3. Trigger deploy ulang agar Function membaca variable tersebut.
4. Saat pertama kali membuka aplikasi di browser, pengguna memasukkan kunci bersama satu kali untuk sesi browser itu. Tidak ada username atau akun.

Jika `APP_ACCESS_KEY` tidak diset, API tidak memakai shared-key gate dan bisa diakses oleh siapa pun yang memiliki URL. Jangan masukkan data customer asli sebelum pengaturan akses dan aturan internal kantor disetujui.

Jangan commit file Excel berisi customer atau database production ke GitHub. `.gitignore` di project ini sudah mengecualikan file `.xlsx`, `.xls`, `.csv`, dan `.db`.

## Cara menggunakan Update Database

1. Buka menu **Update Database**.
2. Pilih dataset yang sudah ada untuk memperbaruinya, atau pilih buat kategori baru.
3. Pilih file Excel/CSV dan sheet yang benar.
4. Pilih kolom identitas yang benar-benar stabil dan unik, misalnya ID customer atau nomor kontrak. Untuk identitas gabungan, pilih beberapa kolom sekaligus.
5. Klik **Analisis & Preview**. Baris akan dikirim ke backend secara bertahap dan dihitung di SQL.
6. Tinjau jumlah data baru, record yang akan diperbarui, duplikat persis, dan peringatan kunci ambigu.
7. Klik **Terapkan Update ke Database** hanya setelah angka preview benar.

### Arti mode import

- **Dengan kolom identitas:** record lama yang cocok akan diperbarui; record yang tidak cocok akan ditambahkan.
- **Tanpa kolom identitas:** sistem hanya menambahkan data yang belum ada secara persis. Tidak ada update berdasarkan tebakan.
- **Duplikat persis:** fingerprint dibuat dari gabungan nama semua kolom dan nilai seluruh kolom pada file. Baris dengan hanya satu kolom yang sama tidak dianggap duplikat.
- **Kunci ambigu:** jika satu kombinasi identitas cocok ke lebih dari satu record atau muncul pada beberapa baris yang berbeda dalam file, commit diblokir untuk mencegah salah update.
- **Record yang hilang dari file:** tidak dihapus otomatis.

Sebaiknya uji dulu dengan Excel dummy atau salinan data yang sudah dianonimkan. Pastikan pemilihan kolom identitas benar sebelum menjalankan import master production.

## Local development

Butuh Node.js 20+.

```bash
npm install
npx netlify dev
```

`netlify dev` menjalankan site dan Functions secara lokal. Untuk memakai Netlify Database lokal/branch, ikuti petunjuk `netlify database init` dan dokumentasi Netlify Database.

## Batas dan catatan teknis

- Import membaca worksheet di browser; workbook Excel yang sangat besar memerlukan memori browser yang cukup.
- Data dikirim bertahap dengan ukuran chunk sekitar 1,1 MB agar jauh di bawah batas payload Function.
- Search utama memakai indeks trigram pada `search_text`; filter kolom memakai JSONB.
- Hasil pencarian menggunakan pagination server-side, jadi seluruh tabel tidak dikirim ke browser sekaligus.
- Export saat ini mengekspor halaman yang sedang terlihat, bukan seluruh hasil pencarian.
- Riwayat menyimpan perubahan yang diperlukan untuk rollback. Rollback ditolak bila record terdampak sudah disentuh oleh import yang lebih baru.
- Netlify Database menggunakan kuota/credits sesuai paket dan penggunaan. Periksa halaman billing/usage Netlify sebelum mengaktifkannya untuk beban data kantor.
