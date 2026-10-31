import { Shared } from "../src/index.ts";
import { benchPair, boundedPush, nextKey } from "./helpers.ts";
import { benchOptions } from "./setup.ts";

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
    "object · read bigint prop",
    () => native.score,
    () => shared.score,
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

// ---------------------------------------------------------------------------
// object · array property access
// ---------------------------------------------------------------------------
{
  const native = makeUser();
  const shared = Shared<User>(nextKey("objarr"), makeUser(), benchOptions);

  benchPair(
    "object · read array prop index",
    () => native.tags[1],
    () => shared.tags[1],
  );
  benchPair(
    "object · write array prop index",
    () => (native.tags[1] = "x"),
    () => (shared.tags[1] = "x"),
  );
  benchPair(
    "object · array prop push",
    boundedPush(native.tags, "d", ["a", "b", "c"]),
    boundedPush(
      shared.tags as unknown as string[],
      "d",
      ["a", "b", "c"],
      10_000,
      () => {
        shared.tags.length = 1;
      },
    ),
  );
}
