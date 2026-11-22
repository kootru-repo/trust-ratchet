export type Specialist = { id: string; focus: string; lookFor: string };

export const SPECIALISTS: Specialist[] = [
  {
    id: "intent",
    focus: "whether the code does what its names, types, comments and callers say it does",
    lookFor: "inverted or wrong conditions, wrong variable used, wrong default, a branch that can never run or always runs, a value computed but not used, behaviour that contradicts the function name or a caller's expectation",
  },
  {
    id: "nullflow",
    focus: "missing values and control flow",
    lookFor: "undefined or null reaching a property access or call, empty string or empty array or zero treated as missing (truthiness checks, || where ?? is needed, filter(Boolean)), optional chaining that silently skips needed work, early returns that skip cleanup, off-by-one and boundary cases, unhandled switch cases",
  },
  {
    id: "async",
    focus: "ordering and timing of asynchronous work",
    lookFor: "a promise that is not awaited, work that runs before the thing it depends on has finished, stale values captured by a callback or timer, races between two async paths, errors swallowed by a missing catch, steps performed in the wrong order",
  },
  {
    id: "types",
    focus: "places where the type system has been switched off or the runtime shape can differ from the declared type",
    lookFor: "casts with `as`, non-null `!`, `any`, JSON or external data used without validation, a schema (zod or other) that does not match the data it parses, a comparison between values of different runtime types",
  },
  {
    id: "react",
    focus: "React state, effects and event handling",
    lookFor: "stale state or props in a handler or effect, missing or wrong dependency arrays, state updated from an outdated value, effects without cleanup, handlers attached to the wrong element or event, focus and selection handled at the wrong moment, keys that make React reuse the wrong element",
  },
];

const byId = (id: string): Specialist => {
  const found = SPECIALISTS.find((s) => s.id === id);
  if (!found) throw new Error(`unknown specialist: ${id}`);
  return found;
};

/** Chooses which specialists are worth running on a file. Deterministic, so a run can be repeated exactly. */
export const pickSpecialists = ({ file, content }: { file: string; content: string }): Specialist[] => {
  const ids = ["intent", "nullflow"];
  if (/\basync\b|\bawait\b|\bPromise\b|\.then\(|setTimeout|setInterval|requestAnimationFrame/.test(content)) ids.push("async");
  if (/\bas\s+(?!const\b)[A-Za-z{[(]|\bany\b|[\w)\]]!\.|[\w)\]]!\)|JSON\.parse|\bz\.[a-z]+\(/.test(content)) ids.push("types");
  if (/\.tsx$/.test(file) || /\buse[A-Z]\w*\(/.test(content)) ids.push("react");
  return ids.map(byId);
};
