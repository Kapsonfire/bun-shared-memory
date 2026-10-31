import { Shared } from "../src/index.ts";
import { benchOptions, benchPair, nextKey } from "./helpers.ts";

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------
{
  const native = 42;
  const shared = Shared<number>(nextKey("num"), 42, benchOptions);

  benchPair("number · read", () => native, () => shared.read());
  benchPair("number · write", () => native, () => shared.write(7));
}

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------
{
  const native = "hello world";
  const shared = Shared<string>(nextKey("str"), "hello world", benchOptions);

  benchPair("string · read", () => native, () => shared.read());
  benchPair("string · write", () => native, () => shared.write("new value"), 10_000);
}

// ---------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------
{
  const native = true;
  const shared = Shared<boolean>(nextKey("bool"), true, benchOptions);

  benchPair("boolean · read", () => native, () => shared.read());
  benchPair("boolean · write", () => native, () => shared.write(false));
}

// ---------------------------------------------------------------------------
// bigint
// ---------------------------------------------------------------------------
{
  const native = 12345678901234567890n;
  const shared = Shared<bigint>(nextKey("big"), 12345678901234567890n, benchOptions);

  benchPair("bigint · read", () => native, () => shared.read());
  benchPair("bigint · write", () => native, () => shared.write(999n));
}
