import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodePayload,
  formatReceivedPayload,
  formatReceivedPayloadPreview,
  toHexPreview,
} from '../src/payloadCodec.js';

describe('payloadCodec', () => {
  it('encodes text payload as UTF-8 bytes for HEX sending', () => {
    const encoded = encodePayload('Hi 中', 'hex');

    assert.ok(encoded.payload instanceof Uint8Array);
    assert.equal(encoded.byteLength, 6);
    assert.equal(toHexPreview(encoded.payload, 12).text, '48 69 20 E4 B8 AD');
  });

  it('keeps original text when sending as plain payload', () => {
    const encoded = encodePayload('hello', 'plain');

    assert.equal(encoded.payload, 'hello');
    assert.equal(encoded.byteLength, 5);
  });

  it('truncates long HEX previews and keeps total byte count', () => {
    const preview = toHexPreview(new Uint8Array([1, 2, 3, 4]), 3);

    assert.deepEqual(preview, { text: '01 02 03 ...', totalBytes: 4, truncated: true });
  });

  it('formats received payload by subscription display format', () => {
    assert.equal(formatReceivedPayload('{"ok":true}', 'json'), '{\n  "ok": true\n}');
    assert.equal(formatReceivedPayload('plain text', 'json'), 'plain text');
    assert.equal(formatReceivedPayload('plain text', 'text'), 'plain text');
    assert.equal(formatReceivedPayload('plain text', 'hex', '706c61696e'), '70 6C 61 69 6E');
  });

  it('skips received JSON formatting when disabled or payload is too large', () => {
    assert.equal(formatReceivedPayload('{"ok":true}', 'json', '', { autoFormatJson: false }), '{"ok":true}');
    assert.equal(formatReceivedPayload('{"ok":true}', 'json', '', { maxFormatBytes: 4 }), '{"ok":true}');
  });

  it('limits large realtime payload previews while preserving the complete byte count', () => {
    const payload = JSON.stringify({ settings: { enabled: true }, content: 'x'.repeat(23000) });
    const totalBytes = new TextEncoder().encode(payload).length;

    const preview = formatReceivedPayloadPreview(payload, 'json', '', {
      autoFormatJson: true,
      maxFormatBytes: 65536,
      maxDisplayBytes: 16384,
      byteLength: totalBytes,
    });

    assert.equal(preview.truncated, true);
    assert.equal(preview.totalBytes, totalBytes);
    assert.ok(new TextEncoder().encode(preview.text).length <= 16384);
    assert.doesNotMatch(preview.text, /\n\s+"settings"/);
  });

  it('formats Uint8Array payloads directly as decoded text and raw HEX', () => {
    const payload = new Uint8Array([0x6f, 0x6b]);

    assert.deepEqual(formatReceivedPayloadPreview(payload, 'text'), {
      text: 'ok',
      totalBytes: 2,
      truncated: false,
    });
    assert.deepEqual(formatReceivedPayloadPreview(payload, 'hex'), {
      text: '6F 6B',
      totalBytes: 2,
      truncated: false,
    });
    assert.deepEqual(payload, new Uint8Array([0x6f, 0x6b]));
  });

  it('decodes and formats JSON supplied as Uint8Array bytes', () => {
    const payload = new TextEncoder().encode('{"ok":true}');

    assert.equal(formatReceivedPayload(payload, 'json'), '{\n  "ok": true\n}');
  });

  it('preserves raw non-UTF8 bytes while text decoding uses deterministic replacement', () => {
    const payload = new Uint8Array([0xff, 0x00, 0x6b]);

    assert.equal(formatReceivedPayload(payload, 'text'), '\uFFFD\0k');
    assert.equal(formatReceivedPayload(payload, 'hex'), 'FF 00 6B');
    assert.equal(formatReceivedPayload(payload, 'hex', 'aabb'), 'AA BB');
    assert.deepEqual(payload, new Uint8Array([0xff, 0x00, 0x6b]));
  });

  it('keeps authoritative byteLength metadata while truncating actual source bytes', () => {
    const payload = new Uint8Array([0x61, 0x62, 0x63]);

    assert.deepEqual(formatReceivedPayloadPreview(payload, 'text', '', {
      byteLength: 9,
      maxDisplayBytes: 2,
    }), {
      text: 'ab',
      totalBytes: 9,
      truncated: true,
    });
    assert.equal(formatReceivedPayloadPreview(payload, 'text', '', { byteLength: -1 }).totalBytes, 3);
    assert.equal(formatReceivedPayloadPreview(payload, 'text', '', { byteLength: Number.NaN }).totalBytes, 3);
  });
});
