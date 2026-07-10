import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Jimp = require('jimp-compact');
const { PNG } = require('pngjs');

const root = path.resolve(import.meta.dirname, '..');
const assetsDir = path.join(root, 'assets');
const chromaArgumentIndex = process.argv.indexOf('--source-chroma');
const chromaSource = chromaArgumentIndex >= 0
  ? path.resolve(root, process.argv[chromaArgumentIndex + 1] ?? '')
  : null;

const brandMarkPath = path.join(assetsDir, 'brand-mark.png');

function clamp(value, min = 0, max = 255) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value) {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

function colorDistance(r, g, b, key) {
  return Math.hypot(r - key[0], g - key[1], b - key[2]);
}

function dominantBorderColor(png) {
  const counts = new Map();
  const sample = (x, y) => {
    const offset = (y * png.width + x) * 4;
    const key = (png.data[offset] << 16) | (png.data[offset + 1] << 8) | png.data[offset + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (let x = 0; x < png.width; x += 1) {
    sample(x, 0);
    sample(x, png.height - 1);
  }
  for (let y = 1; y < png.height - 1; y += 1) {
    sample(0, y);
    sample(png.width - 1, y);
  }

  const [color] = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return [(color >> 16) & 255, (color >> 8) & 255, color & 255];
}

function removeChromaBackground(sourcePath) {
  const source = PNG.sync.read(fs.readFileSync(sourcePath));
  const output = new PNG({ width: source.width, height: source.height });
  const key = dominantBorderColor(source);
  const pixelCount = source.width * source.height;
  const alpha = new Uint8Array(pixelCount);
  const owner = new Int32Array(pixelCount);
  owner.fill(-1);

  // The generated source uses an intentionally flat hot-magenta screen.
  // Keep similarly coloured artwork opaque once it is outside the narrow
  // antialias band instead of applying a global colour-to-alpha conversion.
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const distance = colorDistance(
      source.data[offset],
      source.data[offset + 1],
      source.data[offset + 2],
      key
    );
    const opacity = smoothstep((distance - 14) / 42);
    alpha[pixel] = Math.round(opacity * 255);
    if (alpha[pixel] >= 250) {
      owner[pixel] = pixel;
    }
  }

  // Bleed the nearest opaque ribbon colour a few pixels beneath transparent
  // edges. This keeps bicubic scaling free of magenta or dark halos.
  let frontier = owner;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = new Int32Array(frontier);
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const pixel = y * source.width + x;
        if (frontier[pixel] >= 0) {
          continue;
        }
        for (let dy = -1; dy <= 1 && next[pixel] < 0; dy += 1) {
          const sampleY = y + dy;
          if (sampleY < 0 || sampleY >= source.height) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx += 1) {
            const sampleX = x + dx;
            if (sampleX < 0 || sampleX >= source.width || (dx === 0 && dy === 0)) {
              continue;
            }
            const sampleOwner = frontier[sampleY * source.width + sampleX];
            if (sampleOwner >= 0) {
              next[pixel] = sampleOwner;
              break;
            }
          }
        }
      }
    }
    frontier = next;
  }

  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const colorOwner = frontier[pixel];
    if (colorOwner >= 0) {
      const colorOffset = colorOwner * 4;
      output.data[offset] = source.data[colorOffset];
      output.data[offset + 1] = source.data[colorOffset + 1];
      output.data[offset + 2] = source.data[colorOffset + 2];
    } else {
      output.data[offset] = 0;
      output.data[offset + 1] = 0;
      output.data[offset + 2] = 0;
    }
    output.data[offset + 3] = alpha[pixel];
  }

  return Jimp.read(PNG.sync.write(output));
}

function alphaBounds(image, threshold = 128) {
  const { width, height, data } = image.bitmap;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= threshold) {
        continue;
      }
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }

  if (right < left || bottom < top) {
    throw new Error('Brand mark contains no visible pixels.');
  }
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function rgba(r, g, b, a = 255) {
  return ((clamp(r) << 24) | (clamp(g) << 16) | (clamp(b) << 8) | clamp(a)) >>> 0;
}

function lerp(left, right, amount) {
  return left + (right - left) * amount;
}

function createBackground(size) {
  const image = new Jimp(size, size, rgba(247, 246, 244));
  image.scan(0, 0, size, size, function scanBackground(x, y, index) {
    const diagonal = (x + y) / (2 * (size - 1));
    const cyanGlow = Math.max(0, 1 - Math.hypot(x / size - 0.78, y / size - 0.2) / 0.75);
    const violetGlow = Math.max(0, 1 - Math.hypot(x / size - 0.18, y / size - 0.82) / 0.8);
    const vignette = Math.min(1, Math.hypot(x / size - 0.5, y / size - 0.5) / 0.72);

    this.bitmap.data[index] = Math.round(clamp(lerp(249, 233, diagonal) - vignette * 2));
    this.bitmap.data[index + 1] = Math.round(clamp(lerp(248, 235, diagonal) + cyanGlow * 4));
    this.bitmap.data[index + 2] = Math.round(clamp(lerp(246, 250, diagonal) + cyanGlow * 8 + violetGlow * 5));
    this.bitmap.data[index + 3] = 255;
  });
  return image;
}

function fittedMark(mark, canvasSize, targetHeight) {
  const copy = mark.clone();
  copy.resize(Jimp.AUTO, targetHeight, Jimp.RESIZE_BICUBIC);
  const canvas = new Jimp(canvasSize, canvasSize, 0x00000000);
  const x = Math.round((canvasSize - copy.bitmap.width) / 2);
  const y = Math.round((canvasSize - copy.bitmap.height) / 2);
  canvas.composite(copy, x, y);
  return canvas;
}

function forceOpaque(image) {
  image.scan(0, 0, image.bitmap.width, image.bitmap.height, function setOpaque(_x, _y, index) {
    this.bitmap.data[index + 3] = 255;
  });
  return image;
}

async function write(image, filename) {
  await image.writeAsync(path.join(assetsDir, filename));
}

async function main() {
  fs.mkdirSync(assetsDir, { recursive: true });

  let mark;
  if (chromaSource) {
    if (!fs.existsSync(chromaSource)) {
      throw new Error(`Missing chroma source: ${chromaSource}`);
    }
    mark = await removeChromaBackground(chromaSource);
    const importedBounds = alphaBounds(mark);
    mark.crop(importedBounds.left, importedBounds.top, importedBounds.width, importedBounds.height);

    const normalizedMark = fittedMark(mark, 1024, 884);
    await write(normalizedMark, 'brand-mark.png');
    mark = normalizedMark;
  } else {
    mark = await Jimp.read(brandMarkPath);
  }

  const bounds = alphaBounds(mark);
  mark.crop(bounds.left, bounds.top, bounds.width, bounds.height);

  const icon = createBackground(1024);
  icon.composite(fittedMark(mark, 1024, 748), 0, 0);
  await write(forceOpaque(icon), 'icon.png');

  // Android adaptive icons reserve only the centered 66dp circle of a 108dp
  // layer for content that must survive every launcher mask and animation.
  await write(fittedMark(mark, 1024, 580), 'android-icon-foreground.png');
  await write(createBackground(1024), 'android-icon-background.png');

  const monochrome = fittedMark(mark, 1024, 580);
  monochrome.scan(0, 0, monochrome.bitmap.width, monochrome.bitmap.height, function makeMonochrome(_x, _y, index) {
    this.bitmap.data[index] = 255;
    this.bitmap.data[index + 1] = 255;
    this.bitmap.data[index + 2] = 255;
  });
  await write(monochrome, 'android-icon-monochrome.png');

  await write(fittedMark(mark, 1024, 902), 'splash-icon.png');

  const favicon = createBackground(96);
  favicon.composite(fittedMark(mark, 96, 74), 0, 0);
  await write(forceOpaque(favicon), 'favicon.png');
}

await main();
