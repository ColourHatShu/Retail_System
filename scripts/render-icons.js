const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function createPng(width, height, rgbaPixelFn) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData.writeUInt8(8, 8); // 8-bit
  ihdrData.writeUInt8(6, 9); // RGBA
  ihdrData.writeUInt8(0, 10);
  ihdrData.writeUInt8(0, 11);
  ihdrData.writeUInt8(0, 12);
  const ihdr = makeChunk('IHDR', ihdrData);

  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // None filter
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = rgbaPixelFn(x, y, width, height);
      const pxOffset = rowOffset + 1 + x * 4;
      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const idatData = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', idatData);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Draw a modern sleek retail icon
function renderPixel(x, y, width, height, isMaskable = false) {
  const nx = x / width;
  const ny = y / height;

  // Background color: #09090b
  let r = 9;
  let g = 9;
  let b = 11;
  let a = 255;

  if (!isMaskable) {
    // Rounded corner mask for regular icons (radius ~ 22%)
    const cornerR = 0.22;
    const dx = Math.min(nx, 1 - nx);
    const dy = Math.min(ny, 1 - ny);
    if (dx < cornerR && dy < cornerR) {
      const dist = Math.hypot(cornerR - dx, cornerR - dy);
      if (dist > cornerR) {
        return [0, 0, 0, 0];
      }
    }
  }

  // Emerald center glow around (0.5, 0.48)
  const glowDist = Math.hypot(nx - 0.5, ny - 0.48);
  if (glowDist < 0.45) {
    const glow = Math.max(0, 1 - glowDist / 0.45);
    r = Math.min(255, Math.round(r + glow * 25));
    g = Math.min(255, Math.round(g + glow * 80));
    b = Math.min(255, Math.round(b + glow * 45));
  }

  // Store awning roof (y from 0.32 to 0.46, x from 0.22 to 0.78)
  if (ny >= 0.30 && ny <= 0.34 && nx >= 0.20 && nx <= 0.80) {
    // Top roof bar: emerald green #34d399
    r = 52; g = 211; b = 153; a = 255;
  } else if (ny > 0.34 && ny <= 0.46 && nx >= 0.23 && nx <= 0.77) {
    // Awning stripes
    const stripe = Math.floor((nx - 0.23) * 12);
    if (stripe % 2 === 0) {
      // Emerald #10b981
      r = 16; g = 185; b = 129; a = 255;
    } else {
      // White stripe
      r = 244; g = 244; b = 245; a = 255;
    }
  }

  // Pillars (y from 0.46 to 0.68)
  const isPillarLeft = nx >= 0.27 && nx <= 0.33;
  const isPillarMid = nx >= 0.47 && nx <= 0.53;
  const isPillarRight = nx >= 0.67 && nx <= 0.73;
  if (ny > 0.46 && ny <= 0.68) {
    if (isPillarLeft || isPillarMid || isPillarRight) {
      r = 161; g = 161; b = 170; a = 255;
    }
  }

  // Base platform (y from 0.68 to 0.72, x from 0.22 to 0.78)
  if (ny > 0.68 && ny <= 0.72 && nx >= 0.22 && nx <= 0.78) {
    r = 228; g = 228; b = 231; a = 255;
  }

  // Barcode lines between pillars (y from 0.51 to 0.63, x from 0.36 to 0.64)
  if (ny >= 0.51 && ny <= 0.63 && nx >= 0.36 && nx <= 0.64) {
    const bPos = (nx - 0.36) / 0.28;
    const barIndex = Math.floor(bPos * 20);
    // Discrete barcode pattern
    const pattern = [1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
    if (pattern[barIndex]) {
      r = 52; g = 211; b = 153; a = 255;
    }
  }

  // Red Laser scanner line across barcode (ny around 0.57)
  if (Math.abs(ny - 0.57) < 0.008 && nx >= 0.32 && nx <= 0.68) {
    r = 244; g = 63; b = 94; a = 255; // #f43f5e
  }

  return [r, g, b, a];
}

const outDir = path.join(__dirname, '..', 'client', 'public');

const icon192 = createPng(192, 192, (x, y, w, h) => renderPixel(x, y, w, h, false));
fs.writeFileSync(path.join(outDir, 'icon-192.png'), icon192);
console.log('Saved icon-192.png (' + icon192.length + ' bytes)');

const icon512 = createPng(512, 512, (x, y, w, h) => renderPixel(x, y, w, h, false));
fs.writeFileSync(path.join(outDir, 'icon-512.png'), icon512);
console.log('Saved icon-512.png (' + icon512.length + ' bytes)');

const iconMaskable = createPng(512, 512, (x, y, w, h) => renderPixel(x, y, w, h, true));
fs.writeFileSync(path.join(outDir, 'icon-maskable.png'), iconMaskable);
console.log('Saved icon-maskable.png (' + iconMaskable.length + ' bytes)');

const appleIcon = createPng(180, 180, (x, y, w, h) => renderPixel(x, y, w, h, true));
fs.writeFileSync(path.join(outDir, 'apple-touch-icon.png'), appleIcon);
console.log('Saved apple-touch-icon.png (' + appleIcon.length + ' bytes)');
