var ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function decodeBase58(value) {
  if (typeof value !== "string" || value.length < 32 || value.length > 88) return null;
  var result = [0];
  for (var c = 0; c < value.length; c += 1) {
    var digit = ALPHABET.indexOf(value.charAt(c));
    if (digit < 0) return null;
    var carry = digit;
    for (var i = 0; i < result.length; i += 1) {
      carry += result[i] * 58;
      result[i] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      result.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }
  var zeros = 0;
  for (var z = 0; z < value.length; z += 1) {
    if (value.charAt(z) !== "1") break;
    zeros += 1;
  }
  var out = new Uint8Array(zeros + result.length);
  for (var j = 0; j < result.length; j += 1) out[out.length - 1 - j] = result[j];
  return out;
}

export function encodeBase58(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) return "";
  var zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  var digits = [0];
  for (var i = zeros; i < bytes.length; i += 1) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  var text = "";
  for (var z = 0; z < zeros; z += 1) text += "1";
  for (var k = digits.length - 1; k >= 0; k -= 1) text += ALPHABET.charAt(digits[k]);
  return text;
}

function shortVec(bytes, offset) {
  var len = 0;
  var size = 0;
  var shift = 0;
  while (offset + size < bytes.length && size < 3) {
    var elem = bytes[offset + size];
    len |= (elem & 0x7f) << shift;
    size += 1;
    if ((elem & 0x80) === 0) return { len: len, next: offset + size };
    shift += 7;
  }
  return null;
}

function sameBytes(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
  return true;
}

export function readVersionedTransaction(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 100) return { ok: false, reason: "bytes" };
  var count = shortVec(bytes, 0);
  if (!count) return { ok: false, reason: "bytes" };
  if (count.len !== 1) return { ok: false, reason: "signer-count", signerCount: count.len };
  var sigStart = count.next;
  if (sigStart + 64 > bytes.length) return { ok: false, reason: "bytes" };
  var signature = bytes.slice(sigStart, sigStart + 64);
  var cursor = sigStart + 64;
  if (cursor >= bytes.length) return { ok: false, reason: "bytes" };
  var prefix = bytes[cursor];
  var versioned = (prefix & 0x80) !== 0;
  if (!versioned) return { ok: false, reason: "version" };
  if ((prefix & 0x7f) !== 0) return { ok: false, reason: "version" };
  cursor += 1;
  if (cursor + 3 > bytes.length) return { ok: false, reason: "bytes" };
  var required = bytes[cursor];
  if (required !== 1) return { ok: false, reason: "signer-count", signerCount: required };
  cursor += 3;
  var keys = shortVec(bytes, cursor);
  if (!keys || keys.len < 1) return { ok: false, reason: "accounts" };
  cursor = keys.next;
  if (cursor + keys.len * 32 > bytes.length) return { ok: false, reason: "accounts" };
  var feePayer = bytes.slice(cursor, cursor + 32);
  return {
    ok: true,
    versioned: true,
    signerCount: 1,
    signature: signature,
    feePayer: feePayer,
    accountCount: keys.len,
  };
}

export function reviewTransaction(bytes, taker) {
  var read = readVersionedTransaction(bytes);
  if (!read.ok) return read;
  var key = decodeBase58(taker);
  if (!key || key.length !== 32) return { ok: false, reason: "taker" };
  if (!sameBytes(read.feePayer, key)) return { ok: false, reason: "fee-payer" };
  var blank = true;
  for (var i = 0; i < read.signature.length; i += 1) if (read.signature[i] !== 0) blank = false;
  return { ok: true, signerCount: 1, feePayerMatches: true, signed: !blank, signature: read.signature };
}

export function signatureLink(bytes) {
  var read = readVersionedTransaction(bytes);
  if (!read.ok || read.signerCount !== 1) return null;
  var blank = true;
  for (var i = 0; i < read.signature.length; i += 1) if (read.signature[i] !== 0) blank = false;
  if (blank || read.signature.length !== 64) return null;
  return "https://solscan.io/tx/" + encodeBase58(read.signature);
}
