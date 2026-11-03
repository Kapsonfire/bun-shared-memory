# BUG.md — Offene Probleme & Todos

## Stand: 2026-11-03

---

## 1. Slab Allocator: `free()` überschreibt Nachbarblock

**Kritisch** — Block-Corruption — ✅ **Behoben (2026-11-03)**

### Problem

`GrowableBuffer.free(offset, size)` schrieb 12 Bytes Free-List-Metadaten in den Block:

- Bytes [0..3]: next pointer (Offset des nächsten freien Blocks)
- Bytes [4..7]: FREE_MAGIC (0x5a1b2c3d) zur Double-Free-Erkennung
- Bytes [8..11]: size (Blockgröße)

Für Blöcke < 12 Bytes überlief das `size`-Feld in den **Nachbarblock** und korrumpierte dessen Daten.

**Beispiel:** Block bei Offset 76 ist "beta" (5 Bytes). `free(76, 5)` schrieb size bei [84..87], was zum Nachbarblock gehört.

### Ursache

Zwei zusammenhängende Fehler:

1. `alloc()` padete Blöcke intern auf `MIN_BLOCK_SIZE`, aber die Aufrufer riefen `advance()` mit der **ungepadeten** Größe auf. Dadurch überlappten die Blöcke, und `free()`-Metadaten überschrieben den Nachbarn.
2. Die Free-List-Metadaten (12 Bytes) passten nicht in kleine String-Blöcke (< 12 Bytes).

### Fix

- `alloc()` gibt jetzt die tatsächlich reservierte (gepadete) Größe zurück; alle Aufrufer `advance()` mit dieser Größe → keine Block-Überlappung mehr.
- Free-List-Metadaten von 12 auf **8 Bytes** reduziert (next pointer + size), `FREE_MAGIC` entfernt. Double-Frees werden jetzt durch einen Free-List-Walk erkannt (O(n), aber `free` ist kein Hot Path).
- `MIN_BLOCK_SIZE` von 12 auf **8** gesenkt, sodass kleine String-Blöcke die ArrayTable bei der Defragmentierung nicht mehr aufblähen.

### Betroffene Dateien

- `src/growable-buffer.ts` — `alloc()`, `free()`, `blockSize()`
- `src/memory.ts` — `advance()`-Aufrufe nach `alloc()`

---

## 2. Fixed-Shape-Check blockiert `write()` mit neuen Properties

**Mittel** — API-Verhalten — ✅ **Beabsichtigt (kein Bug)**

### Problem

`src/shared.ts` Zeile 708: Beim `write()` wird geprüft, ob alle Properties des alten Objekts im neuen Wert vorkommen. Wenn der neue Wert **zusätzliche** Properties hat, wird ein `TypeError` geworfen.

**Beispiel:**

```ts
const a = Shared("a", { name: "alpha", tags: ["x", "y", "z"] });
a.write({ name: "alpha2", tags: ["x", "y", "z"] }); // OK
a.write({ name: "alpha2", tags: ["x", "y", "z"], extra: 1 }); // TypeError!
```

### Bewertung

Dieses Verhalten ist **beabsichtigt**: `AGENTS.md` legt fest, dass Shared-Werte eine feste Form haben ("object properties may not be added or removed"). Der Check bleibt bestehen; Tests, die `write()` mit erweiterten Objekten aufrufen, sind entsprechend anzupassen.

---

## 3. TYPE_STRING_VALUE_REF — Neue Type-ID

**Neu** — Feature — ✅ **Implementiert**

### Status

`TYPE_STRING_VALUE_REF = 7` wurde eingeführt, um String-Werte in der ArrayTable von String-References in der StringTable zu unterscheiden.

### Offene Fragen

- Muss `decodeSlot()` für `TYPE_STRING_VALUE_REF` den tatsächlichen String zurückgeben? — ✅ Ja, in `src/shared.ts` (`decodeSlot` und `read`).
- Muss `read()` durch den Proxy String-Werte korrekt auflösen? — ✅ Ja.
- Interoperabilität mit Worker-Threads? — ✅ Durch die geteilten Buffers gegeben.

---

## 4. RefCountCoordinator — Defragmentation-Integration

**Mittel** — Integration — ✅ **Getestet**

### Problem

Der `RefCountCoordinator` ruft `onDefragment` auf, aber die Integration mit der neuen Free-List-Architektur ist noch nicht vollständig getestet.

### Betroffene Tests

- `RefCountCoordinator > calls onDefragment with the new chunk lists after defragmentation` — ✅ Besteht.

---

## Todos

### Kurzfristig

- [x] Slab Allocator Block-Corruption fixen (siehe #1)
- [x] Fixed-Shape-Check-Verhalten klären (siehe #2) — beabsichtigt, kein Bug
- [x] Alle Tests bestehen lassen (`bun test`)
- [x] Benchmark laufen lassen und in BENCH.md dokumentieren
- [x] Typecheck (`bun run typecheck`)
- [x] Format (`bun fmt`)

### Mittelfristig

- [ ] Defragmentierung auf Performance optimieren
- [ ] String-Interning in ArrayTable evaluieren
- [ ] Free-List-Strategie evaluieren (best-fit, first-fit, buddy system)
- [ ] Double-Free-Schutz für DataTable evaluieren

### Langfristig

- [ ] Fork-Safety für Worker-Threads
- [ ] Memory-Mapping für große Buffers
- [ ] Garbage Collection-Strategie (mark-sweep vs. reference counting)

---

## Technische Details

### Layout-Konstanten

- `SLOT_SIZE = 16`
- `OBJECT_HEADER = 16`
- `NAME_REF_SIZE = 8`
- `INDEX_ENTRY_SIZE = 16`
- `INDEX_HEADER = 4`
- `ARRAY_HEADER = 4`

### Typ-IDs

- `TYPE_NUMBER = 0`
- `TYPE_BOOLEAN = 1`
- `TYPE_BIGINT = 2`
- `TYPE_STRING_REF = 3`
- `TYPE_ARRAY_REF = 4`
- `TYPE_OBJECT = 5`
- `TYPE_BIGINT_STR = 6`
- `TYPE_STRING_VALUE_REF = 7` (neu)

### Buffer-Defaults

- `DEFAULT_INITIAL = 1024`
- `DEFAULT_MAX = 64 * 1024 * 1024` (64 MiB)

### Free-List-Metadaten (8 Bytes)

- Bytes 0..3: next pointer
- Bytes 4..7: size

Double-Frees werden durch einen Free-List-Walk erkannt (kein Magic-Marker).

### Defragmentierungs-Phasen

1. Phase 1: Live-Blöcke markieren (DataTable)
2. Phase 2: DataTable kompaktieren
3. Phase 3: ArrayTable kompaktieren
4. Phase 4: StringTable kompaktieren
5. Phase 5: IndexTable neu schreiben
6. Phase 6: Slots remappen
7. Phase 7: Layout-Version bumpen
8. Phase 8: Chunks zurückgewinnen
