/**
 * Child process: measure cofusion operations in isolation.
 *
 * Run by compare.ts (the orchestrator). Measures every shared operation for
 * cofusion in a fresh process (own JIT heat-map, own memory state) and emits
 * the results as a single JSON line on stdout.
 */
import { createArena } from "cofusion";
import { runAndEmit, runSingle } from "./compare-measure.ts";

const arena = createArena({ initialSize: 64 * 1024 * 1024 });

let keyCounter = 0;
const nextKey = (prefix: string) => `${prefix}-${keyCounter++}`;

const ops: Array<{ name: string; fn: () => unknown }> = [];

// Primitives
{
  const num = arena.shared<number>(nextKey("num"), 42);
  ops.push({ name: "number · read", fn: () => num.read() });
  ops.push({ name: "number · write", fn: () => num.write(7) });

  const str = arena.shared<string>(nextKey("str"), "hello world");
  ops.push({ name: "string · read", fn: () => str.read() });
  ops.push({ name: "string · write", fn: () => str.write("new value") });

  const bool = arena.shared<boolean>(nextKey("bool"), true);
  ops.push({ name: "boolean · read", fn: () => bool.read() });
  ops.push({ name: "boolean · write", fn: () => bool.write(false) });
}

// Arrays
{
  const numArr = arena.shared<number[]>(
    nextKey("numarr"),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  ops.push({ name: "number[] · read index", fn: () => numArr[3] });
  ops.push({ name: "number[] · write index", fn: () => (numArr[3] = 99) });

  const strArr = arena.shared<string[]>(nextKey("strarr"), [
    "a",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "j",
  ]);
  ops.push({ name: "string[] · read index", fn: () => strArr[3] });
  ops.push({ name: "string[] · write index", fn: () => (strArr[3] = "z") });

  const boolArr = arena.shared<boolean[]>(nextKey("boolarr"), [
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
  ]);
  ops.push({ name: "boolean[] · read index", fn: () => boolArr[3] });
  ops.push({ name: "boolean[] · write index", fn: () => (boolArr[3] = true) });
}

// Objects
{
  const obj = arena.shared<{ id: number; name: string; active: boolean }>(
    nextKey("obj"),
    { id: 1, name: "Alice", active: true },
  );
  ops.push({ name: "object · read number prop", fn: () => obj.id });
  ops.push({ name: "object · read string prop", fn: () => obj.name });
  ops.push({ name: "object · read boolean prop", fn: () => obj.active });
  ops.push({ name: "object · write number prop", fn: () => (obj.id = 2) });
  ops.push({
    name: "object · write string prop",
    fn: () => (obj.name = "Bob"),
  });
}

// When a single operation name is passed as a CLI argument, measure only that
// operation in this fresh process (eliminates JIT interference between ops).
const only = process.argv[2];
if (only) {
  const op = ops.find((o) => o.name === only);
  if (!op) {
    console.error(`Unknown operation: ${only}`);
    process.exit(1);
  }
  runSingle(op.name, op.fn);
} else {
  runAndEmit(ops);
}
