import { Shared } from "../src/index.ts";
import { benchPair, nextKey } from "./helpers.ts";
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
}

// ---------------------------------------------------------------------------
// object · nested object property access (`o.sub.x`)
// ---------------------------------------------------------------------------
{
  interface Profile {
    id: number;
    address: { city: string; zip: number };
  }
  const makeProfile = (): Profile => ({
    id: 1,
    address: { city: "Berlin", zip: 10115 },
  });
  const native = makeProfile();
  const shared = Shared<Profile>(
    nextKey("objnest"),
    makeProfile(),
    benchOptions,
  );

  benchPair(
    "object · read nested prop",
    () => native.address.zip,
    () => shared.address.zip,
  );
  benchPair(
    "object · write nested prop",
    () => (native.address.zip = 2),
    () => (shared.address.zip = 2),
  );
}
