# Aturan Import (ringkas)

1. `schema_hash` adalah fingerprint kumpulan nama kolom (tidak bergantung pada urutan kolom).
2. `row_hash` adalah SHA-256 dari pasangan nama kolom + nilai seluruh kolom (setelah trim tepi dan normalisasi newline).
3. Duplikat persis dalam satu file digabung menjadi satu kandidat.
4. Duplikat persis yang sudah ada dalam dataset dilewati.
5. Kolom identitas yang dipilih pengguna hanya dipakai untuk menemukan record yang perlu di-update. Kolom identitas tidak menggantikan pemeriksaan duplikat persis.
6. Kolom identitas harus terisi semua untuk suatu baris agar baris tersebut dapat mencocokkan record lama.
7. Bila satu kunci cocok ke lebih dari satu record atau muncul pada beberapa baris berbeda di file, commit diblokir.
8. Tanpa kolom identitas, perilaku adalah insert-only.
9. Record yang tidak ada pada file import tidak dihapus.
10. Commit dilakukan dalam transaksi PostgreSQL. Jika satu langkah gagal, seluruh transaksi di-rollback.
