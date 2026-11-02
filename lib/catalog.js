/**
 * The runtime Claude model catalog in the harness vocabulary.
 *
 * A route serves what its account selector reading (else the published
 * catalog) says, and nothing before a reading lands.
 * `lib/catalog-source.js` owns the sources; this module owns the mapping, the
 * wire-behaviour defaults the catalog does not carry, and saved-list resolution.
 *
 * @module @apcamargo/dsh-claude-subscription/catalog
 */

/**
 * @typedef {object} ModelSpec
 * @property {string} id
 * @property {string} name
 * @property {number} contextWindow
 * @property {number} maxTokens
 * @property {string[]} [input] - request modalities. Defaults to text + image.
 * @property {string} [defaultEffort] - the level an unset caller preference resolves to; must be declared. Defaults to `high` (or the highest declared level).
 * @property {Record<string, string | null>} [thinkingLevelMap] - harness level -> Anthropic effort. Null hides a level.
 * @property {Record<string, unknown>} [compat]
 * @property {"in-history"} [systemPromptUpdate] - the model reads the latest `system` message at any
 *   position as the effective prompt, so a mid-conversation system message is legal on an API-key
 *   request. The catalog does not expose this; on OAuth the adapter declares the mode for every model
 *   and the wire delivers an appended prompt as a `<system-reminder>` user turn (see lib/wire.js).
 */
/**
 * One configured model entry, as the Models page writes it. Only the id is
 * required. Every other field falls back to the route's catalog reading, or to
 * a neutral default.
 * @typedef {object} ConfiguredModel
 * @property {string} id
 * @property {string} [name]
 * @property {number} [contextWindow]
 * @property {number} [maxTokens]
 * @property {string[]} [input]
 */
/**
 * @typedef {object} HarnessModel
 * @property {string} provider
 * @property {string} id
 * @property {string} name
 * @property {string[]} inputModalities
 * @property {{ contextWindow: number }} context
 * @property {number} defaultMaxTokens
 * @property {{ efforts: { id: string, name: string }[], defaultEffort?: string }} [reasoning]
 * @property {"in-history"} [systemPromptUpdate] - mid-conversation system messages are accepted. See the ModelSpec note.
 */

/** Every harness thinking level, in escalation order. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Context capacity assumed for a configured model the reading does not size. */
export const DEFAULT_CONTEXT_WINDOW = 262144;

/** Output capability assumed for a configured model the reading does not size. */
export const DEFAULT_MAX_TOKENS = 32768;

/** Modalities assumed for a configured model that declares none. */
export const DEFAULT_INPUT = ["text", "image"];

/** Every level hidden. An adaptive model with no advertised ladder gets this. */
const NO_LEVELS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
  max: null,
};

/**
 * The thinking levels one model supports, in escalation order. An explicit
 * `null` hides a level. `xhigh` and `max` exist only when the map names them;
 * every other level (including `off`) is supported unless explicitly hidden.
 * @param {ModelSpec} model
 * @returns {string[]}
 */
export function supportedLevels(model) {
  if (model.reasoning === false) return ["off"];
  return LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** `claude-opus-5-5` -> [5, 5]; an unknown family -> undefined. */
function generationOf(id) {
  const match = /^claude-(?:[a-z]+)-(\d+)(?:-(\d+))?/.exec(id);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2] ?? 0)];
}

/**
 * The wire-behaviour profile of one model id.
 *
 * The catalog does not carry these flags: they describe the request shape, not
 * the model's capacities. They come from the family generation, which is what
 * makes a newly shipped model usable without a plugin release. The
 * 5-generation (Fable, Opus 5, the 5.5 family) forces adaptive thinking, rejects
 * a caller temperature, and rejects a request with thinking disabled. Every
 * documented 4.5+ model accepts strict tools.
 *
 * `hideOff` is part of the same profile: the newer families reject thinking
 * disabled, so the harness ladder must not offer "off".
 * @param {string} id
 * @returns {{ compat: Record<string, unknown>, hideOff: boolean }}
 */
export function behaviorFor(id) {
  const generation = generationOf(id);
  const adaptive = generation !== undefined && generation[0] >= 5;
  return {
    compat: adaptive
      ? { forceAdaptiveThinking: true, supportsTemperature: false, supportsStrictTools: true }
      : { supportsStrictTools: true },
    hideOff: adaptive,
  };
}

/** A harness level map that offers exactly the advertised efforts. */
function thinkingMapFor(levels, hideOff) {
  const offered = new Set(levels);
  const map = {};
  if (hideOff) map.off = null;
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    map[level] = offered.has(level) ? level : null;
  }
  return map;
}

/** The picker name, in the "Claude <family>" style the rest of the plugin uses. */
function displayName(name) {
  return /^claude\b/i.test(name) ? name : `Claude ${name}`;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * One fetched catalog entry as a servable spec.
 *
 * Capacities and the effort ladder come from the catalog, the wire-behaviour
 * flags from {@link behaviorFor}. A row that advertises no ladder gets the
 * budget-based levels when its family predates adaptive thinking, and no
 * reasoning level at all when it does not. Never an inferred effort the model
 * may reject.
 * @param {object} entry - one normalized entry (lib/catalog-source.js).
 * @returns {ModelSpec}
 */
export function entryToSpec(entry) {
  const behavior = behaviorFor(entry.id);
  const levels =
    Array.isArray(entry.effortLevels) && entry.effortLevels.length > 0
      ? entry.effortLevels
      : undefined;
  let thinkingLevelMap;
  let defaultEffort;
  if (levels !== undefined) {
    thinkingLevelMap = thinkingMapFor(levels, behavior.hideOff);
    defaultEffort = entry.defaultEffort;
  } else if (behavior.compat.forceAdaptiveThinking === true) {
    thinkingLevelMap = NO_LEVELS;
  } else {
    thinkingLevelMap = undefined;
  }
  return {
    id: entry.id,
    name: displayName(entry.name ?? entry.id),
    contextWindow: positiveInteger(entry.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: positiveInteger(entry.maxTokens) ?? DEFAULT_MAX_TOKENS,
    input:
      Array.isArray(entry.input) && entry.input.length > 0 ? [...entry.input] : [...DEFAULT_INPUT],
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    compat: behavior.compat,
  };
}

/**
 * The models this route may offer: the account's catalog reading, else the
 * published catalog, else nothing. A route serves exactly what its reading
 * says. A saved list is still resolved (see {@link resolveCatalog}), so a user
 * who curated one keeps it.
 * @param {object[] | undefined} served - `catalog.accounts.<route>.models`.
 * @param {object[] | undefined} published - `catalog.published.models`.
 * @returns {ModelSpec[]}
 */
export function availableCatalog(served, published) {
  const source =
    Array.isArray(served) && served.length > 0
      ? served
      : Array.isArray(published) && published.length > 0
        ? published
        : [];
  const specs = [];
  const seen = new Set();
  for (const entry of source) {
    if (typeof entry?.id !== "string" || seen.has(entry.id)) continue;
    seen.add(entry.id);
    specs.push(entryToSpec(entry));
  }
  return specs;
}

/**
 * The effective catalog: the user's configured list when one is saved, else the
 * route's available catalog.
 *
 * A configured entry inherits the reading's capacities, thinking ladder,
 * behaviour flags, and default effort for every field it leaves out, so a
 * hand-written `[{ id: "claude-opus-5-5" }]` is complete. An id the reading
 * does not carry is served with neutral defaults: the user asked for it, and
 * the request layer can still send it.
 * @param {ConfiguredModel[] | undefined} entries - the live `accounts.models.<route>` value.
 * @param {ModelSpec[]} [available] - {@link availableCatalog}'s result.
 * @returns {ModelSpec[]}
 */
export function resolveCatalog(entries, available = []) {
  if (!Array.isArray(entries) || entries.length === 0) return available;
  const inheritedIndex = new Map(available.map((model) => [model.id, model]));
  return entries.flatMap((entry) => {
    if (typeof entry?.id !== "string" || entry.id.length === 0) return [];
    const inherited = inheritedIndex.get(entry.id);
    const capacity = (configured, fallback) =>
      Number.isInteger(configured) && configured > 0 ? configured : fallback;
    /** @type {ModelSpec} */
    return [
      {
        id: entry.id,
        name:
          typeof entry.name === "string" && entry.name.length > 0
            ? entry.name
            : (inherited?.name ?? entry.id),
        contextWindow: capacity(
          entry.contextWindow,
          inherited?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        ),
        maxTokens: capacity(entry.maxTokens, inherited?.maxTokens ?? DEFAULT_MAX_TOKENS),
        input:
          Array.isArray(entry.input) && entry.input.length > 0
            ? [...entry.input]
            : (inherited?.input ?? [...DEFAULT_INPUT]),
        ...(inherited?.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: inherited.thinkingLevelMap }),
        ...(inherited?.compat === undefined ? {} : { compat: inherited.compat }),
        ...(inherited?.defaultEffort === undefined
          ? {}
          : { defaultEffort: inherited.defaultEffort }),
      },
    ];
  });
}

/**
 * The spec one request names. A saved list is authoritative; otherwise the
 * reading is. An id neither carries is not served, so the harness reports
 * `UNKNOWN_MODEL` until a reading lands.
 * @param {ModelSpec[]} available
 * @param {ConfiguredModel[] | undefined} entries
 * @param {string} id
 * @returns {ModelSpec | undefined}
 */
export function specForRequest(available, entries, id) {
  return resolveCatalog(entries, available).find((model) => model.id === id);
}

/**
 * Harness model metadata for one catalog entry.
 *
 * `defaultMaxTokens` is the OAuth clamp, not the model ceiling: the harness
 * applies it whenever the caller names no cap, which is the common case on the
 * subscription path this plugin exists for. The wire layer re-applies the clamp,
 * and an explicit per-call cap is always honoured.
 *
 * `defaultEffort` must be one of the declared levels. The harness resolves an
 * unset caller preference to it and refuses undeclared levels outright.
 * @param {string} provider - the provider route id.
 * @param {ModelSpec} model
 * @returns {HarnessModel}
 */
export function toHarnessModel(provider, model) {
  const levels = supportedLevels(model);
  const reasoning = levels.map((level) => ({
    id: level,
    name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
  }));
  const effortIds = reasoning.map((effort) => effort.id);
  return {
    provider,
    id: model.id,
    name: model.name,
    inputModalities: [...(model.input ?? DEFAULT_INPUT)],
    context: { contextWindow: model.contextWindow },
    defaultMaxTokens: Math.min(model.maxTokens, 64000),
    ...(model.systemPromptUpdate === undefined
      ? {}
      : { systemPromptUpdate: model.systemPromptUpdate }),
    ...(reasoning.length > 0
      ? {
          reasoning: {
            efforts: reasoning,
            // Thinking on by default, matching Claude Code's own default. The
            // "off" level reaches the wire as an omitted thinking block. The
            // catalog's default effort wins when it is a declared level.
            defaultEffort: effortIds.includes(model.defaultEffort ?? "")
              ? model.defaultEffort
              : effortIds.includes("high")
                ? "high"
                : effortIds.at(-1),
          },
        }
      : {}),
  };
}

/**
 * The discovery payload the Models page's "Fetch models" action adopts and the
 * browser card's add picker lists, projected from whatever list the route
 * offers (never the user's saved list, or the picker would offer nothing).
 * @param {ModelSpec[]} [models]
 * @returns {{ id: string, name: string, contextWindow: number, maxTokens: number, inputModalities: string[] }[]}
 */
export function discoveryModels(models = []) {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    inputModalities: [...(model.input ?? DEFAULT_INPUT)],
  }));
}
