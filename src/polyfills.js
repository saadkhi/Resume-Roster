import fs from 'fs';
import path from 'path';

/**
 * Serverless & Node.js Runtime Polyfills & Environment Initializer
 */

// Load .env and .env.local if present
try {
  const envFiles = ['.env', '.env.local'];
  for (const file of envFiles) {
    const fullPath = path.resolve(process.cwd(), file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (key && !process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    }
  }
} catch (e) {
  // Ignore in restricted environments
}

// 1. Suppress benign warning about @napi-rs/canvas in headless environments
const originalWarn = console.warn;
console.warn = function (...args) {
  if (typeof args[0] === 'string' && args[0].includes('@napi-rs/canvas')) {
    return; // Suppress optional canvas loading warning
  }
  return originalWarn.apply(this, args);
};

// 2. DOMMatrix Polyfill
if (!globalThis.DOMMatrix) {
  class DOMMatrixPolyfill {
    constructor(init) {
      this.is2D = true;
      this.isIdentity = true;

      // 2D affine properties
      this.a = 1;
      this.b = 0;
      this.c = 0;
      this.d = 1;
      this.e = 0;
      this.f = 0;

      // 4x4 matrix representation
      this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
      this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;

      if (Array.isArray(init)) {
        if (init.length === 6) {
          this.a = this.m11 = init[0];
          this.b = this.m12 = init[1];
          this.c = this.m21 = init[2];
          this.d = this.m22 = init[3];
          this.e = this.m41 = init[4];
          this.f = this.m42 = init[5];
        } else if (init.length === 16) {
          this.m11 = init[0];  this.m12 = init[1];  this.m13 = init[2];  this.m14 = init[3];
          this.m21 = init[4];  this.m22 = init[5];  this.m23 = init[6];  this.m24 = init[7];
          this.m31 = init[8];  this.m32 = init[9];  this.m33 = init[10]; this.m34 = init[11];
          this.m41 = init[12]; this.m42 = init[13]; this.m43 = init[14]; this.m44 = init[15];
          this.a = this.m11; this.b = this.m12; this.c = this.m21; this.d = this.m22;
          this.e = this.m41; this.f = this.m42;
          this.is2D = false;
        }
      } else if (init && typeof init === 'object') {
        if ('a' in init) {
          this.a = this.m11 = init.a;
          this.b = this.m12 = init.b;
          this.c = this.m21 = init.c;
          this.d = this.m22 = init.d;
          this.e = this.m41 = init.e;
          this.f = this.m42 = init.f;
        }
      }
    }

    multiply(other) {
      return new DOMMatrixPolyfill(this).multiplySelf(other);
    }

    multiplySelf(other) {
      if (!other) return this;
      const oA = other.a ?? other.m11 ?? 1;
      const oB = other.b ?? other.m12 ?? 0;
      const oC = other.c ?? other.m21 ?? 0;
      const oD = other.d ?? other.m22 ?? 1;
      const oE = other.e ?? other.m41 ?? 0;
      const oF = other.f ?? other.m42 ?? 0;

      const a = this.a * oA + this.c * oB;
      const b = this.b * oA + this.d * oB;
      const c = this.a * oC + this.c * oD;
      const d = this.b * oC + this.d * oD;
      const e = this.a * oE + this.c * oF + this.e;
      const f = this.b * oE + this.d * oF + this.f;

      this.a = this.m11 = a;
      this.b = this.m12 = b;
      this.c = this.m21 = c;
      this.d = this.m22 = d;
      this.e = this.m41 = e;
      this.f = this.m42 = f;
      return this;
    }

    preMultiplySelf(other) {
      if (!other) return this;
      const oA = other.a ?? other.m11 ?? 1;
      const oB = other.b ?? other.m12 ?? 0;
      const oC = other.c ?? other.m21 ?? 0;
      const oD = other.d ?? other.m22 ?? 1;
      const oE = other.e ?? other.m41 ?? 0;
      const oF = other.f ?? other.m42 ?? 0;

      const a = oA * this.a + oC * this.b;
      const b = oB * this.a + oD * this.b;
      const c = oA * this.c + oC * this.d;
      const d = oB * this.c + oD * this.d;
      const e = oA * this.e + oC * this.f + oE;
      const f = oB * this.e + oD * this.f + oF;

      this.a = this.m11 = a;
      this.b = this.m12 = b;
      this.c = this.m21 = c;
      this.d = this.m22 = d;
      this.e = this.m41 = e;
      this.f = this.m42 = f;
      return this;
    }

    translate(tx = 0, ty = 0) {
      return new DOMMatrixPolyfill(this).translateSelf(tx, ty);
    }

    translateSelf(tx = 0, ty = 0) {
      this.e += this.a * tx + this.c * ty;
      this.f += this.b * tx + this.d * ty;
      this.m41 = this.e;
      this.m42 = this.f;
      return this;
    }

    scale(scaleX = 1, scaleY = scaleX) {
      return new DOMMatrixPolyfill(this).scaleSelf(scaleX, scaleY);
    }

    scaleSelf(scaleX = 1, scaleY = scaleX) {
      this.a *= scaleX;
      this.b *= scaleX;
      this.c *= scaleY;
      this.d *= scaleY;
      this.m11 = this.a;
      this.m12 = this.b;
      this.m21 = this.c;
      this.m22 = this.d;
      return this;
    }

    rotate(angle = 0) {
      return new DOMMatrixPolyfill(this).rotateSelf(angle);
    }

    rotateSelf(angle = 0) {
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const a = this.a * cos + this.c * sin;
      const b = this.b * cos + this.d * sin;
      const c = this.a * -sin + this.c * cos;
      const d = this.b * -sin + this.d * cos;
      this.a = this.m11 = a;
      this.b = this.m12 = b;
      this.c = this.m21 = c;
      this.d = this.m22 = d;
      return this;
    }

    inverse() {
      return new DOMMatrixPolyfill(this).invertSelf();
    }

    invertSelf() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return this;
      const invDet = 1 / det;
      const a = this.d * invDet;
      const b = -this.b * invDet;
      const c = -this.c * invDet;
      const d = this.a * invDet;
      const e = (this.c * this.f - this.d * this.e) * invDet;
      const f = (this.b * this.e - this.a * this.f) * invDet;
      this.a = this.m11 = a;
      this.b = this.m12 = b;
      this.c = this.m21 = c;
      this.d = this.m22 = d;
      this.e = this.m41 = e;
      this.f = this.m42 = f;
      return this;
    }

    transformPoint(point = { x: 0, y: 0 }) {
      const x = point.x ?? 0;
      const y = point.y ?? 0;
      return {
        x: x * this.a + y * this.c + this.e,
        y: x * this.b + y * this.d + this.f,
        z: 0,
        w: 1
      };
    }
  }

  globalThis.DOMMatrix = DOMMatrixPolyfill;
  globalThis.DOMMatrixReadOnly = DOMMatrixPolyfill;
}

// 3. ImageData Polyfill
if (!globalThis.ImageData) {
  class ImageDataPolyfill {
    constructor(arg1, arg2, arg3) {
      if (typeof arg1 === 'number') {
        this.width = arg1;
        this.height = arg2 || 0;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      } else if (arg1 instanceof Uint8ClampedArray) {
        this.data = arg1;
        this.width = arg2 || 0;
        this.height = arg3 || (this.data.length / (this.width * 4));
      } else {
        this.width = 0;
        this.height = 0;
        this.data = new Uint8ClampedArray(0);
      }
      this.colorSpace = 'srgb';
    }
  }
  globalThis.ImageData = ImageDataPolyfill;
}

// 4. Path2D Polyfill
if (!globalThis.Path2D) {
  class Path2DPolyfill {
    constructor() {
      this.commands = [];
    }
    addPath(path, transform) {
      this.commands.push({ type: 'addPath', path, transform });
    }
    closePath() { this.commands.push({ type: 'closePath' }); }
    moveTo(x, y) { this.commands.push({ type: 'moveTo', x, y }); }
    lineTo(x, y) { this.commands.push({ type: 'lineTo', x, y }); }
    bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
      this.commands.push({ type: 'bezierCurveTo', cp1x, cp1y, cp2x, cp2y, x, y });
    }
    quadraticCurveTo(cpx, cpy, x, y) {
      this.commands.push({ type: 'quadraticCurveTo', cpx, cpy, x, y });
    }
    arc(x, y, radius, startAngle, endAngle, counterclockwise) {
      this.commands.push({ type: 'arc', x, y, radius, startAngle, endAngle, counterclockwise });
    }
    arcTo(x1, y1, x2, y2, radius) {
      this.commands.push({ type: 'arcTo', x1, y1, x2, y2, radius });
    }
    ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise) {
      this.commands.push({ type: 'ellipse', x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise });
    }
    rect(x, y, w, h) {
      this.commands.push({ type: 'rect', x, y, w, h });
    }
  }
  globalThis.Path2D = Path2DPolyfill;
}

// 5. PDF.js fake worker hook for headless serverless environments (e.g. Vercel)
try {
  const pdfjsWorker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  if (pdfjsWorker && (pdfjsWorker.WorkerMessageHandler || pdfjsWorker.default?.WorkerMessageHandler)) {
    globalThis.pdfjsWorker = pdfjsWorker;
  }
} catch (err) {
  // best effort
}

export default {
  DOMMatrix: globalThis.DOMMatrix,
  ImageData: globalThis.ImageData,
  Path2D: globalThis.Path2D,
  pdfjsWorker: globalThis.pdfjsWorker
};
