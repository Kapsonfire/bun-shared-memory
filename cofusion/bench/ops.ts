/**
 * Canonical list of operation names shared by the compare child processes and
 * the orchestrator. The orchestrator spawns one fresh process per operation so
 * that no two operations share a JIT heat-map (which otherwise deoptimizes
 * later operations, e.g. object reads measured after array writes).
 */
export const OP_NAMES = [
  "number · read",
  "number · write",
  "string · read",
  "string · write",
  "boolean · read",
  "boolean · write",
  "number[] · read index",
  "number[] · write index",
  "string[] · read index",
  "string[] · write index",
  "boolean[] · read index",
  "boolean[] · write index",
  "object · read number prop",
  "object · read string prop",
  "object · read boolean prop",
  "object · write number prop",
  "object · write string prop",
] as const;
