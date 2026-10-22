// ---------------------------------------------------------------------------
// Standard MIDI File (SMF) reader / writer built on `Buffer` only.
//
// The reference project shells out to Python + mido for every MIDI operation.
// Its two musical primitives — lyrics attached to notes and breath marks cut
// out of note tails — need nothing more than reading and writing SMF, so the
// port keeps them in-process and inside the zero-dependency rule.
//
// Scope is deliberately narrow: note on/off, tempo, time signature, track name
// and lyric meta events. Controllers, pitch bend and sysex are parsed for
// offsets but not exposed; format 2 files are rejected because "seconds" has
// no single meaning across independent tracks.
// ---------------------------------------------------------------------------

export const MIDI_LIMITS = Object.freeze({
  bytes: 4 * 1024 * 1024,
  tracks: 64,
  events: 200_000,
  notes: 20_000,
});

const DEFAULT_TEMPO_US = 500_000;

class MidiError extends Error {
  constructor(message) {
    super(message);
    this.name = "MidiError";
  }
}

function need(buffer, offset, length, what) {
  if (offset + length > buffer.length) {
    throw new MidiError(`MIDI 数据不完整：${what}`);
  }
}

function readVlq(buffer, offset) {
  let value = 0;
  for (let index = 0; index < 4; index += 1) {
    need(buffer, offset + index, 1, "变长整数");
    const byte = buffer[offset + index];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  throw new MidiError("MIDI 变长整数超过 4 字节");
}

function writeVlq(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new MidiError("MIDI 时间差必须是非负整数");
  const bytes = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    bytes.unshift((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

function metaBytes(type, data) {
  return Buffer.concat([Buffer.from([0xff, type]), writeVlq(data.length), data]);
}

function textMeta(type, text) {
  return metaBytes(type, Buffer.from(String(text), "utf8"));
}

function buildTempoMap(entries, ticksPerBeat) {
  const sorted = [...entries].sort((left, right) => left.tick - right.tick);
  const map = [];
  let seconds = 0;
  let previous = null;
  for (const entry of sorted) {
    if (previous) {
      seconds += ((entry.tick - previous.tick) * previous.tempoUs) / ticksPerBeat / 1_000_000;
    }
    if (map.length && map[map.length - 1].tick === entry.tick) {
      map[map.length - 1] = { tick: entry.tick, tempoUs: entry.tempoUs, seconds };
    } else {
      map.push({ tick: entry.tick, tempoUs: entry.tempoUs, seconds });
    }
    previous = entry;
  }
  if (!map.length || map[0].tick > 0) {
    map.unshift({ tick: 0, tempoUs: DEFAULT_TEMPO_US, seconds: 0 });
    // Recompute the first real entry relative to the inserted default.
    for (let index = 1; index < map.length; index += 1) {
      const prior = map[index - 1];
      map[index].seconds = prior.seconds
        + ((map[index].tick - prior.tick) * prior.tempoUs) / ticksPerBeat / 1_000_000;
    }
  }
  return map;
}

function secondsAt(map, ticksPerBeat, tick) {
  let low = 0;
  let high = map.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (map[middle].tick <= tick) low = middle;
    else high = middle - 1;
  }
  const entry = map[low];
  return entry.seconds + ((tick - entry.tick) * entry.tempoUs) / ticksPerBeat / 1_000_000;
}

function parseTrack(buffer, start, length, trackIndex) {
  const end = start + length;
  let offset = start;
  let tick = 0;
  let status = 0;
  let events = 0;
  let trackName = "";
  const noteOns = new Map();
  const pendingLyrics = new Map();
  const rawNotes = [];
  const tempos = [];
  const lyrics = [];
  let timeSignature = null;

  while (offset < end) {
    const delta = readVlq(buffer, offset);
    offset = delta.next;
    tick += delta.value;
    need(buffer, offset, 1, "事件状态字节");
    let byte = buffer[offset];
    if (byte === 0xff) {
      offset += 1;
      need(buffer, offset, 1, "meta 类型");
      const type = buffer[offset];
      offset += 1;
      const size = readVlq(buffer, offset);
      offset = size.next;
      need(buffer, offset, size.value, "meta 内容");
      const data = buffer.subarray(offset, offset + size.value);
      offset += size.value;
      if (type === 0x51 && data.length === 3) {
        tempos.push({ tick, tempoUs: (data[0] << 16) | (data[1] << 8) | data[2] });
      } else if (type === 0x58 && data.length >= 2) {
        timeSignature = { numerator: data[0], denominator: 2 ** data[1] };
      } else if (type === 0x03 && !trackName) {
        trackName = data.toString("utf8").trim();
      } else if (type === 0x05) {
        const text = data.toString("utf8").trim() || "-";
        pendingLyrics.set(tick, text);
        lyrics.push({ tick, text });
      } else if (type === 0x2f) {
        break;
      }
      events += 1;
      continue;
    }
    if (byte === 0xf0 || byte === 0xf7) {
      offset += 1;
      const size = readVlq(buffer, offset);
      offset = size.next + size.value;
      if (offset > end) throw new MidiError("MIDI 数据不完整：系统独占消息");
      status = 0;
      events += 1;
      continue;
    }
    if (byte >= 0x80) {
      status = byte;
      offset += 1;
    } else if (!status) {
      throw new MidiError("MIDI 事件缺少状态字节");
    }

    const command = status & 0xf0;
    const channel = status & 0x0f;
    const dataLength = command === 0xc0 || command === 0xd0 ? 1 : 2;
    need(buffer, offset, dataLength, "事件数据");
    const first = buffer[offset];
    const second = dataLength === 2 ? buffer[offset + 1] : 0;
    offset += dataLength;
    events += 1;
    if (events > MIDI_LIMITS.events) throw new MidiError("MIDI 事件过多，已停止解析");

    if (command === 0x90 && second > 0) {
      const lyric = pendingLyrics.get(tick) ?? "-";
      pendingLyrics.delete(tick);
      const key = `${channel}:${first}`;
      if (!noteOns.has(key)) noteOns.set(key, []);
      noteOns.get(key).push({ tick, lyric });
    } else if (command === 0x80 || (command === 0x90 && second === 0)) {
      const key = `${channel}:${first}`;
      const stack = noteOns.get(key);
      if (!stack || !stack.length) continue;
      const started = stack.shift();
      rawNotes.push({
        track: trackIndex,
        channel,
        pitch: first,
        tickStart: started.tick,
        tickEnd: tick,
        lyric: started.lyric,
      });
      if (rawNotes.length > MIDI_LIMITS.notes) throw new MidiError("MIDI 音符过多，已停止解析");
    }
  }

  return { trackName, rawNotes, tempos, lyrics, timeSignature, endTick: tick };
}

export function parseMidi(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new MidiError("MIDI 需要 Buffer 数据");
  if (buffer.length < 14) throw new MidiError("不是有效的 MIDI 文件");
  if (buffer.length > MIDI_LIMITS.bytes) throw new MidiError("MIDI 文件超过 4 MB");
  if (buffer.toString("latin1", 0, 4) !== "MThd") throw new MidiError("不是有效的 MIDI 文件：缺少 MThd");
  const headerLength = buffer.readUInt32BE(4);
  if (headerLength < 6) throw new MidiError("MIDI 头长度无效");
  need(buffer, 8, headerLength, "文件头");
  const format = buffer.readUInt16BE(8);
  const trackCount = buffer.readUInt16BE(10);
  const division = buffer.readUInt16BE(12);
  if (format === 2) throw new MidiError("不支持 MIDI format 2（多首独立曲目）");
  if (!division || division & 0x8000) throw new MidiError("不支持 SMPTE 时基的 MIDI");
  if (trackCount > MIDI_LIMITS.tracks) throw new MidiError("MIDI 轨道过多");

  const tracks = [];
  const tempos = [];
  const allNotes = [];
  const lyricEvents = [];
  let timeSignature = null;
  let offset = 8 + headerLength;
  while (offset + 8 <= buffer.length && tracks.length < trackCount) {
    const id = buffer.toString("latin1", offset, offset + 4);
    const length = buffer.readUInt32BE(offset + 4);
    offset += 8;
    need(buffer, offset, length, "轨道数据");
    if (id === "MTrk") {
      const parsed = parseTrack(buffer, offset, length, tracks.length);
      tracks.push({
        name: parsed.trackName,
        notes: parsed.rawNotes.length,
        lyrics: parsed.lyrics.length,
      });
      tempos.push(...parsed.tempos);
      lyricEvents.push(...parsed.lyrics);
      allNotes.push(...parsed.rawNotes);
      if (parsed.timeSignature) timeSignature = parsed.timeSignature;
    }
    offset += length;
  }
  if (!tracks.length) throw new MidiError("MIDI 没有轨道");

  const tempoMap = buildTempoMap(tempos, division);
  const notes = allNotes
    .map((note) => ({
      t0: secondsAt(tempoMap, division, note.tickStart),
      t1: secondsAt(tempoMap, division, Math.max(note.tickStart + 1, note.tickEnd)),
      pitch: note.pitch,
      channel: note.channel,
      lyric: note.lyric,
      tickStart: note.tickStart,
      tickEnd: Math.max(note.tickStart + 1, note.tickEnd),
    }))
    .sort((left, right) => left.t0 - right.t0 || left.t1 - right.t1 || left.pitch - right.pitch);

  const tempoUs = tempos.length ? tempos[tempos.length - 1].tempoUs : DEFAULT_TEMPO_US;
  return {
    format,
    ticksPerBeat: division,
    tracks,
    notes,
    lyricEvents,
    meta: {
      tempoUs,
      tempoBpm: 60_000_000 / tempoUs,
      timeSignature: timeSignature ?? { numerator: 4, denominator: 4 },
    },
  };
}

// A single-track format 0 file is enough for breath marking: downstream
// editors (X Studio and friends) only need lyrics attached to notes. Notes
// that share a tick are ordered lyric → note on → note off, and overlap is
// trimmed exactly like the reference writer so no note steals the next one.
export function writeMidi({ notes, meta, trackName = "MELODY" } = {}) {
  if (!Array.isArray(notes) || !notes.length) throw new MidiError("没有可写入的音符");
  if (notes.length > MIDI_LIMITS.notes) throw new MidiError("音符过多，已停止写入");
  const ticksPerBeat = Number(meta?.ticksPerBeat ?? 480);
  if (!Number.isSafeInteger(ticksPerBeat) || ticksPerBeat < 24 || ticksPerBeat > 9600) {
    throw new MidiError("MIDI 时基无效");
  }
  const tempoUs = Number(meta?.tempoUs ?? DEFAULT_TEMPO_US);
  if (!Number.isSafeInteger(tempoUs) || tempoUs < 1_000 || tempoUs > 60_000_000) {
    throw new MidiError("MIDI 速度无效");
  }
  const signature = meta?.timeSignature ?? { numerator: 4, denominator: 4 };

  const toTick = (seconds) => Math.max(0, Math.round((seconds * 1_000_000 * ticksPerBeat) / tempoUs));
  const spans = notes.map((note) => {
    const start = toTick(note.t0);
    const end = Math.max(start + 1, toTick(note.t1));
    if (note.pitch < 0 || note.pitch > 127) throw new MidiError("MIDI 音高超出 0-127");
    return { start, end, pitch: note.pitch, lyric: note.lyric || "-" };
  });
  for (let index = 0; index < spans.length - 1; index += 1) {
    const span = spans[index];
    const next = spans[index + 1];
    let end = span.end;
    if (end > next.start) end = Math.max(span.start + 1, next.start);
    if (span.pitch === next.pitch && end >= next.start) end = Math.max(span.start + 1, next.start - 1);
    spans[index] = { ...span, end };
  }

  const events = [];
  for (const span of spans) {
    events.push({ tick: span.start, priority: 2, bytes: textMeta(0x05, span.lyric) });
    events.push({ tick: span.start, priority: 3, bytes: Buffer.from([0x90, span.pitch, 90]) });
    events.push({ tick: span.end, priority: 1, bytes: Buffer.from([0x80, span.pitch, 0]) });
  }
  events.sort((left, right) => left.tick - right.tick || left.priority - right.priority);

  const header = Buffer.from([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    0, 0,
    0, 1,
    (ticksPerBeat >> 8) & 0xff, ticksPerBeat & 0xff,
  ]);
  const tempoData = Buffer.from([
    (tempoUs >> 16) & 0xff,
    (tempoUs >> 8) & 0xff,
    tempoUs & 0xff,
  ]);
  const pieces = [
    writeVlq(0), textMeta(0x03, trackName),
    writeVlq(0), metaBytes(0x58, Buffer.from([
      signature.numerator & 0xff, Math.round(Math.log2(signature.denominator)), 24, 8,
    ])),
    writeVlq(0), metaBytes(0x51, tempoData),
  ];
  let last = 0;
  for (const event of events) {
    pieces.push(writeVlq(event.tick - last), event.bytes);
    last = event.tick;
  }
  pieces.push(writeVlq(0), metaBytes(0x2f, Buffer.alloc(0)));
  const trackData = Buffer.concat(pieces);
  const trackHeader = Buffer.alloc(8);
  trackHeader.write("MTrk", 0, "latin1");
  trackHeader.writeUInt32BE(trackData.length, 4);
  return Buffer.concat([header, trackHeader, trackData]);
}

export function midiNoteName(pitch) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const value = Number(pitch);
  if (!Number.isFinite(value)) return String(pitch);
  return `${names[((value % 12) + 12) % 12]}${Math.floor(value / 12) - 1}`;
}
