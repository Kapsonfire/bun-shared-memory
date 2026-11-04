import { benchPair, nextKey, arena } from "./helpers.ts";

// ---------------------------------------------------------------------------
// number
// ---------------------------------------------------------------------------
{
  const native = 42;
  const shared = arena.shared<number>(nextKey("num"), 42);

  benchPair(
    "number · read",
    () => native,
    () => shared.read(),
  );
  benchPair(
    "number · write",
    () => native,
    () => shared.write(7),
  );
}

// ---------------------------------------------------------------------------
// string
// ---------------------------------------------------------------------------
{
  const native = "hello world";
  const shared = arena.shared<string>(nextKey("str"), "hello world");

  benchPair(
    "string · read",
    () => native,
    () => shared.read(),
  );
  benchPair(
    "string · write",
    () => native,
    () => shared.write("new value"),
  );
}

// ---------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------
{
  const native = true;
  const shared = arena.shared<boolean>(nextKey("bool"), true);

  benchPair(
    "boolean · read",
    () => native,
    () => shared.read(),
  );
  benchPair(
    "boolean · write",
    () => native,
    () => shared.write(false),
  );
}
