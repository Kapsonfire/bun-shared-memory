import { benchPair, nextKey, arena } from "./helpers.ts";

// ---------------------------------------------------------------------------
// number[]
// ---------------------------------------------------------------------------
{
  const initial = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const native = [...initial];
  const shared = arena.shared<number[]>(nextKey("numarr"), [...initial]);

  benchPair(
    "number[] · read index",
    () => native[3],
    () => shared[3],
  );
  benchPair(
    "number[] · write index",
    () => (native[3] = 99),
    () => (shared[3] = 99),
  );
}

// ---------------------------------------------------------------------------
// string[]
// ---------------------------------------------------------------------------
{
  const initial = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const native = [...initial];
  const shared = arena.shared<string[]>(nextKey("strarr"), [...initial]);

  benchPair(
    "string[] · read index",
    () => native[3],
    () => shared[3],
  );
  benchPair(
    "string[] · write index",
    () => (native[3] = "z"),
    () => (shared[3] = "z"),
  );
}

// ---------------------------------------------------------------------------
// boolean[]
// ---------------------------------------------------------------------------
{
  const initial = [
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
  ];
  const native = [...initial];
  const shared = arena.shared<boolean[]>(nextKey("boolarr"), [...initial]);

  benchPair(
    "boolean[] · read index",
    () => native[3],
    () => shared[3],
  );
  benchPair(
    "boolean[] · write index",
    () => (native[3] = true),
    () => (shared[3] = true),
  );
}

// ---------------------------------------------------------------------------
// mixed[]
// ---------------------------------------------------------------------------
{
  const initial = [1, "a", true, 2n, 3, "b", false, 4n, 5, "c"];
  const native = [...initial];
  const shared = arena.shared<(number | string | boolean | bigint)[]>(
    nextKey("mixedarr"),
    [...initial],
  );

  benchPair(
    "mixed[] · read index",
    () => native[3],
    () => shared[3],
  );
  benchPair(
    "mixed[] · write index",
    () => (native[3] = 99),
    () => (shared[3] = 99),
  );
}
