import { Shared } from "../src/index.ts";
import { benchOptions, benchPair, nextKey } from "./helpers.ts";

// ---------------------------------------------------------------------------
// number[]
// ---------------------------------------------------------------------------
{
  const native = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const shared = Shared<number[]>(nextKey("numarr"), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], benchOptions);

  benchPair("number[] · read index", () => native[3], () => shared[3]);
  benchPair("number[] · write index", () => (native[3] = 99), () => (shared[3] = 99), 1_000);
  benchPair("number[] · push", () => native.push(11), () => shared.push(11), 1_000);
  benchPair("number[] · pop", () => native.pop(), () => shared.pop(), 1_000);
}

// ---------------------------------------------------------------------------
// string[]
// ---------------------------------------------------------------------------
{
  const native = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  const shared = Shared<string[]>(nextKey("strarr"), ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], benchOptions);

  benchPair("string[] · read index", () => native[3], () => shared[3]);
  benchPair("string[] · write index", () => (native[3] = "z"), () => (shared[3] = "z"), 1_000);
  benchPair("string[] · push", () => native.push("k"), () => shared.push("k"), 1_000);
  benchPair("string[] · pop", () => native.pop(), () => shared.pop(), 1_000);
}

// ---------------------------------------------------------------------------
// boolean[]
// ---------------------------------------------------------------------------
{
  const native = [true, false, true, false, true, false, true, false, true, false];
  const shared = Shared<boolean[]>(nextKey("boolarr"), [true, false, true, false, true, false, true, false, true, false], benchOptions);

  benchPair("boolean[] · read index", () => native[3], () => shared[3]);
  benchPair("boolean[] · write index", () => (native[3] = true), () => (shared[3] = true), 1_000);
  benchPair("boolean[] · push", () => native.push(true), () => shared.push(true), 1_000);
  benchPair("boolean[] · pop", () => native.pop(), () => shared.pop(), 1_000);
}

// ---------------------------------------------------------------------------
// bigint[]
// ---------------------------------------------------------------------------
{
  const native = [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n];
  const shared = Shared<bigint[]>(nextKey("bigarr"), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n], benchOptions);

  benchPair("bigint[] · read index", () => native[3], () => shared[3]);
  benchPair("bigint[] · write index", () => (native[3] = 99n), () => (shared[3] = 99n), 1_000);
  benchPair("bigint[] · push", () => native.push(11n), () => shared.push(11n), 1_000);
  benchPair("bigint[] · pop", () => native.pop(), () => shared.pop(), 1_000);
}

// ---------------------------------------------------------------------------
// mixed[]
// ---------------------------------------------------------------------------
{
  const native = [1, "a", true, 2n, 3, "b", false, 4n, 5, "c"];
  const shared = Shared<(number | string | boolean | bigint)[]>(nextKey("mixedarr"), [1, "a", true, 2n, 3, "b", false, 4n, 5, "c"], benchOptions);

  benchPair("mixed[] · read index", () => native[3], () => shared[3]);
  benchPair("mixed[] · write index", () => (native[3] = 99), () => (shared[3] = 99), 1_000);
  benchPair("mixed[] · push", () => native.push(11), () => shared.push(11), 1_000);
  benchPair("mixed[] · pop", () => native.pop(), () => shared.pop(), 1_000);
}
