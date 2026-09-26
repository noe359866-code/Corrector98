import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata, computeMetadataPatch } from '../src/parsers/metadata.js';

const cases = [
  ['Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR10.H.265-FLUX',
    { quality: '2160p', codec: 'HEVC', hdr_format: 'DV+HDR10', channels: '5.1', release_group: 'FLUX' }],
  ['Breaking.Bad.S02E09.1080p.BluRay.x264-DEMAND',
    { quality: '1080p', codec: 'AVC', hdr_format: null, channels: null, release_group: 'DEMAND' }],
  ['[SubsPlease] Sousou no Frieren - 09 (1080p) [ABCD1234].mkv',
    { quality: '1080p', release_group: 'SubsPlease' }],
  ['La Casa de Papel [HDTV 720p][Cap.209][AC3 5.1 Castellano]',
    { quality: '720p', channels: '5.1', release_group: null }],
  ['Movie.2023.2160p.UHD.BluRay.REMUX.HDR10+.HEVC.TrueHD.7.1.Atmos-FraMeSToR',
    { quality: '2160p', codec: 'HEVC', hdr_format: 'HDR10+', channels: '7.1', release_group: 'FraMeSToR' }],
  ['Show.S01E01.720p.WEB.h264-GROUP[rarbg]', { quality: '720p', codec: 'AVC', release_group: 'GROUP' }],
  ['Movie.2024.HDCAM.x264', { quality: 'CAM', release_group: null }],
  ['Old.Movie.1995.DVDRip.XviD-FXG', { quality: '480p', codec: 'XviD', release_group: 'FXG' }],
  ['Movie 2020 AV1 Opus 2.0 1080p', { codec: 'AV1', channels: '2.0' }],
  ['Tron 2.0 Documentary 2003', { channels: null }], // "2.0" suelto no es audio
  ['Movie.2020.1080p.WEB-DL.x265', { release_group: null }], // "-DL" / x265 no son grupo
];

for (const [title, expected] of cases) {
  test(`extractMetadata: ${title}`, () => {
    const meta = extractMetadata(title);
    for (const [k, v] of Object.entries(expected)) assert.equal(meta[k], v, `${k}`);
  });
}

test("computeMetadataPatch: rellena 'Unknown' y NULL, nunca sobrescribe", () => {
  const patch = computeMetadataPatch({
    title: 'Movie.2024.2160p.WEB-DL.DDP5.1.HEVC-GRP', quality: 'Unknown', codec: 'x265', hdr_format: null, channels: null, release_group: null,
  });
  assert.deepEqual(patch, { quality: '2160p', channels: '5.1', release_group: 'GRP' }); // codec existente intacto
});

test('computeMetadataPatch: nada que rellenar → null', () => {
  assert.equal(computeMetadataPatch({ title: 'Some Movie 2020', quality: 'Unknown' }), null);
});

test('respeta longitudes de columna (varchar)', () => {
  const meta = extractMetadata(`[${'G'.repeat(59)}] Show - 01 [1080p]`);
  assert.ok(meta.release_group.length <= 100);
});
