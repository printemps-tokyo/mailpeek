/**
 * A minimal reader for the Compound File Binary format (OLE2 / CFB, [MS-CFB]),
 * the container used by Outlook .msg files. Dependency-free: it walks the FAT,
 * mini-FAT and the directory tree to expose every stream by its path.
 */

const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

interface DirEntry {
  name: string;
  type: number; // 1 storage, 2 stream, 5 root
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/** True if the buffer starts with the CFB magic number. */
export function isCfb(bytes: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => bytes[i] === b);
}

/** Parse a CFB file into a map of stream path -> bytes. */
export function parseCfb(bytes: Uint8Array): Map<string, Uint8Array> {
  if (!isCfb(bytes)) {
    throw new Error("not a compound file (bad CFB signature)");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const secShift = dv.getUint16(30, true);
  const secSize = 1 << secShift;
  const miniShift = dv.getUint16(32, true);
  const miniSize = 1 << miniShift;
  const numFatSectors = dv.getUint32(44, true);
  const firstDirSector = dv.getUint32(48, true);
  const miniCutoff = dv.getUint32(56, true);
  const firstMiniFat = dv.getUint32(60, true);
  const numMiniFat = dv.getUint32(64, true);
  let difatSector = dv.getUint32(68, true);
  const numDifat = dv.getUint32(72, true);

  const sectorOffset = (s: number): number => (s + 1) * secSize;

  // Collect the FAT sector numbers: 109 in the header, then any DIFAT sectors.
  const fatSectorList: number[] = [];
  for (let i = 0; i < 109 && fatSectorList.length < numFatSectors; i++) {
    const s = dv.getUint32(76 + i * 4, true);
    if (s !== FREESECT && s !== ENDOFCHAIN) fatSectorList.push(s);
  }
  const entriesPerSector = secSize / 4;
  for (let n = 0; n < numDifat && difatSector !== ENDOFCHAIN && difatSector !== FREESECT; n++) {
    const base = sectorOffset(difatSector);
    for (let i = 0; i < entriesPerSector - 1; i++) {
      const s = dv.getUint32(base + i * 4, true);
      if (s !== FREESECT && s !== ENDOFCHAIN) fatSectorList.push(s);
    }
    difatSector = dv.getUint32(base + (entriesPerSector - 1) * 4, true);
  }

  // Build the FAT (sector allocation table).
  const fat: number[] = [];
  for (const s of fatSectorList) {
    const base = sectorOffset(s);
    for (let i = 0; i < entriesPerSector; i++) fat.push(dv.getUint32(base + i * 4, true));
  }

  const followChain = (start: number): number[] => {
    const out: number[] = [];
    let s = start;
    const guard = fat.length + 1;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < fat.length) {
      out.push(s);
      s = fat[s]!;
      if (out.length > guard) break; // Corrupt/looping chain.
    }
    return out;
  };

  const readBig = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let written = 0;
    for (const s of followChain(start)) {
      const base = sectorOffset(s);
      const n = Math.min(secSize, size - written);
      out.set(bytes.subarray(base, base + n), written);
      written += n;
      if (written >= size) break;
    }
    return out;
  };

  // Directory entries.
  const dirBytes = readBig(firstDirSector, followChain(firstDirSector).length * secSize);
  const ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
  const entries: DirEntry[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const nameLen = ddv.getUint16(o + 64, true);
    const type = dirBytes[o + 66]!;
    if (type !== 1 && type !== 2 && type !== 5) {
      entries.push({ name: "", type: 0, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: 0, size: 0 });
      continue;
    }
    let name = "";
    for (let c = 0; c + 1 < Math.max(0, nameLen - 2); c += 2) {
      const ch = ddv.getUint16(o + c, true);
      if (ch) name += String.fromCharCode(ch);
    }
    entries.push({
      name,
      type,
      left: ddv.getUint32(o + 68, true),
      right: ddv.getUint32(o + 72, true),
      child: ddv.getUint32(o + 76, true),
      start: ddv.getUint32(o + 116, true),
      size: ddv.getUint32(o + 120, true),
    });
  }

  const root = entries[0];
  if (!root || root.type !== 5) {
    throw new Error("compound file has no root entry");
  }

  // The mini stream holds all streams smaller than the cutoff.
  const miniFat: number[] = [];
  if (numMiniFat > 0) {
    const miniFatBytes = readBig(firstMiniFat, followChain(firstMiniFat).length * secSize);
    const mdv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
    for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(mdv.getUint32(i, true));
  }
  const miniStream = readBig(root.start, root.size);

  const readMini = (start: number, size: number): Uint8Array => {
    const out = new Uint8Array(size);
    let written = 0;
    let s = start;
    const guard = miniFat.length + 1;
    let steps = 0;
    while (s !== ENDOFCHAIN && s !== FREESECT && s < miniFat.length) {
      const base = s * miniSize;
      const n = Math.min(miniSize, size - written);
      out.set(miniStream.subarray(base, base + n), written);
      written += n;
      if (written >= size) break;
      s = miniFat[s]!;
      if (++steps > guard) break;
    }
    return out;
  };

  const readEntry = (e: DirEntry): Uint8Array =>
    e.size < miniCutoff ? readMini(e.start, e.size) : readBig(e.start, e.size);

  // Walk the red-black directory tree to assemble full paths.
  const streams = new Map<string, Uint8Array>();
  const visit = (id: number, prefix: string): void => {
    if (id === NOSTREAM || id >= entries.length) return;
    const e = entries[id]!;
    if (e.type === 0) return;
    visit(e.left, prefix);
    const path = prefix + e.name;
    if (e.type === 2) {
      streams.set(path, readEntry(e));
    } else if (e.type === 1) {
      visit(e.child, `${path}/`);
    }
    visit(e.right, prefix);
  };
  visit(root.child, "");

  return streams;
}
