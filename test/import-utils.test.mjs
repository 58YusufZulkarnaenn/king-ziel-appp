import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRowHash,
  getSchemaHash,
  makeRecordData,
  makeUniqueHeaders
} from '../netlify/functions/lib/import-utils.mjs';

test('exact duplicate hash is independent of Excel column order', () => {
  const firstHeaders = ['Nama', 'Alamat', 'Kontrak'];
  const firstRow = ['Yusuf', 'Karawang', 'A-001'];
  const secondHeaders = ['Kontrak', 'Nama', 'Alamat'];
  const secondRow = ['A-001', 'Yusuf', 'Karawang'];

  const firstData = makeRecordData(firstHeaders, firstRow);
  const secondData = makeRecordData(secondHeaders, secondRow);

  assert.equal(getSchemaHash(firstHeaders), getSchemaHash(secondHeaders));
  assert.equal(getRowHash(firstHeaders, firstData), getRowHash(secondHeaders, secondData));
});

test('matching only one column does not make rows exact duplicates', () => {
  const headers = ['Nama', 'Kota', 'Kontrak'];
  const first = makeRecordData(headers, ['Yusuf', 'Karawang', 'A-001']);
  const second = makeRecordData(headers, ['Yusuf', 'Bekasi', 'A-001']);

  assert.notEqual(getRowHash(headers, first), getRowHash(headers, second));
});

test('any difference in any imported column changes the exact-row hash', () => {
  const headers = ['Nama', 'Alamat', 'Status'];
  const first = makeRecordData(headers, ['Yusuf', 'Karawang', 'Aktif']);
  const second = makeRecordData(headers, ['Yusuf', 'Karawang', 'Tidak Aktif']);

  assert.notEqual(getRowHash(headers, first), getRowHash(headers, second));
});

test('duplicate or blank headers are made unique', () => {
  assert.deepEqual(makeUniqueHeaders(['Nama', 'Nama', '', 'nama']), [
    'Nama', 'Nama (2)', 'Kolom 3', 'nama (3)'
  ]);
});
