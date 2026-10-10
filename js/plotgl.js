/* WebGL2 renderer for compiled plots (see plotcompile.js).
 *
 * One instanced draw per chunk: every instance is either a line segment,
 * expanded to a quad in the vertex shader so its width is in screen
 * pixels, or a triangle. They share a format so that fills and strokes
 * stay in the order the page painted them. Antialiasing is the
 * framebuffer's multisampling, which — unlike blending soft edges — leaves
 * no seams between shapes that merely touch.
 *
 * Residual layers arrive as textures and are drawn between the groups.
 * Rectangular clips are scissors; other clips are drawn into stencil bits.
 */
import { STRIDE } from './plotcompile.js';

const VS = `#version 300 es
layout(location=0) in vec4 a_p01;
layout(location=1) in vec2 a_p2;
layout(location=2) in vec4 a_col;
layout(location=3) in vec2 a_wf;          // width in 1/64 pt, flags
uniform vec3 u_chunk;                     // origin x, origin y, pt per unit
uniform mat2 u_m; uniform vec2 u_t;       // page pt -> target px, y down
uniform vec2 u_view;                      // target size in px
uniform float u_pxPerPt;
uniform float u_minW;                     // thinnest line, px
out vec4 v_col;
out vec4 v_cap;                           // along, across, length, half width
flat out float v_round;
void main() {
  vec2 p0 = u_m * (u_chunk.xy + a_p01.xy * u_chunk.z) + u_t;
  vec2 p1 = u_m * (u_chunk.xy + a_p01.zw * u_chunk.z) + u_t;
  int flags = int(a_wf.y);
  int id = gl_VertexID;
  vec2 pos;
  v_cap = vec4(0.0);
  v_round = 0.0;
  v_col = a_col;
  if ((flags & 1) != 0) {
    vec2 p2 = u_m * (u_chunk.xy + a_p2 * u_chunk.z) + u_t;
    pos = id == 0 ? p0 : (id == 1 ? p1 : p2);
  } else {
    vec2 d = p1 - p0;
    float len = length(d);
    vec2 dir = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 nrm = vec2(-dir.y, dir.x);
    // No line is thinner than a pixel, and none is faded to make up for
    // it. That reads darker than paper when zoomed far out, but it is what
    // pdf.js, Preview and Acrobat all do, and so what a sheet is expected
    // to look like on screen.
    float hw = max(a_wf.x / 64.0 * u_pxPerPt, u_minW) * 0.5;
    float e0 = (flags & 2) != 0 ? hw : 0.0;
    float e1 = (flags & 4) != 0 ? hw : 0.0;
    float along = (id & 1) == 1 ? len + e1 : -e0;
    float side = id < 2 ? hw : -hw;
    pos = p0 + dir * along + nrm * side;
    v_cap = vec4(along, side, len, hw);
    // Below a couple of pixels a round end is indistinguishable from a
    // square one, and the fragment shader can skip the arithmetic.
    v_round = hw > 1.25 ? 1.0 : 0.0;
  }
  gl_Position = vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
in vec4 v_col;
in vec4 v_cap;
flat in float v_round;
out vec4 o;
void main() {
  float a = v_col.a;
  if (v_round > 0.5) {
    float over = v_cap.x < 0.0 ? -v_cap.x : max(v_cap.x - v_cap.z, 0.0);
    if (over > 0.0) a *= clamp(v_cap.w - length(vec2(over, v_cap.y)) + 0.5, 0.0, 1.0);
  }
  o = vec4(v_col.rgb * a, a);
}`;

// Plain positions: clip regions into the stencil, and textured quads.
const QUAD_VS = `#version 300 es
layout(location=0) in vec2 a_pos;
layout(location=1) in vec2 a_uv;
uniform mat2 u_m; uniform vec2 u_t; uniform vec2 u_view;
out vec2 v_uv;
void main() {
  vec2 pos = u_m * a_pos + u_t;
  v_uv = a_uv;
  gl_Position = vec4(pos.x / u_view.x * 2.0 - 1.0, 1.0 - pos.y / u_view.y * 2.0, 0.0, 1.0);
}`;
const QUAD_FS = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_textured;
in vec2 v_uv;
out vec4 o;
void main() { o = u_textured > 0.5 ? texture(u_tex, v_uv) : vec4(0.0); }`;

const SCRATCH_BIT = 0x80;          // stencil bit used while intersecting clips
const CLIP_SLOTS = 7;              // the other bits each hold one clip region

function program(gl, vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

/** Returns null where WebGL2 is not to be had. */
export function createPlotRenderer(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: true, alpha: false, depth: false, stencil: true,
    premultipliedAlpha: true, preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) return null;

  let inst, quad, quadVao, quadBuf;
  let lost = false;
  const resetListeners = [];

  function init() {
    inst = program(gl, VS, FS);
    quad = program(gl, QUAD_VS, QUAD_FS);
    quadVao = gl.createVertexArray();
    quadBuf = gl.createBuffer();
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  }
  init();

  // Everything on the GPU dies with the context. The owner is told, drops
  // its pages, and compiles them again on demand.
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); lost = true; });
  canvas.addEventListener('webglcontextrestored', () => {
    lost = false;
    fbo = null;
    init();
    for (const fn of resetListeners) fn();
  });

  // ---------- page geometry ----------
  function createPage() {
    return {
      chunks: [], polys: new Map(), clips: new Map(), layers: [], text: null,
      overview: null,       // the whole page as one texture, text excluded
      version: 0,           // bumped whenever what it would draw changes
      bytes: 0,
    };
  }

  function addChunk(page, c) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, c.buffer, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.UNSIGNED_SHORT, false, STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, false, STRIDE, 8);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 12);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.UNSIGNED_SHORT, false, STRIDE, 16);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
    // One object per distinct clip, however many messages it arrived in:
    // the draw loop tells clips apart by identity.
    let clip = null;
    if (c.clipId) {
      clip = page.clips.get(c.clipId);
      if (!clip) page.clips.set(c.clipId, clip = c.clip);
    }
    page.chunks.push({
      vao, buf, count: c.count, group: c.group,
      x0: c.x0, y0: c.y0, unit: c.span / 65535,
      bbox: c.bbox, clip,
    });
    page.bytes += c.buffer.byteLength;
    page.version++;
  }

  function addClipPoly(page, id, tris) {
    const vao = gl.createVertexArray();
    const buf = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, tris, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    page.polys.set(id, { vao, buf, n: tris.length / 2 });
  }

  function makeTexture(source) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** A residual layer's bitmap. `rect` is the page-space box the bitmap
   *  covers; its top row is the top of that box. */
  function setLayer(page, index, source, rect) {
    const old = page.layers[index];
    if (old) gl.deleteTexture(old.tex);
    page.layers[index] = source ? { tex: makeTexture(source), rect } : null;
    page.version++;
  }

  /** The text layer has two bitmaps: a modest one of the whole page, and
   *  a sharp one of wherever the view last came to rest. */
  function setText(page, which, source, rect, pxPerPt) {
    if (!page.text) page.text = { base: null, detail: null };
    const old = page.text[which];
    if (old) gl.deleteTexture(old.tex);
    page.text[which] = source ? { tex: makeTexture(source), rect, pxPerPt } : null;
    page.version++;
  }

  function releasePage(page) {
    if (!page) return;
    if (!lost) {
      for (const c of page.chunks) { gl.deleteVertexArray(c.vao); gl.deleteBuffer(c.buf); }
      for (const p of page.polys.values()) { gl.deleteVertexArray(p.vao); gl.deleteBuffer(p.buf); }
      for (const l of page.layers) if (l) gl.deleteTexture(l.tex);
      if (page.text) for (const k of ['base', 'detail']) if (page.text[k]) gl.deleteTexture(page.text[k].tex);
      if (page.overview) gl.deleteTexture(page.overview.tex);
    }
    page.chunks = []; page.polys = new Map(); page.clips = new Map();
    page.layers = []; page.text = null; page.overview = null; page.bytes = 0;
    page.version++;
  }

  // ---------- drawing ----------
  // A view is { w, h, m: [A, B, C, D, E, F], pxPerPt } where a page point
  // (x, y) lands at pixel (A x + C y + E, B x + D y + F), y down.
  let view = null;

  function pxBox(rect) {
    const [A, B, C, D, E, F] = view.m;
    const xs = [A * rect[0] + C * rect[1] + E, A * rect[2] + C * rect[1] + E, A * rect[0] + C * rect[3] + E, A * rect[2] + C * rect[3] + E];
    const ys = [B * rect[0] + D * rect[1] + F, B * rect[2] + D * rect[1] + F, B * rect[0] + D * rect[3] + F, B * rect[2] + D * rect[3] + F];
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function useQuad(textured) {
    gl.useProgram(quad.p);
    gl.uniformMatrix2fv(quad.u.u_m, false, view.m.slice(0, 4));
    gl.uniform2f(quad.u.u_t, view.m[4], view.m[5]);
    gl.uniform2f(quad.u.u_view, view.w, view.h);
    gl.uniform1f(quad.u.u_textured, textured ? 1 : 0);
  }
  function useInst() {
    gl.useProgram(inst.p);
    gl.uniformMatrix2fv(inst.u.u_m, false, view.m.slice(0, 4));
    gl.uniform2f(inst.u.u_t, view.m[4], view.m[5]);
    gl.uniform2f(inst.u.u_view, view.w, view.h);
    gl.uniform1f(inst.u.u_pxPerPt, view.pxPerPt);
    gl.uniform1f(inst.u.u_minW, view.minW || 1);
  }

  /** Draw a bitmap over its page-space box. `skip`, if given, is a pixel
   *  box to leave alone — where a sharper copy is about to go. */
  function drawTexture(layer, skip) {
    const r = layer.rect;
    gl.disable(gl.STENCIL_TEST);
    useQuad(true);
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      r[0], r[3], 0, 0,   r[2], r[3], 1, 0,
      r[0], r[1], 0, 1,   r[2], r[1], 1, 1,
    ]), gl.STREAM_DRAW);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layer.tex);
    gl.uniform1i(quad.u.u_tex, 0);
    if (!skip) {
      gl.disable(gl.SCISSOR_TEST);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return;
    }
    // Everything outside `skip`, as up to four bands.
    const x0 = Math.max(0, Math.floor(skip[0])), y0 = Math.max(0, Math.floor(skip[1]));
    const x1 = Math.min(view.w, Math.ceil(skip[2])), y1 = Math.min(view.h, Math.ceil(skip[3]));
    const bands = [[0, 0, view.w, y0], [0, y1, view.w, view.h], [0, y0, x0, y1], [x1, y0, view.w, y1]];
    gl.enable(gl.SCISSOR_TEST);
    for (const [bx0, by0, bx1, by1] of bands) {
      if (bx1 <= bx0 || by1 <= by0) continue;
      gl.scissor(bx0, view.h - by1, bx1 - bx0, by1 - by0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  // Clip regions currently held in the stencil: clip object -> bit.
  let slots = [];

  function stencilFor(page, clip) {
    let slot = slots.find((s) => s.clip === clip);
    if (slot) { slot.used = ++slotClock; return slot.bit; }

    if (slots.length < CLIP_SLOTS) {
      slot = { bit: 1 << slots.length, clip: null, used: 0 };
      slots.push(slot);
    } else {
      slot = slots.reduce((a, b) => (a.used < b.used ? a : b));
    }
    slot.clip = clip;
    slot.used = ++slotClock;

    // Build the region into this bit: the first polygon sets it, and each
    // further one clears it wherever that polygon is not.
    gl.disable(gl.SCISSOR_TEST);
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilMask(slot.bit);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    useQuad(false);
    gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
    clip.polys.forEach((id, k) => {
      const poly = page.polys.get(id);
      if (!poly) return;
      if (k === 0) {
        gl.stencilMask(slot.bit);
        gl.stencilFunc(gl.ALWAYS, slot.bit, 0xff);
        gl.bindVertexArray(poly.vao);
        gl.drawArrays(gl.TRIANGLES, 0, poly.n);
        return;
      }
      gl.stencilMask(SCRATCH_BIT);
      gl.stencilFunc(gl.ALWAYS, SCRATCH_BIT, 0xff);
      gl.bindVertexArray(poly.vao);
      gl.drawArrays(gl.TRIANGLES, 0, poly.n);
      // Wherever the scratch bit is still clear, this polygon is absent.
      gl.stencilMask(slot.bit);
      gl.stencilFunc(gl.EQUAL, 0, SCRATCH_BIT);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.ZERO);
      fullScreen();
      gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
      gl.stencilMask(SCRATCH_BIT);
      gl.clear(gl.STENCIL_BUFFER_BIT);
    });
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    useInst();
    return slot.bit;
  }
  let slotClock = 0;

  function fullScreen() {
    // In pixel space, so the page transform has to step aside for it.
    gl.uniformMatrix2fv(quad.u.u_m, false, [1, 0, 0, 1]);
    gl.uniform2f(quad.u.u_t, 0, 0);
    gl.bindVertexArray(quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 0, 0,   view.w, 0, 0, 0,   0, view.h, 0, 0,   view.w, view.h, 0, 0,
    ]), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.uniformMatrix2fv(quad.u.u_m, false, view.m.slice(0, 4));
    gl.uniform2f(quad.u.u_t, view.m[4], view.m[5]);
  }

  // A stroke reaches half its width past its geometry; pad the cull test.
  const cullPad = (v) => 2 / v.pxPerPt + 4;
  const culled = (c, vis, pad) => {
    const b = c.bbox;
    return b[2] < vis[0] - pad || b[0] > vis[2] + pad || b[3] < vis[1] - pad || b[1] > vis[3] + pad;
  };

  /** How many instances `view` would draw — the cost of a redraw. */
  function visibleCount(page, v) {
    const pad = cullPad(v);
    let n = 0;
    for (const c of page.chunks) if (!culled(c, v.visible, pad)) n += c.count;
    return n;
  }

  function begin(v) {
    view = v;
    slots = [];
    gl.viewport(0, 0, v.w, v.h);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.colorMask(true, true, true, true);
    gl.stencilMask(0xff);
    gl.clearColor(1, 1, 1, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.stencilMask(0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Draw `page` into the bound framebuffer. `visible` is the page-space
   *  box on show; chunks wholly outside it are skipped. */
  function render(page, v, withText = true) {
    begin(v);
    const vis = v.visible;
    const pad = cullPad(v);
    const chunks = page.chunks;
    const groups = chunks.length ? chunks[chunks.length - 1].group + 1 : 0;
    const count = Math.max(groups, page.layers.length);
    let ci = 0;
    let clipNow;          // undefined: state unknown, so the first chunk always sets it
    let instReady = false;

    for (let g = 0; g < count; g++) {
      if (page.layers[g]) { drawTexture(page.layers[g]); clipNow = undefined; instReady = false; }
      for (; ci < chunks.length && chunks[ci].group === g; ci++) {
        const c = chunks[ci];
        if (culled(c, vis, pad)) continue;
        if (!instReady) { useInst(); instReady = true; }
        if (c.clip !== clipNow) {
          clipNow = c.clip;
          if (c.clip && c.clip.polys.length) {
            const bit = stencilFor(page, c.clip);
            gl.enable(gl.STENCIL_TEST);
            gl.stencilFunc(gl.EQUAL, bit, bit);
          } else {
            gl.disable(gl.STENCIL_TEST);
          }
          if (c.clip && c.clip.rect) {
            const p = pxBox(c.clip.rect);
            const x0 = Math.max(0, Math.floor(p[0])), y0 = Math.max(0, Math.floor(p[1]));
            const x1 = Math.min(v.w, Math.ceil(p[2])), y1 = Math.min(v.h, Math.ceil(p[3]));
            gl.enable(gl.SCISSOR_TEST);
            gl.scissor(x0, v.h - y1, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
          } else {
            gl.disable(gl.SCISSOR_TEST);
          }
        }
        gl.uniform3f(inst.u.u_chunk, c.x0, c.y0, c.unit);
        gl.bindVertexArray(c.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.count);
      }
    }

    if (withText) drawText(page, v);
    gl.bindVertexArray(null);
  }

  function drawText(page, v) {
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.STENCIL_TEST);
    const text = page.text;
    if (text) {
      // The sharp copy is only right at the zoom it was made for.
      const d = text.detail;
      const sharp = d && Math.abs(d.pxPerPt / v.pxPerPt - 1) < 0.002;
      if (text.base) drawTexture(text.base, sharp ? pxBox(d.rect) : null);
      if (sharp) drawTexture(d);
    }
  }

  /** The stand-in for a redraw too slow to do on every frame: the cached
   *  overview stretched to the view, with the text over it. */
  function renderPreview(page, v) {
    begin(v);
    if (page.overview) drawTexture(page.overview);
    drawText(page, v);
    gl.bindVertexArray(null);
  }

  /** Draw to the canvas itself. */
  function draw(page, v) {
    if (lost) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    render(page, v);
  }

  function drawPreview(page, v) {
    if (lost) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    renderPreview(page, v);
  }

  // ---------- offscreen, for thumbnails and tests ----------
  let fbo = null;

  function ensureFbo(w, h) {
    if (fbo && fbo.w === w && fbo.h === h) return fbo;
    if (fbo) {
      gl.deleteFramebuffer(fbo.ms); gl.deleteFramebuffer(fbo.flat);
      gl.deleteRenderbuffer(fbo.color); gl.deleteRenderbuffer(fbo.ds); gl.deleteRenderbuffer(fbo.out);
    }
    const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
    const color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, w, h);
    const ds = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, ds);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH24_STENCIL8, w, h);
    const ms = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, ms);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, ds);
    const out = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, out);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    const flat = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, flat);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, out);
    fbo = { w, h, ms, flat, color, ds, out };
    return fbo;
  }

  function freeFbo() {
    if (!fbo) return;
    gl.deleteFramebuffer(fbo.ms); gl.deleteFramebuffer(fbo.flat);
    gl.deleteRenderbuffer(fbo.color); gl.deleteRenderbuffer(fbo.ds); gl.deleteRenderbuffer(fbo.out);
    fbo = null;
  }

  /** Render the whole page, without its text, into a texture kept with
   *  the page. A sheet with ten million lines costs a few hundred ms of
   *  GPU time to draw in full; this is what is shown while the view is
   *  still moving, at the cost of one such draw up front. */
  function makeOverview(page, v) {
    if (lost) return;
    const f = ensureFbo(v.w, v.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.ms);
    render(page, v, false);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(v.w, v.h))) + 1, gl.RGBA8, v.w, v.h);
    const target = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, f.ms);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target);
    gl.blitFramebuffer(0, 0, v.w, v.h, 0, 0, v.w, v.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(target);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (page.overview) gl.deleteTexture(page.overview.tex);
    // A framebuffer's first row is its bottom one, so the rect is given
    // upside down: drawTexture puts row 0 at rect[3].
    page.overview = { tex, rect: [v.visible[0], v.visible[3], v.visible[2], v.visible[1]], pxPerPt: v.pxPerPt };
    freeFbo();       // a few hundred MB of multisample buffer, needed once
  }

  /** Render `page` off screen and return its pixels, top row first.
   *  `preview` draws from the overview instead of the geometry. */
  function snapshot(page, v, preview = false) {
    if (lost) return null;
    const f = ensureFbo(v.w, v.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.ms);
    if (preview) renderPreview(page, v); else render(page, v);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, f.ms);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, f.flat);
    gl.blitFramebuffer(0, 0, v.w, v.h, 0, 0, v.w, v.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.flat);
    const raw = new Uint8Array(v.w * v.h * 4);
    gl.readPixels(0, 0, v.w, v.h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL rows run bottom-up.
    const px = new Uint8ClampedArray(raw.length);
    const row = v.w * 4;
    for (let y = 0; y < v.h; y++) px.set(raw.subarray((v.h - 1 - y) * row, (v.h - y) * row), y * row);
    return new ImageData(px, v.w, v.h);
  }

  return {
    createPage, addChunk, addClipPoly, setLayer, setText, releasePage,
    draw, drawPreview, snapshot, makeOverview, visibleCount,
    isLost: () => lost,
    onReset: (fn) => resetListeners.push(fn),
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
}
