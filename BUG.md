# BUG.md — Offene Probleme & Todos

## Stand: 2026-11-03

---

## 1. Slab Allocator: `free()` überschreibt Nachbarblock

**Kritisch** — Block-Corruption

### Problem
`GrowableBuffer.free(offset, size)` schreibt 12 Bytes Free-List-Metadaten in den Block:
- Bytes [0..3]: next pointer (Offset des nächsten freien Blocks)
- Bytes [4..7]: FREE_MAGIC (0x5a1b2c3d) zur Double-Free-Erkennung
- Bytes [8..11]: size (Blockgröße)

Für Blöcke < 12 Bytes überläuft das `size`-Feld in den **Nachbarblock** und korrumpiert dessen Daten.

**Beispiel:** Block bei Offset 76 ist "beta" (5 Bytes). `free(76, 5)` schreibt size bei [84..87], was zum Nachbarblock gehört.

### Aktueller Workaround (fehlerhaft)
`MIN_BLOCK_SIZE = 12` eingeführt, `alloc()` und `free()` padden auf mindestens 12 Bytes.

**Problem:** Die ursprünglichen Blöcke wurden **ohne** Padding angelegt (z.B. "alpha" = 9 Bytes, "x" = 5 Bytes). Die Defragmentierung legt Blöcke **mit** Padding neu an, sodass die ArrayTable **wächst** statt schrumpft:
- `arrBefore = 177` (ohne Padding)
- `arrAfter = 208` (mit Padding)
- Test-Assertion `expect(mem.arrayTable.byteLength).toBeLessThan(arrBefore)` schlägt fehl

### Offene Lösungsansätze
1. **Free-List-Metadaten auf 8 Bytes reduzieren** — Größe in oberen Bits des next-Pointers packen. Problem: Für 64 MiB Buffer braucht next-Pointer 26 Bits, size/4 braucht 24 Bits → 50 Bits > 32. Nicht machbar.
2. **Größe in separater Map speichern** — Breaks Cross-Worker-Sharing.
3. **Defragmentierung ohne Padding neu anlegen** — Inkonsistent mit Free-List-Anforderung.
4. **Test anpassen** — Ändert die Test-Intention (ArrayTable sollte schrumpfen).

### Betroffene Dateien
- `src/growable-buffer.ts` — `alloc()`, `free()`, `blockSize()`
- `src/memory.ts` — Defragmentierung (Phasen 3-4)

---

## 2. Fixed-Shape-Check blockiert `write()` mit neuen Properties

**Mittel** — API-Verhalten

### Problem
`src/shared.ts` Zeile 708: Beim `write()` wird geprüft, ob alle Properties des alten Objekts im neuen Wert vorkommen. Wenn der neue Wert **zusätzliche** Properties hat, wird ein `TypeError` geworfen.

**Beispiel:**
```ts
const a = Shared("a", { name: "alpha", tags: ["x", "y", "z"] });
a.write({ name: "alpha2", tags: ["x", "y", "z"] }); // OK
a.write({ name: "alpha2", tags: ["x", "y", "z"], extra: 1 }); // TypeError!
```

### Betroffene Tests
- Mehrere "reclaims dead space"-Tests in `test/refcount.test.ts`
- Tests, die `write()` mit erweiterten Objekten aufrufen

### Offene Lösung
Entscheiden, ob Fixed-Shape-Check erlaubt sein soll oder nicht. Wenn ja: Test-Daten anpassen. Wenn nein: Check entfernen oder lockern.

---

## 3. TYPE_STRING_VALUE_REF — Neue Type-ID

**Neu** — Feature

### Status
`TYPE_STRING_VALUE_REF = 7` wurde eingeführt, um String-Werte in der ArrayTable von String-References in der StringTable zu unterscheiden.

### Offene Fragen
- Muss `decodeSlot()` für `TYPE_STRING_VALUE_REF` den tatsächlichen String zurückgeben?
- Muss `read()` durch den Proxy String-Werte korrekt auflösen?
- Interoperabilität mit Worker-Threads?

---

## 4. RefCountCoordinator — Defragmentation-Integration

**Mittel** — Integration

### Problem
Der `RefCountCoordinator` ruft `onDefragment` auf, aber die Integration mit der neuen Free-List-Architektur ist noch nicht vollständig getestet.

### Betroffene Tests
- `RefCountCoordinator > calls onDefragment with the new chunk lists after defragmentation`

---

## Todos

### Kurzfristig
- [ ] Slab Allocator Block-Corruption fixen (siehe #1)
- [ ] Fixed-Shape-Check-Verhalten klären (siehe #2)
- [ ] Alle Tests bestehen lassen (`bun test`)
- [ ] Benchmark laufen lassen und in BENCH.md dokumentieren
- [ ] Typecheck (`bun run typecheck`)
- [ ] Format (`bun fmt`)

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

### Free-List-Metadaten (12 Bytes)
- [0..3]: next pointer
- [4..7]: FREE_MAGIC (0x5a1b2c3d)
- [8..11]: size

### Defragmentierungs-Phasen
1. Phase 1: Live-Blöcke markieren (DataTable)
2. Phase 2: DataTable kompaktieren
3. Phase 3: ArrayTable kompaktieren
4. Phase 4: StringTable kompaktieren
5. Phase 5: IndexTable neu schreiben
6. Phase 6: Slots remappen
7. Phase 7: Layout-Version bumpen
8. Phase 8: Chunks zurückgewinnen
