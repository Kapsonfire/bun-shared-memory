import { benchPair, nextKey, arena } from "./helpers.ts";

interface User {
  id: number;
  name: string;
  active: boolean;
  score: number;
}

const makeUser = (): User => ({
  id: 1,
  name: "Alice",
  active: true,
  score: 100,
});

// ---------------------------------------------------------------------------
// object · property read / write
// ---------------------------------------------------------------------------
{
  const native = makeUser();
  const shared = arena.shared<User>(nextKey("obj"), makeUser());

  benchPair(
    "object · read number prop",
    () => native.id,
    () => shared.id,
  );
  benchPair(
    "object · read string prop",
    () => native.name,
    () => shared.name,
  );
  benchPair(
    "object · read boolean prop",
    () => native.active,
    () => shared.active,
  );
  benchPair(
    "object · write number prop",
    () => (native.id = 2),
    () => (shared.id = 2),
  );
  benchPair(
    "object · write string prop",
    () => (native.name = "Bob"),
    () => (shared.name = "Bob"),
  );
}
