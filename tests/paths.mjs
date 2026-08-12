/* Resolve app paths relative to this file, so the suite runs from any
 * working directory. jsc has no URL global, so parse import.meta.url by
 * hand. */
const self = import.meta.url.replace(/^file:\/\//, '');
export const ROOT = self.replace(/\/tests\/paths\.mjs$/, '');
export const APP = ROOT + '/js';
export const VENDOR = ROOT + '/vendor';
