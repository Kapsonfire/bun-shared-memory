import { Shared } from "../src/index.ts";
import { benchPair, boundedPush, nextKey } from "./helpers.ts";
import { benchOptions } from "./setup.ts";

// ---------------------------------------------------------------------------
// number[]
// ---------------------------------------------------------------------------
{
  const initial = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const native = [...initial];
  const shared = Shared<number[]>(
    nextKey("numarr"),
    [...initial],
    benchOptions,
  );

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
  benchPair(
    "number[] · push",
    boundedPush(native, 11, initial),
    boundedPush(shared as unknown as number[], 11, initial),
  );
  benchPair(
    "number[] · pop",
    () => native.pop(),
    () => shared.pop(),
  );
}

// ---------------------------------------------------------------------------
// string[]
// ---------------------------------------------------------------------------
{
  const initial = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const native = [...initial];
  const shared = Shared<string[]>(
    nextKey("strarr"),
    [...initial],
    benchOptions,
  );

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
  benchPair(
    "string[] · push",
    boundedPush(native, "k", initial),
    boundedPush(shared as unknown as string[], "k", initial),
  );
  benchPair(
    "string[] · pop",
    () => native.pop(),
    () => shared.pop(),
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
  const shared = Shared<boolean[]>(
    nextKey("boolarr"),
    [...initial],
    benchOptions,
  );

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
  benchPair(
    "boolean[] · push",
    boundedPush(native, true, initial),
    boundedPush(shared as unknown as boolean[], true, initial),
  );
  benchPair(
    "boolean[] · pop",
    () => native.pop(),
    () => shared.pop(),
  );
}

// ---------------------------------------------------------------------------
// bigint[]
// ---------------------------------------------------------------------------
{
  const initial = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
  const native = [...initial];
  const shared = Shared<bigint[]>(
    nextKey("bigarr"),
    [...initial],
    benchOptions,
  );

  benchPair(
    "bigint[] · read index",
    () => native[3],
    () => shared[3],
  );
  benchPair(
    "bigint[] · write index",
    () => (native[3] = 99n),
    () => (shared[3] = 99n),
  );
  benchPair(
    "bigint[] · push",
    boundedPush(native, 11n, initial),
    boundedPush(shared as unknown as bigint[], 11n, initial),
  );
  benchPair(
    "bigint[] · pop",
    () => native.pop(),
    () => shared.pop(),
  );
}

// ---------------------------------------------------------------------------
// mixed[]
// ---------------------------------------------------------------------------
{
  const initial = [1, "a", true, 2n, 3, "b", false, 4n, 5, "c"];
  const native = [...initial];
  const shared = Shared<(number | string | boolean | bigint)[]>(
    nextKey("mixedarr"),
    [...initial],
    benchOptions,
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
  benchPair(
    "mixed[] · push",
    boundedPush(native, 11, initial),
    boundedPush(
      shared as unknown as (number | string | boolean | bigint)[],
      11,
      initial,
    ),
  );
  benchPair(
    "mixed[] · pop",
    () => native.pop(),
    () => shared.pop(),
  );
}
