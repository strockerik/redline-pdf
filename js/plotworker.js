/* Worker: inflate a page's content streams and compile them for the GPU.
 *
 * The compile is a second or two of solid work for a large sheet, which
 * is exactly what must not happen on the thread that handles the pointer.
 * Chunks are posted as they fill, so the page appears as it is read.
 */
import { createCompiler } from './plotcompile.js';

const POST_BYTES = 4 << 20;        // post geometry in batches of about this size

const cancelled = new Set();
let queue = Promise.resolve();

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'cancel') cancelled.add(m.id);
  else if (m.type === 'compile') queue = queue.then(() => compile(m));
  else if (m.type === 'inflate') {
    // This same script, running as the helper below.
    inflate(m.bytes).then(
      (bytes) => self.postMessage({ seq: m.seq, bytes }, [bytes.buffer]),
      (err) => self.postMessage({ seq: m.seq, error: String((err && err.message) || err) }),
    );
  }
};

/** FlateDecode is a zlib stream, which is what 'deflate' means here. */
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Compiling a stream blocks this thread, and inflating the next one could
// be happening meanwhile — it is a third of the total. So a second copy
// of this worker does nothing but inflate, one stream ahead.
let helper = null, helperSeq = 0;
const waiting = new Map();

function inflateAhead(bytes) {
  try {
    if (!helper) {
      helper = new Worker(self.location.href, { type: 'module' });
      helper.onmessage = (e) => {
        const w = waiting.get(e.data.seq);
        waiting.delete(e.data.seq);
        if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data.bytes);
      };
      helper.onerror = () => {
        for (const w of waiting.values()) w.reject(new Error('inflate worker failed'));
        waiting.clear();
        helper = null;
      };
    }
  } catch {
    return inflate(bytes);            // no nested workers here; do it in line
  }
  return new Promise((resolve, reject) => {
    const seq = ++helperSeq;
    waiting.set(seq, { resolve, reject });
    helper.postMessage({ type: 'inflate', seq, bytes }, [bytes.buffer]);
  });
}

async function compile({ id, streams, res, box }) {
  const t0 = performance.now();
  let batch = [], transfer = [], pending = 0;
  const post = () => {
    if (!batch.length) return;
    self.postMessage({ type: 'chunks', id, chunks: batch }, transfer);
    batch = []; transfer = []; pending = 0;
  };

  let stage = 'inflate';
  let compileMs = 0;
  try {
    const compiler = createCompiler({
      res, box,
      onChunk: (c) => {
        batch.push(c); transfer.push(c.buffer);
        pending += c.buffer.byteLength;
        if (pending >= POST_BYTES) post();
      },
      onClipPoly: (polyId, tris) => self.postMessage({ type: 'poly', id, polyId, tris }, [tris.buffer]),
    });

    const ready = (s) => {
      const p = s.flate ? inflateAhead(s.bytes) : Promise.resolve(s.bytes);
      p.catch(() => {});               // reported when awaited, not as an unhandled rejection
      return p;
    };
    let next = streams.length ? ready(streams[0]) : null;
    for (let k = 0; k < streams.length; k++) {
      if (cancelled.has(id)) { cancelled.delete(id); return; }
      stage = 'inflate';
      const data = await next;
      next = k + 1 < streams.length ? ready(streams[k + 1]) : null;
      stage = 'compile';
      const t = performance.now();
      compiler.feed(data);
      compileMs += performance.now() - t;
      post();
    }
    const r = compiler.finish();
    post();
    self.postMessage({
      type: 'done', id,
      residual: r.residual, layers: r.layers, text: r.text, groups: r.groups,
      stats: { ...r.stats, compileMs: Math.round(compileMs) }, ms: Math.round(performance.now() - t0),
    }, [r.residual.buffer]);
  } catch (err) {
    self.postMessage({ type: 'fail', id, stage, reason: String((err && err.message) || err) });
  }
}
