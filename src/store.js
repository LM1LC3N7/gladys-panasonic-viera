// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known TVs by UDN, their address, the MAC seen
// by the network search, their application list, and the pairing keys of the
// encrypted models (application id and key). Never logged.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const emptyData = () => ({ tvs: {} });

function sanitize(data) {
  const base = emptyData();
  if (data && typeof data === 'object' && data.tvs && typeof data.tvs === 'object') {
    for (const [udn, tv] of Object.entries(data.tvs)) {
      if (tv && typeof tv === 'object' && tv.udn === udn) {
        base.tvs[udn] = tv;
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'viera.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
  }

  async load() {
    try {
      return sanitize(JSON.parse(await readFile(this.path, 'utf8')));
    } catch {
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = structuredClone(data);
    this.saves = 0;
  }

  async load() {
    return sanitize(structuredClone(this.data));
  }

  async save(data) {
    this.data = structuredClone(data);
    this.saves += 1;
  }
}
