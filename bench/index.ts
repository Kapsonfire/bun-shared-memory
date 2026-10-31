import "./primitives.ts";
import "./arrays.ts";
import "./objects.ts";
import "./cache.ts";
import { printSummary } from "./helpers.ts";
import { keepAlive } from "./setup.ts";

keepAlive();
await printSummary();
