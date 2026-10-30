// Per-upstream counters plus a bounded event ring for the GUI.

import fs from 'node:fs';
import path from 'node:path';

const EVENT_LIMIT = 300;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function emptyCounters() {
  return {
    requests: 0,
    injected: 0,
    skipped: 0,
    bytes_in: 0,
    bytes_out: 0,
    injected_chars: 0,
    errors: 0,
    reasons: {},
  };
}

class Stats {
  constructor(dir) {
    this.file = path.join(dir, 'stats.json');
    this.day = today();
    this.counters = new Map();
    this.events = [];
    this.startedAt = Date.now();
    this.dirty = false;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw?.day === today() && raw.counters) {
        this.day = raw.day;
        for (const [id, value] of Object.entries(raw.counters)) {
          this.counters.set(id, { ...emptyCounters(), ...value });
        }
        if (Array.isArray(raw.events)) {
          this.events = raw.events.slice(-EVENT_LIMIT);
        }
        this.startedAt = raw.started_at ?? this.startedAt;
      }
    } catch {
      /* first boot or unreadable file: start from zero */
    }
    return this;
  }

  flush() {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = {
        day: this.day,
        started_at: this.startedAt,
        updated_at: new Date().toISOString(),
        counters: Object.fromEntries(this.counters),
        events: this.events.slice(-EVENT_LIMIT),
      };
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (error) {
      console.error(`[stats] flush failed: ${error.message}`);
    }
  }

  rollIfNeeded() {
    const now = today();
    if (now !== this.day) {
      this.day = now;
      this.counters.clear();
      this.events = [];
      this.dirty = true;
    }
  }

  countersFor(id) {
    this.rollIfNeeded();
    if (!this.counters.has(id)) this.counters.set(id, emptyCounters());
    return this.counters.get(id);
  }

  record(upstreamId, event) {
    const counters = this.countersFor(upstreamId);
    counters.requests += 1;
    counters.bytes_in += event.inBytes || 0;
    counters.bytes_out += event.outBytes || 0;
    if (event.injected) {
      counters.injected += 1;
      counters.injected_chars += event.injectedChars || 0;
    } else {
      counters.skipped += 1;
    }
    if (event.reason && event.reason !== 'injected') {
      counters.reasons[event.reason] = (counters.reasons[event.reason] || 0) + 1;
    }
    if (event.error) counters.errors += 1;

    this.events.push({ ts: new Date().toISOString(), upstream: upstreamId, ...event });
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
    this.dirty = true;
  }

  snapshot() {
    this.rollIfNeeded();
    return {
      day: this.day,
      started_at: this.startedAt,
      counters: Object.fromEntries(this.counters),
    };
  }

  recent(limit = 100) {
    return this.events.slice(-Math.max(1, Math.min(EVENT_LIMIT, limit))).reverse();
  }
}

let singleton = null;

export function init(dir) {
  singleton = new Stats(dir).load();
  const timer = setInterval(() => singleton.flush(), 15_000);
  timer.unref?.();
  return singleton;
}

export function stats() {
  if (!singleton) throw new Error('stats not initialised');
  return singleton;
}
