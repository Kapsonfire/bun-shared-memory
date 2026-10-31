import { Shared } from "../src/index.ts";
import { benchOptions, benchPair, nextKey } from "./helpers.ts";

interface User {
  id: number;
  name: string;
  active: boolean;
  score: bigint;
  tags: string[];
  nums: number[];
}

const makeUser = (): User => ({
  id: 1,
  name: "Alice",
  active: true,
  score: 100n,
  tags: ["a", "b", "c"],
  nums: [1, 2, 3],
});

// ---------------------------------------------------------------------------
// object · property read / write
// ---------------------------------------------------------------------------
{
  const native = makeUser();
  const shared = Shared<User>(nextKey("obj"), makeUser(), benchOptions);

  benchPair("object · read number prop", () => native.id, () => shared.id);
  benchPair("object · read string prop", () => native.name, () => shared.name);
  benchPair("object · read boolean prop", () => native.active, () => shared.active);
  benchPair("object · read bigint prop", () => native.score, () => shared.score);
  benchPair("object · write number prop", () => (native.id = 2), () => (shared.id = 2));
  benchPair("object · write string prop", () => (native.name = "Bob"), () => (shared.name = "Bob"), 1_000);
}

// ---------------------------------------------------------------------------
// object · array property access
// ---------------------------------------------------------------------------
{
  const native = makeUser();
  const shared = Shared<User>(nextKey("objarr"), makeUser(), benchOptions);

  benchPair("object · read array prop index", () => native.tags[1], () => shared.tags[1]);
  benchPair("object · write array prop index", () => (native.tags[1] = "x"), () => (shared.tags[1] = "x"), 1_000);
  benchPair("object · array prop push", () => native.tags.push("d"), () => shared.tags.push("d"), 1_000);
}
