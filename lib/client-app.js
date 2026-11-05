/**
 * The card's Host operations, bound to the browser Remote namespaces. Top-level
 * so tests can drive it. The generated bundle inlines it beside its caller.
 * @param {object} remote - the browser Remote root (`settings`, `llm`, `$on`).
 * @param {string} settingsNs - the settings namespace this card edits.
 */
export function createOperations(remote, settingsNs) {
  const onEvent = (name, listener) => {
    const off = remote.$on?.(name, listener);
    return typeof off === "function" ? off : () => {};
  };
  return {
    describe: () => remote.settings.describe(),
    // `provider` names the discovery target. The Models page's own call
    // passes the settings namespace (the available catalog). The composer
    // indicator pings `ping:<route>` so the host refreshes exactly the
    // selected model's account (lib/index.js parses the prefix).
    discoverModels: (provider) =>
      remote.llm.discoverModels(settingsNs, { provider: provider ?? settingsNs }),
    writeModels: (ops, expectedRevision) =>
      remote.settings.mutate(settingsNs, ops, expectedRevision),
    onAdaptersUpdated: (listener) => onEvent("llm/adapters-updated", listener),
    // The account-email mirror (and every other settings write, the usage
    // engine's snapshot publishes included) bumps the document revision and
    // publishes this event, the same pushed invalidation the vanilla page
    // reloads on. It is what makes a sign-in elsewhere refresh the email
    // line, and a background usage fetch refresh the indicator, without a
    // page reload.
    onSettingsUpdated: (listener) => onEvent("settings/document-updated", listener),
    /** One forwarded Host event with the same degrade-to-no-op fallback. */
    onEvent,
  };
}

/**
 * The browser card's composition root: everything the ModuleLoader bundle needs
 * except React and the pure helpers, which are injected.
 * `scripts/build-client.mjs` serializes it (and `client-models.js`) into the
 * factory-form bundle the web frontend loads.
 *
 * @param {{ React: object, ReactDOM?: object, helpers: object, pluginName: string, primitives?: object }} deps
 *   `primitives` carries the host's shared UI modules; without it, surfaces
 *   degrade to no tooltip and CSS-anchored panels. `ReactDOM` carries
 *   `createPortal` for the panel seat; a host without it renders inline.
 * @returns {{ name: string, inject: string[], apply: (ctx: object) => void }}
 */
export function createClientApp({ React, ReactDOM, helpers, pluginName, primitives }) {
  const {
    SETTINGS_NS,
    CATALOG_PREFIX,
    CATALOG_REFRESH_SUFFIX,
    isAccountRoute,
    normalizeRow,
    availableModelIds,
    setModelsOp,
    unsetModelsOp,
    readAccounts,
    rowsDiffer,
    parseUsageText,
    parseAccountText,
    popoverAlign,
    normalizeUsageView,
    resetDetail,
    withoutClock,
    ACCOUNT_TAG,
    EXTRA_LABEL,
    FIVE_HOUR_LABEL,
  } = helpers;
  const h = React.createElement;
  /** The host's shared Tooltip (the context meter's), when the shared module resolves. */
  const Tooltip = primitives?.Tooltip;
  /**
   * The shared trigger-anchored placement hook behind the vanilla stat
   * dialog (DialogPill's seat): portal coordinates, viewport-clamped, with
   * the side and alignment declared by the caller.
   */
  const useAnchoredPosition = primitives?.useAnchoredPosition;
  /** The ping marker of a model selection: the host refreshes past its cooldown. */
  const SELECT_PING = "select";
  const SELECT_SUFFIX = "#select";
  /** Whether that primitive resolved. Gates the panel's fixed portal seat. */
  const anchored = useAnchoredPosition !== undefined;

  /**
   * The local dismissal fallback: today's capture-phase click containment for
   * a host whose primitives module carries no `useDismissOnOutsidePointer`.
   * Containment, not propagation stopping. The panel is portaled out of this
   * component's subtree, so panel clicks must be recognized, not blocked.
   * Same signature as the shared hook so the call site is one hook either way.
   */
  function useLocalOutsideDismiss(anchorRef, open, onDismiss, panelRef) {
    React.useEffect(() => {
      if (
        !open ||
        typeof document === "undefined" ||
        typeof document.addEventListener !== "function"
      )
        return;
      const onClick = (event) => {
        if (
          event.target instanceof Node &&
          anchorRef.current?.contains(event.target) !== true &&
          panelRef.current?.contains(event.target) !== true
        )
          onDismiss();
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    }, [anchorRef, open, onDismiss, panelRef]);
  }

  /**
   * The shared outside-pointer dismissal (the vanilla stat dialog's), or the
   * local fallback above. The choice is fixed when the factory runs, so the hook
   * identity, and therefore the call order in every component, never changes
   * between renders. Escape is plugin-local in both cases: the shared hook
   * handles pointer dismissal only.
   */
  const useOutsideDismiss = primitives?.useDismissOnOutsidePointer ?? useLocalOutsideDismiss;

  /** The Claude logo's path, drawn in the 0-100 box. Shared by the panel sparks and the composer mark's two layers. */
  const SPARK_PATH =
    "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";

  /**
   * The Claude spark mark: the plan-panel headers' icon, and the clay layer
   * of the composer's depletion mark (same class, one fill). Fill rides the
   * stylesheet's one --dsh-cs-brand-clay definition (see the CSS block).
   */
  function ClaudeSpark({ size = 16 }) {
    return h(
      "svg",
      {
        viewBox: "0 0 100 100",
        width: size,
        height: size,
        className: "dsh-cs-spark",
        "aria-hidden": true,
      },
      h("path", { d: SPARK_PATH }),
    );
  }

  /** The fully-neutral mark: an account with no reading (pending fetch, or a
   * token the endpoint refused) draws the base mark only. */
  function neutralMark() {
    return h(
      "svg",
      { viewBox: "0 0 100 100", width: 14, height: 14, "aria-hidden": true },
      h("path", { d: SPARK_PATH, className: "dsh-cs-pieDepleted" }),
    );
  }

  /**
   * The browser-side, per-account usage cache: one versioned localStorage key per
   * route. A same-document event tells the indicator (and any second tab) that a
   * cache moved. The host's published snapshot is the source; this is its
   * browser-side rendering.
   */
  const USAGE_CACHE_PREFIX = "claude-subscription:usage:v2:";
  const USAGE_CACHE_EVENT = "claude-subscription:usage-updated";

  /** The cached plan panel of one account, or undefined when absent/unusable. */
  function readUsageCache(route) {
    try {
      const raw = localStorage.getItem(USAGE_CACHE_PREFIX + route);
      if (raw === null) return undefined;
      const value = JSON.parse(raw);
      if (value === null || typeof value !== "object" || !Array.isArray(value.windows))
        return undefined;
      // planLabel string-matches the plan, so a corrupted cache must not
      // crash the slot entry: a non-string plan degrades to "absent".
      if (typeof value.plan !== "string") value.plan = null;
      return value;
    } catch {
      return undefined;
    }
  }

  /** Store one account's cache, or remove it when the snapshot is empty. */
  function writeUsageCache(route, value) {
    try {
      localStorage.setItem(USAGE_CACHE_PREFIX + route, JSON.stringify(value));
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent(USAGE_CACHE_EVENT));
      }
    } catch {
      // Storage unavailable (private mode, hardened browser): the indicator keeps
      // whatever it rendered.
    }
  }

  /**
   * Subscribe to one host store (the session model directory's snapshot store).
   * The directory itself is an implementation-level host surface
   * (dsh-client-ui-model-selection), so every use is guarded: a host without it,
   * or an unexpected shape, reads as "no selection", and the indicator hides
   * rather than guessing an account.
   */
  function useStoreSnapshot(store) {
    const subscribe = React.useCallback(
      (onChange) =>
        store !== null && typeof store?.subscribe === "function"
          ? store.subscribe(onChange)
          : () => {},
      [store],
    );
    const getSnapshot = React.useCallback(
      () =>
        store !== null && typeof store?.getSnapshot === "function"
          ? store.getSnapshot()
          : undefined,
      [store],
    );
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  }

  const CSS = `
:root {
  /* Brand clay. The host theme ships no token for it, so it is defined once
     here and every use references this variable. */
  --dsh-cs-brand-clay: #d97757;
  /* Type roles. The host theme ships no type tokens. Its compiled stylesheets
     carry literal size/weight/leading per class, so each role below is the
     measurement of the vanilla class named beside it (dsh 0.2.1-rc.5, from
     dsh-client-ui-settings-models' ModelsSection.module.css unless noted).
     Every font-size / line-height / font-weight rule references one of them,
     so a retune is one edit here. */
  /* [fieldLabel], [customizedSummary], [modelCatalogTitle]. One role: the
     labels above a field, the collapsible-section summary, the list heading. */
  --dsh-cs-type-label-size: 12px;
  --dsh-cs-type-label-weight: 500;
  --dsh-cs-type-label-leading: 18px;
  /* [advancedHint], [modelEmpty], [modelFieldLabel], [editorRoute], [error],
     [notice], [savedNotice], [linkButton], the help/status line under a
     label, one step dimmer than the label itself. */
  --dsh-cs-type-meta-size: 12px;
  --dsh-cs-type-meta-leading: 18px;
  /* [input], [intro], [addButton], [dangerButton]: control and body text. */
  --dsh-cs-type-body-size: 14px;
  --dsh-cs-type-body-leading: 22px;
  /* [editorTitle], [rowName]: the card's own heading. */
  --dsh-cs-type-title-size: 14px;
  --dsh-cs-type-title-weight: 500;
  --dsh-cs-type-title-leading: 22px;
  /* [candidateId], [modelReasoningValueInput]: model ids, in the code face. */
  --dsh-cs-type-code-size: 13px;
  --dsh-cs-type-code-leading: 22px;
  /* The account panels reproduce the vanilla provider editor box
     [editor] (dsh-client-ui-settings-models ModelsSection.module.css, measured
     against dsh 0.2.1-rc.5): radius-lg, bg-module-platform, 14px 16px padding,
     14px gap. Fill and radius keep their host aliases. Both spacing literals
     live here, the horizontal one as the shared inset below, so a host retune
     is one edit. */
  --dsh-cs-panel-padding: 14px var(--dsh-cs-inset);
  --dsh-cs-panel-gap: 14px;
  /* The command card's roles, lifted from a different vanilla surface
     (deliverables' changed-files card): title 13/500/20, 10/16 subtitle.
     Its guidance footer takes the meta role so it lines up with the rows. */
  --dsh-cs-type-card-title-size: 13px;
  --dsh-cs-type-card-title-weight: 500;
  --dsh-cs-type-card-title-leading: 20px;
  --dsh-cs-type-sub-size: 10px;
  --dsh-cs-type-sub-leading: 16px;
  /* The one content inset every surface that has to line up reads: the usage
     panel's dialog (the composer popover), the command card's header, rows and
     list, and the Models editor panel's horizontal padding. A single token is
     what keeps them together, the same way every type role above is one
     variable. The vertical rhythm is half the inset on the rows plus half on
     the list, so the card's first and last rows sit exactly one inset in. */
  --dsh-cs-inset: 16px;
}
/* The card is a shell / list container, not a vanilla row: it borrows the
   provider row card's surface [rowCard] (settings-card fill/stroke, radius-xl,
   12px 14px, 12px gap) because it sits alone in the Models footer. Each account
   is the grey editor box [editor] a row card holds. Inside a panel, the model
   list is the vanilla catalog [modelCatalog: border-top .5px border-l2, 12px
   padding-top, 10px gap] and the footer is [editorActions]. The account head
   follows [editorHeader]/[editorTitle]/[editorRoute] but stacks title over
   descriptor, an adaptation of vanilla's baseline row, because org · plan ·
   state is long. Type values never appear as literals here. */
.dsh-cs-card { border: 0.5px solid var(--dsw-alias-settings-card-stroke); background: var(--dsw-alias-settings-card-fill); border-radius: var(--dsw-radius-xl); padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
/* [editor]: the grey surface one account occupies. No border, no shadow; the
   fill alone separates it from the card, like the vanilla provider editor. */
.dsh-cs-panel { border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-module-platform); display: flex; flex-direction: column; gap: var(--dsh-cs-panel-gap); padding: var(--dsh-cs-panel-padding); }
/* [editorTitle]/[rowName]: the panel's own subject (an account email). Truncates
   rather than overflows; the full value stays in the title attribute. */
.dsh-cs-panelTitle { min-width: 0; max-width: 100%; color: var(--dsw-alias-label-primary); font-size: var(--dsh-cs-type-title-size); font-weight: var(--dsh-cs-type-title-weight); line-height: var(--dsh-cs-type-title-leading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Every action row centres its button vertically. Vanilla's [modelListHead] is
   align-items: flex-start, which reads too high beside the card's 28px button and
   two-line 38px heading (a real render put the button's centre 5px above the
   heading's). */
.dsh-cs-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.dsh-cs-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: var(--dsh-cs-type-title-size); font-weight: var(--dsh-cs-type-title-weight); line-height: var(--dsh-cs-type-title-leading); }
.dsh-cs-headerActions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.dsh-cs-account { margin: 0; font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }
/* [modelCatalog]: the model list inside a panel. The panels delimit accounts,
   so this hairline only separates the catalog from the panel header. */
.dsh-cs-section { border-top: 0.5px solid var(--dsw-alias-border-l2); display: flex; flex-direction: column; gap: 10px; padding-top: 12px; }
/* [modelListHead] / [modelCatalogHeading] / [modelCatalogTitle] /
   [modelCatalogMeta], the parts, the type roles and the 12px gap. The
   alignment is the card's own (see the rule above), not vanilla's. */
.dsh-cs-sectionHead { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; }
.dsh-cs-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-cs-headingTitle { color: var(--dsw-alias-label-secondary); font-size: var(--dsh-cs-type-label-size); font-weight: var(--dsh-cs-type-label-weight); line-height: var(--dsh-cs-type-label-leading); }
.dsh-cs-meta { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); }
/* The right-aligned action seat: [modelListHead]'s action inside the editor (the
   models mode toggle) and the panel head's account actions. Vanilla keeps its row
   actions outside the editor but its own catalog head keeps one inside, which is
   the placement followed here. */
.dsh-cs-headActions, .dsh-cs-panelActions { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.dsh-cs-advancedHint { grid-column: 1 / -1; }
/* [modelList] / [modelEntry] / [modelRow] (the id cell replaces vanilla's id
   input: the id is the row's key here, so it is shown, not edited), the
   expanded body [modelAdvanced] / [modelField] / [modelFieldLabel] /
   [modelInputChoices]. */
.dsh-cs-list { display: flex; flex-direction: column; gap: 8px; }
.dsh-cs-entry { border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-lg); padding: 6px; }
.dsh-cs-entryRow { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto auto; align-items: center; gap: 6px; }
.dsh-cs-id { min-width: 0; padding: 0 10px; font-family: var(--ds-font-family-code, monospace); font-size: var(--dsh-cs-type-code-size); line-height: var(--dsh-cs-type-code-leading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cs-advanced { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px 4px 2px; }
.dsh-cs-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.dsh-cs-fieldLabel { color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); }
.dsh-cs-inputTypes { grid-column: 1 / -1; min-width: 0; margin: 0; padding: 0; border: none; }
.dsh-cs-inputTypes legend { margin-bottom: 4px; padding: 0; }
.dsh-cs-choices { display: flex; flex-wrap: wrap; align-items: center; gap: 16px; min-height: 32px; }
.dsh-cs-choice { display: inline-flex; align-items: center; gap: 6px; font-size: var(--dsh-cs-type-body-size); line-height: var(--dsh-cs-type-body-leading); }
/* [modelEmpty]: dashed, centered panel for a list with nothing to edit. */
.dsh-cs-empty { margin: 0; border: 1px dashed var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-lg); text-align: center; padding: 12px; color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); }
.dsh-cs-emptyError { color: var(--dsw-alias-state-error-primary); }
.dsh-cs-addRow { display: flex; align-items: center; gap: 8px; }
/* The add picker's note (catalog loading, failed, or nothing left to add). It
   shares the row with the retry button and must wrap, not push it out. */
.dsh-cs-addNote { flex: 1 1 auto; min-width: 0; }
/* The model picker is the add field: the [input] chrome below, a native select
   underneath (for the platform's own listbox keyboard/AT behaviour), its platform
   arrow suppressed and the card's chevron drawn instead so the control follows the
   theme in both modes. */
.dsh-cs-selectWrap { position: relative; display: flex; flex: 1 1 auto; min-width: 0; }
.dsh-cs-select { flex: 1 1 auto; min-width: 0; appearance: none; -webkit-appearance: none; padding-right: 28px; color-scheme: light; }
/* The native option list follows the document's color scheme, not the app's data
   attribute (the same selector the composer tile above uses): pin it so a dark card
   never opens a light list. */
body[data-ds-dark-theme] .dsh-cs-select { color-scheme: dark; }
.dsh-cs-selectChevron { position: absolute; top: 50%; right: 9px; transform: translateY(-50%); display: inline-flex; align-items: center; color: var(--dsw-alias-label-tertiary); pointer-events: none; }
/* [input]: 32px, 14px/22px, radius-md, border-l4 on bg-layer-1. Focus takes
   the business-primary border, the placeholder label-dimmed. */
.dsh-cs-input { box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); width: 100%; height: 32px; font: inherit; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 0 10px; font-size: var(--dsh-cs-type-body-size); line-height: var(--dsh-cs-type-body-leading); }
.dsh-cs-input:focus { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.dsh-cs-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.dsh-cs-input:disabled { opacity: 0.6; cursor: default; }
/* [addModelButton] (identical to the row-actions [secondaryButton]): 28px,
   radius-sm, 12px/18px, border-l3. */
.dsh-cs-smallButton { box-sizing: border-box; display: inline-flex; align-items: center; gap: 4px; flex: none; height: 28px; padding: 0 10px; font: inherit; font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); background: 0 0; color: var(--dsw-alias-label-primary); cursor: pointer; }
.dsh-cs-smallButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
/* State colours ride the LABEL, never the stroke. The vanilla Models page sets
   [dangerButton] to color: var(--dsw-alias-state-error-primary) with border: none,
   and every bordered small button ([secondaryButton], [addModelButton]) keeps the
   neutral border-l3 whatever its label colour: no vanilla button tints its border
   for a state. DSH's blue is state-business-primary, the same alias as the focus
   ring and reference-chip text. Lightness is the alias's own per theme (red-600
   light / red-400 dark, deepseek-500 light / deepseek-400 dark). Hovers are
   vanilla's too: interactive-bg-hover-danger for a destructive action
   ([dangerButton]:hover), the neutral wash otherwise. */
.dsh-cs-danger { color: var(--dsw-alias-state-error-primary); }
.dsh-cs-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, var(--dsw-alias-interactive-bg-hover)); }
.dsh-cs-accent { color: var(--dsw-alias-state-business-primary); }
.dsh-cs-accent:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
/* [linkButton]: borderless, tertiary, hover wash. */
.dsh-cs-linkButton { box-sizing: border-box; display: inline-flex; align-items: center; height: 28px; padding: 0 10px; font: inherit; font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); border: none; border-radius: var(--dsw-radius-sm); background: 0 0; color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.dsh-cs-linkButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
/* [iconButton] / [iconButtonDanger]: 28px square, tertiary glyph. */
.dsh-cs-iconButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: var(--dsw-radius-sm); background: 0 0; color: var(--dsw-alias-label-tertiary); font: inherit; cursor: pointer; }
.dsh-cs-iconButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-cs-iconDanger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); color: var(--dsw-alias-state-error-primary); }
/* [primaryButton] / [secondaryButton]: the 36px editor-footer pair, and
   [editorActions] for the right-aligned row. */
.dsh-cs-primaryButton, .dsh-cs-secondaryButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; font: inherit; font-size: var(--dsh-cs-type-body-size); line-height: var(--dsh-cs-type-body-leading); border: none; border-radius: var(--dsw-radius-md); cursor: pointer; }
.dsh-cs-primaryButton { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.dsh-cs-primaryButton:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dsh-cs-secondaryButton { border: 0.5px solid var(--dsw-alias-border-l3); background: 0 0; color: var(--dsw-alias-label-primary); }
.dsh-cs-secondaryButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
.dsh-cs-smallButton:disabled, .dsh-cs-linkButton:disabled, .dsh-cs-iconButton:disabled, .dsh-cs-primaryButton:disabled, .dsh-cs-secondaryButton:disabled { opacity: 0.4; cursor: default; }
/* [editorActions]: right-aligned actions with no rule of their own; the panel gap
   and the catalog hairline above supply the separation. The status line is the
   plugin's own addition and sits left. */
.dsh-cs-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsh-cs-actions { display: flex; gap: 8px; margin-left: auto; }
/* Status line tones: [error], [savedNotice] and the section meta's tertiary. */
.dsh-cs-status { margin: 0; font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); color: var(--dsw-alias-label-tertiary); }
.dsh-cs-statusSuccess { color: var(--dsw-alias-state-success-primary); }
.dsh-cs-statusError { color: var(--dsw-alias-state-error-primary); }
/* The command card mirrors the vanilla changed-files card (deliverables'
   ChangedFiles): border/l2 shell, 40px icon tile, title + stat subtitle,
   hairline-divided rows. It does not copy the vanilla 60px tinted header, whose
   neutral-50 tint renders white in the composer's scope, so the header here is an
   untinted, auto-height div. Values come from the compiled vanilla stylesheet, and
   the 4px bars follow the context meter's recipe (vanilla's only 4px bar).
   Inset deviation: the changed-files card pads its header 8px 10px and its rows
   7px 18px 7px 14px, leaving the tile 4px left of the row text and only 7px under
   the last row. This card takes the usage panel's own inset instead
   (--dsh-cs-inset, the .dsh-cs-sPanel padding), so the tile, row labels and values
   share one edge and the last row keeps that inset beneath it. Half pads the list
   and half pads each row, which puts the first row one inset below the rule and
   the last one an inset above the border, while the header keeps a tighter 10px
   above and below its 40px tile. */
.dsh-cs-uroot { border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-1); min-width: 0; color: var(--dsw-alias-label-primary); flex-direction: column; margin-top: 4px; display: flex; overflow: hidden; }
.dsh-cs-uhead { box-sizing: border-box; width: 100%; min-width: 0; color: inherit; font: inherit; text-align: left; border: 0; align-items: center; gap: 10px; margin: 0; padding: 10px var(--dsh-cs-inset); display: flex; }
.dsh-cs-utile { box-sizing: border-box; border: 0.5px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-static-neutral-00) 50%, transparent); border-radius: 10px; flex: none; place-items: center; width: 40px; height: 40px; display: grid; color: var(--dsw-alias-label-primary); }
body[data-ds-dark-theme] .dsh-cs-utile { background: color-mix(in srgb, var(--dsw-static-neutral-00) 5%, transparent); }
.dsh-cs-utitles { flex-direction: column; flex: 1; min-width: 0; display: flex; }
.dsh-cs-utitle { text-overflow: ellipsis; white-space: nowrap; font-size: var(--dsh-cs-type-card-title-size); font-weight: var(--dsh-cs-type-card-title-weight); line-height: var(--dsh-cs-type-card-title-leading); overflow: hidden; }
/* The header's 10px subtitle (.dsh-cs-uplan): the usage card renders the plan
   label here, the account card renders the signed-in email, an unbroken user
   string, so the slot wraps instead of overflowing the title column. Short plan
   names are unaffected. */
.dsh-cs-uplan { color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-cs-type-sub-size); line-height: var(--dsh-cs-type-sub-leading); overflow-wrap: anywhere; }
.dsh-cs-ulist { border-top: 0.5px solid var(--dsw-alias-border-l2); margin: 0; padding: calc(var(--dsh-cs-inset) / 2) 0; }
.dsh-cs-uitem { padding: calc(var(--dsh-cs-inset) / 2) var(--dsh-cs-inset); display: flex; flex-direction: column; gap: 7px; }
.dsh-cs-urow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; min-width: 0; font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); }
.dsh-cs-ulabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-cs-upct { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex: none; }
/* The percent is the row's datum. Changed-files counts are tertiary beside a path;
   here the value IS the point, so it keeps label-secondary. */
/* The extra-usage value carries the host's full detail string (percent · status ·
   spent · cap), so it wraps instead of clipping. */
.dsh-cs-uextraVal { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; flex: 1 1 auto; min-width: 0; text-align: right; overflow-wrap: anywhere; }
/* Track/fill ride the vanilla context-meter bar's own tokens (interactive-bg-hover
   track), not the changed-files row's: this is a meter, not a file list. */
.dsh-cs-utrack { corner-shape: round; height: 4px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover); overflow: hidden; }
.dsh-cs-ufill { height: 100%; border-radius: 999px; background: var(--dsh-cs-brand-clay); }
/* Guidance closes the card on the same row metrics as the facts above, so its text
   lines up with their labels. The hairline starts the guidance rather than the
   header when there are rows to separate it from. */
.dsh-cs-ulist > .dsh-cs-unotes:not(:first-child) { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.dsh-cs-unote { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); overflow-wrap: anywhere; }
.dsh-cs-uerr { font-size: var(--dsh-cs-type-meta-size); color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-cs-upre { margin: 0; font-family: var(--ds-font-family-code, monospace); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
/* Drift: the host's row gaps are literals in its compiled stylesheet (InputBar
   css-module: 12px box gap between adjacent controls, dropping to 8px under the
   560px container query for the leading groups; the model seat's group stays 12),
   not custom properties, and the theme ships no spacing tokens. So the indicator
   compensates nothing: the host's own 12px entry gap is the only space before the
   model seat. The button is a real 30x28 control (the vanilla trigger shape, as in
   TurnUsagePanel) whose 8px horizontal padding is paid back by negative margins, so
   the layout footprint stays the 14px glyph while the button's box is the visible
   chrome the panel anchors to. Measured against dsh 0.2.1-rc.5. */
.dsh-cs-pie { position: relative; display: inline-flex; }
.dsh-cs-pieBtn { display: inline-flex; align-items: center; justify-content: center; padding: 7px 8px; margin: 0 -8px; border: none; background: none; cursor: pointer; border-radius: var(--dsw-radius-sm); color: inherit; }
.dsh-cs-pieBtn:hover { background: var(--dsw-alias-interactive-bg-hover); }
/* Focus paint comes from the host theme's global :focus-visible stylesheet
   (outline via --dsw-focus-ring-color/--dsw-focus-ring-width), measured against
   dsh 0.2.1-rc.5. The plugin ships no focus rule of its own. */
.dsh-cs-pie[data-stale] .dsh-cs-pieBtn { opacity: 0.45; }
/* The mark tooltip's two lines left-align inside the shared bubble. The bubble
   renders portaled outside this subtree, so a .dsh-cs-pie [role=tooltip]
   centering rule cannot reach it. See the indicator's triggerButton for why the
   bubble portals. */
/* The composer mark carries only geometry in the JSX: the depleted layer rides the
   host's caption ink, the clay layer the brand clay variable. The depleted layer is
   NOT border-l3, the vanilla context meter's track stroke: there it is a 2px ring
   line, here a *filled* 14px glyph, which against the composer card
   (--dsw-specific-input-major, #fff / #2c2c2e) measures 1.32:1 light and 1.68:1
   dark. At the limit the clay band has zero height, so the caption fill keeps the
   glyph visible. label-caption measures 2.13:1 / 3.76:1: legible as a glyph, but
   1.5x / 1.2x below the clay's 3.12:1 / 4.46:1, so the gauge dims the spent share
   instead of letting it carry the clay's weight. The no-reading and needs-sign-in
   marks keep that opaque fill: they have no clay band to contrast with, and the
   needs-sign-in mark dims through .dsh-cs-pie[data-stale]. Measured against dsh
   0.2.1-rc.5 (theme bundle tokens). */
.dsh-cs-spark { fill: var(--dsh-cs-brand-clay); }
.dsh-cs-pieDepleted { fill: var(--dsw-alias-label-caption); }
/* The gauge's spent share is dimmed on purpose: the clay band is the reading, the
   spent share only the track around it. At 0.5 the caption ink composites to
   1.43:1 light / 1.96:1 dark on the card (1.36:1 / 1.75:1 on the hover surface),
   about 2.2x below the clay in both modes, so 49% used reads as half a mark. */
.dsh-cs-pieTrack { fill-opacity: 0.5; }
/* The popover mirrors the vanilla stat dialog (DialogPill's panel): same tokens,
   padding, header row with a right value, hairline rule, and muted dt/dd grid, and
   with placement moved to the shared useAnchoredPosition primitive, the same seat:
   portaled, position: fixed, measured left/top inline, z-index 1100. Values come
   from the compiled vanilla stylesheet. The stroke-color override is required, not
   cosmetic: --dsw-elevation-prominent carries a 0.5px ring tinted by
   --dsw-elevation-stroke-color, which the theme defaults to border-l4 and the
   composer card re-tints to border-l2. Both stat panels pin border-l1, so the
   popover pins it too or its ring renders one level off. Without the shared
   primitive there is no measured placement, and the panel degrades to this
   absolute seat off the button's left chrome edge; with it, the fixed-seat class
   flips the position and the inline left/top take over. */
.dsh-cs-piePop { position: absolute; bottom: calc(100% + 8px); left: -8px; z-index: 1100; }
.dsh-cs-piePopFixed { position: fixed; bottom: auto; left: auto; }
.dsh-cs-sPanel { --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); box-sizing: border-box; border-radius: var(--dsw-radius-lg); background: var(--dsw-specific-menu); width: max-content; min-width: min(300px, 100vw - 24px); max-width: min(440px, 100vw - 24px); backdrop-filter: var(--dsw-menu-backdrop-filter); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-secondary); cursor: default; border: 0; padding: var(--dsh-cs-inset); font-size: var(--dsh-cs-type-meta-size); line-height: var(--dsh-cs-type-meta-leading); text-align: left; }
.dsh-cs-sTitle { color: var(--dsw-alias-label-primary); justify-content: space-between; gap: 16px; margin-bottom: 8px; font-weight: var(--dsh-cs-type-label-weight); display: flex; }
.dsh-cs-sTitleLabel { align-items: center; gap: 6px; min-width: 0; display: inline-flex; }
.dsh-cs-sTitleValue { font-variant-numeric: tabular-nums; }
.dsh-cs-sRule { border-top: 0.5px solid var(--dsw-alias-border-l2); margin-bottom: 10px; }
.dsh-cs-sDetails { color: var(--dsw-alias-label-tertiary); grid-template-columns: minmax(76px, auto) minmax(0, 1fr); gap: 6px 16px; margin: 0; display: grid; }
.dsh-cs-sDetails dt, .dsh-cs-sDetails dd { min-width: 0; margin: 0; }
.dsh-cs-sDetails dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; }
.dsh-cs-sWindow { display: contents; }
.dsh-cs-sBar { grid-column: 1 / -1; corner-shape: round; height: 4px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover); overflow: hidden; }
.dsh-cs-sFill { height: 100%; border-radius: 999px; background: var(--dsh-cs-brand-clay); }
`;

  /** Card copy. */
  const COPY = {
    title: "Claude subscription",
    models: "Models",
    stateAllAvailable: "All available models are in use.",
    stateNoCatalog: "No model catalog is available yet.",
    stateAllStaged: "The available models will be used when you save.",
    stateCustomNone: "Only the models you add are available.",
    stateCustomOne: "Only this model is available.",
    emptyList: "No models in the list. Add one below, or use all available models.",
    customize: "Customize models",
    customizeHint: "Copy every available model into an editable list.",
    restoreStashHint: "Bring back the list you had before.",
    useAll: "Use all available models",
    useAllHint: "Remove your custom list. Every available model becomes available again.",
    blankHint: "Blank fields use the catalog values.",
    addAccount: "Add account",
    addAccountHint:
      "Opens a new chat with /claude-login ready to send. The browser's claude.ai session decides which account is authorized: to add a different one, sign in to it there first, or open the URL in a private window.",
    loginHint: "Run /claude-login in any session to sign in.",
    signOutHint: "Opens a new chat with /claude-logout for this account ready to send.",
    signOut: "Sign out",
    signBackLabel: "Sign in again",
    signBackHint: "Opens a new chat with /claude-login for this account ready to send.",
    statusNeedsReauth: "Needs sign-in again",
    statusApiKey: "API key",
    noneSignedIn: "No account is signed in.",
    addModel: "Add",
    idLabel: "Model to add",
    selectPlaceholder: "Select a model…",
    allModelsAdded: "Every available model is already in the list.",
    noModelsAvailable: "No models are available to add.",
    catalogLoading: "Loading available models…",
    catalogFailed: "Available models could not be loaded.",
    catalogRefresh: "Refresh models",
    catalogRefreshHint: "Re-read every account's model catalog. Your saved lists are not changed.",
    catalogRefreshing: "Refreshing…",
    catalogUpdated: "Updated",
    catalogPublished: "Published catalog",
    retry: "Retry",
    namePlaceholder: "Custom display name",
    contextLabel: "Context window",
    maxTokensLabel: "Max output tokens",
    inheritPlaceholder: "Catalog",
    inputTypes: "Input types",
    modalityText: "Text",
    modalityImage: "Image",
    remove: "Remove",
    showDetails: "Show settings",
    hideDetails: "Hide settings",
    discard: "Discard",
    save: "Save",
    saving: "Saving…",
    unsaved: "Unsaved changes",
    loading: "Loading…",
    saved: "Saved.",
    conflict: "The settings document changed while editing — apply again.",
  };

  /** A row carrying an override the collapsed line does not show: capacity, or image input off. */
  function hasOverride(row) {
    return (
      row !== undefined &&
      (row.contextWindow !== undefined ||
        row.maxTokens !== undefined ||
        (row.input !== undefined && !row.input.includes("image")))
    );
  }

  /**
   * A shared-primitive icon at the host's size, or the text stand-in when the
   * primitive is absent (a host without the shared module must not take the card
   * down).
   */
  function icon(exportName, fallback, size) {
    const Icon = primitives?.[exportName];
    return Icon === undefined ? fallback : h(Icon, size === undefined ? {} : { size });
  }

  /** One input-type choice: the shared Checkbox, or a native one without it. */
  function choice({ label, checked, disabled, onChange }) {
    const Checkbox = primitives?.Checkbox;
    if (Checkbox !== undefined)
      return h(Checkbox, { key: label, label, checked, disabled, onChange });
    return h(
      "label",
      { key: label, className: "dsh-cs-choice" },
      h("input", {
        type: "checkbox",
        checked,
        disabled,
        onChange: (event) => onChange(event.target.checked),
      }),
      label,
    );
  }

  /**
   * A button wrapped in the host's shared Tooltip (the context meter's, 200ms
   * delay), or a bare button with a native `title` when the module is absent.
   * Never both, so a host with the primitive shows one tooltip.
   */
  function withTooltip(label, props, ...children) {
    if (Tooltip === undefined) return h("button", { ...props, title: label }, ...children);
    return h(
      Tooltip,
      { label, side: "top", delayMs: 200, portal: true },
      h("button", props, ...children),
    );
  }

  /**
   * The panel shell every account shares: the vanilla provider editor box
   * [editor] (grey bg-module-platform, radius-lg, 14px 16px, 14px gap) with the
   * editor header [editorHeader] (title + descriptor) and an optional
   * right-aligned action seat. The visible title truncates; its `title` attribute
   * carries the full value.
   * @param {{ key?: string, label: string, title: string, subtitle?: string, actions?: unknown[], children?: unknown[] }} parts
   */
  function panelShell({ key, label, title, subtitle, actions = [], children = [] }) {
    const items = actions.filter(Boolean);
    return h(
      "section",
      { key, className: "dsh-cs-panel", role: "group", "aria-label": label },
      h(
        "div",
        { className: "dsh-cs-sectionHead" },
        h(
          "div",
          { className: "dsh-cs-heading" },
          h("span", { className: "dsh-cs-panelTitle", title: label }, title),
          subtitle ? h("p", { className: "dsh-cs-meta" }, subtitle) : null,
        ),
        items.length > 0 ? h("div", { className: "dsh-cs-panelActions" }, items) : null,
      ),
      children,
    );
  }

  /**
   * The plan noun of a card descriptor ("Pro" → "Pro plan"). A non-string plan
   * (the untyped usage snapshot may carry one) is absent, never coerced. Not
   * `planLabel`, which string-matches the "unavailable (…)" degradation the
   * composer popover keeps verbatim.
   * @param {unknown} plan
   * @returns {string | undefined}
   */
  function planText(plan) {
    return typeof plan === "string" ? `${plan} plan` : undefined;
  }

  /**
   * The editor-descriptor line: organization, plan and an optional state,
   * joined by the middot the host's own list rows use.
   * @param {{ orgName?: string }} item
   * @param {unknown} plan
   * @param {string | undefined} [status]
   * @returns {string}
   */
  function descriptor(item, plan, status) {
    return [item.orgName, planText(plan), status].filter(Boolean).join(" · ");
  }

  /**
   * The per-account model editor card: a persistent sign-in button and one grey
   * panel per signed-in account (identity, its own model list, its own
   * Save/Discard). Every edit is staged, and staged edits survive reloads on
   * purpose: the host keeps writing this same settings document (account mirror,
   * usage snapshots) and none of those writes touch a user-owned model list.
   * @param {{ operations: object, startLogin?: (prompt: string) => void }} props
   */
  function ClaudeModelsCard({ operations, startLogin }) {
    const [state, setState] = React.useState({ phase: "loading" });
    /** Staged rows per route. A route with no entry shows the saved list. */
    const [staged, setStaged] = React.useState({});
    const [resetStaged, setResetStaged] = React.useState({});
    /** The rows a staged reset replaced, so "Customize models" restores them. */
    const [stash, setStash] = React.useState({});
    const [drafts, setDrafts] = React.useState({});
    const [busy, setBusy] = React.useState(null);
    const [notice, setNotice] = React.useState(null);
    const [openRows, setOpenRows] = React.useState({});
    /** Whether the card's one catalog refresh is in flight. */
    const [refreshing, setRefreshing] = React.useState(false);
    // The available catalog (the union across live accounts: an account's own
    // reading, else the published one, else nothing). Loaded once, best-effort;
    // the card never waits on it. `ids` is the add picker's whole option set, so
    // "not loaded" and "failed" are named states instead of an empty select.
    const [catalog, setCatalog] = React.useState({ status: "loading", ids: [] });

    const reload = React.useCallback(async () => {
      try {
        const view = await operations.describe();
        if (!view.ok) {
          setState({ phase: "error", message: view.error.message });
          return;
        }
        // describe() answers { writable, hasDocument, namespaces: [view] }.
        // readAccounts wants the per-namespace descriptor array. Only the baseline
        // moves: staged edits persist across reloads.
        const accounts = readAccounts(view.value?.namespaces);
        setState((current) => ({ ...current, phase: "ready", ...accounts }));
      } catch (error) {
        setState({ phase: "error", message: error?.message ?? String(error) });
      }
    }, [operations]);

    React.useEffect(() => {
      reload();
    }, [reload]);

    /**
     * Load the catalog and report the answer instead of only storing it:
     * "Customize" seeds from the same list, and the picker's retry needs the
     * failure message. Always resolves; a transport fault is the same failure
     * state as a refused discovery.
     * @returns {Promise<{ ok: true, ids: string[] } | { ok: false, message: string }>}
     */
    const loadCatalog = React.useCallback(async () => {
      // A retry leaves the failed state immediately, so the picker shows
      // "loading" (and its Retry button cannot be pressed twice).
      setCatalog((current) =>
        current.status === "ready" ? current : { status: "loading", ids: [] },
      );
      try {
        const answer = await operations.discoverModels?.();
        if (answer?.ok && Array.isArray(answer.value)) {
          const ids = answer.value
            .map((model) => model?.id)
            .filter((id) => typeof id === "string" && id.length > 0);
          setCatalog({ status: "ready", ids });
          return { ok: true, ids };
        }
        setCatalog({ status: "failed", ids: [] });
        return { ok: false, message: answer?.error?.message ?? COPY.catalogFailed };
      } catch (error) {
        setCatalog({ status: "failed", ids: [] });
        return { ok: false, message: error?.message ?? String(error) };
      }
    }, [operations]);

    React.useEffect(() => {
      loadCatalog();
    }, [loadCatalog]);

    // A catalog reading that landed while the card is open must reach the add
    // picker; the settings event only re-reads `state`, not this list. Keyed on
    // the readings' timestamps so an unrelated reload does not discard a shown
    // failure by starting another load.
    const catalogStamp = JSON.stringify([
      Object.entries(state.catalog?.accounts ?? {}).map(([route, snapshot]) => [
        route,
        snapshot.fetchedAt,
      ]),
      state.catalog?.published?.fetchedAt ?? null,
    ]);
    const seenCatalogStamp = React.useRef(catalogStamp);
    React.useEffect(() => {
      if (seenCatalogStamp.current === catalogStamp) return;
      seenCatalogStamp.current = catalogStamp;
      void loadCatalog();
    }, [catalogStamp, loadCatalog]);

    /**
     * Ask the host to re-read every signed-in account's catalog. Each reading is
     * fetched with that account's own credential, so this is one
     * `catalog:<route>#refresh` per live account; the host answers with each list
     * as it stands and fetches in the background, so the card re-reads once after
     * the first fetch window and never holds a click on N network calls. An
     * account with no live route is skipped, and a per-account failure leaves the
     * others alone.
     */
    const refreshCatalogs = React.useCallback(() => {
      if (refreshing) return;
      const routes = (state.mirror?.accounts ?? []).map((account) => account.route);
      if (routes.length === 0) return;
      setRefreshing(true);
      for (const route of routes) {
        Promise.resolve(
          operations.discoverModels?.(`${CATALOG_PREFIX}${route}#${CATALOG_REFRESH_SUFFIX}`),
        ).catch(() => {});
      }
      const reread = setTimeout(() => {
        void loadCatalog();
        setRefreshing(false);
      }, 2000);
      reread.unref?.();
    }, [operations, loadCatalog, refreshing, state.mirror]);

    /** "3 h ago"-style age of a catalog reading. */
    const catalogAge = (at) => {
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
      if (minutes < 1) return "just now";
      if (minutes < 60) return `${minutes} min ago`;
      const hours = Math.round(minutes / 60);
      return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
    };

    /**
     * When one route's catalog was read, and which source served it. The account's
     * own reading only states its age; the published catalog is the exception
     * worth naming, because that list is not plan-accurate and Refresh models can
     * replace it. Empty until a reading exists: a placeholder under every account
     * would name nothing the reader can act on.
     */
    const catalogSource = (route) => {
      const own = state.catalog?.accounts?.[route];
      if (Number.isFinite(own?.fetchedAt))
        return `${COPY.catalogUpdated} ${catalogAge(own.fetchedAt)}`;
      const published = state.catalog?.published;
      if (Number.isFinite(published?.fetchedAt))
        return `${COPY.catalogPublished} · ${catalogAge(published.fetchedAt)}`;
      return "";
    };

    React.useEffect(() => operations.onAdaptersUpdated(reload), [operations, reload]);
    React.useEffect(() => operations.onSettingsUpdated(reload), [operations, reload]);

    const ready = state.phase === "ready";
    const accounts = ready ? state.mirror.accounts : [];
    /** The catalog's ids once loaded, `null` while loading or after a failure. */
    const catalogIds = catalog.status === "ready" ? catalog.ids : null;

    /** The saved rows of one route: `null` when the available catalog serves. */
    const savedRows = (route) => state.models?.[route] ?? null;
    /** The displayed list of one route: staged reset → all available, staged edit → rows, else saved. */
    const rows = (route) => (resetStaged[route] ? null : (staged[route] ?? savedRows(route)));
    const listDirty = (route) =>
      resetStaged[route]
        ? savedRows(route) !== null
        : staged[route] !== undefined && rowsDiffer(savedRows(route) ?? [], staged[route]);

    const clearStaged = (route) => {
      setStaged((current) => {
        if (current[route] === undefined) return current;
        const next = { ...current };
        delete next[route];
        return next;
      });
      setResetStaged((current) => {
        if (!current[route]) return current;
        const next = { ...current };
        delete next[route];
        return next;
      });
      setStash((current) => {
        if (current[route] === undefined) return current;
        const next = { ...current };
        delete next[route];
        return next;
      });
      setDrafts((current) => {
        if (current[route] === undefined) return current;
        const next = { ...current };
        delete next[route];
        return next;
      });
    };

    const stage = (route, next) => {
      setStaged((current) => ({ ...current, [route]: next }));
      setResetStaged((current) => ({ ...current, [route]: false }));
      setStash((current) => ({ ...current, [route]: undefined }));
      setNotice(null);
    };

    const toNotice = (route, tone, text) => ({ route, tone, text });

    const applySaved = (accounts) =>
      setState((current) => ({
        ...current,
        phase: "ready",
        revision: accounts.revision,
        models: accounts.models,
        mirror: accounts.mirror,
      }));

    /**
     * Write one section's operations against the loaded revision. A
     * settings/conflict means the document moved while editing. With the host's
     * own mirror and usage writes landing constantly, the retry is the common case,
     * not the error: refresh the revision and retry once when this route's saved
     * rows did not move under us. Only a real concurrent edit asks the user to
     * re-apply.
     */
    const commit = async (route, ops, retried = false, expectedRevision = state.revision) => {
      setBusy(route);
      setNotice(null);
      try {
        const written = await operations.writeModels(ops, expectedRevision);
        if (!written.ok) {
          if (written.error?.code === "settings/conflict" && !retried) {
            const view = await operations.describe();
            if (view.ok) {
              const fresh = readAccounts(view.value?.namespaces);
              const base = fresh.models?.[route] ?? null;
              const moved = rowsDiffer(savedRows(route) ?? [], base ?? []);
              applySaved(fresh);
              // The retry must carry the revision the document moved to. `state`
              // in this closure is still the pre-conflict render, so passing it
              // again would conflict forever.
              if (!moved) {
                // Await the retry so the outer finally does not clear `busy`
                // while the retried write is still running.
                await commit(route, ops, true, fresh.revision);
                return;
              }
            }
          }
          setNotice(
            toNotice(
              route,
              "error",
              written.error?.code === "settings/conflict"
                ? COPY.conflict
                : (written.error?.message ?? COPY.conflict),
            ),
          );
          return;
        }
        applySaved(readAccounts([written.value]));
        clearStaged(route);
        setNotice(toNotice(route, "success", COPY.saved));
      } catch (error) {
        // A rejected remote call is a local fault (no connection, marshalling);
        // ordinary transport failures already resolve as { ok: false }.
        setNotice(toNotice(route, "error", error?.message ?? String(error)));
      } finally {
        setBusy(null);
      }
    };

    const save = (route) => {
      // Only a changed list writes the models section. A staged reset
      // removes the saved list.
      if (!listDirty(route)) return;
      const ops = [
        resetStaged[route] ? unsetModelsOp(route) : setModelsOp(rows(route) ?? [], route),
      ];
      commit(route, ops);
    };

    const discard = (route) => {
      clearStaged(route);
      setNotice(null);
    };

    if (state.phase === "loading") {
      return h(
        "section",
        { className: "dsh-cs-card", "aria-label": COPY.title },
        h("p", { className: "dsh-cs-status" }, COPY.loading),
      );
    }
    if (state.phase === "error") {
      return h(
        "section",
        { className: "dsh-cs-card", "aria-label": COPY.title },
        h("p", { className: "dsh-cs-status dsh-cs-statusError" }, state.message),
      );
    }

    const isOpen = (route, row) =>
      openRows[`${route}/${row.id}`] ??
      hasOverride((savedRows(route) ?? []).find((saved) => saved.id === row.id));
    const capacityField = (route, row, index, key, label, ariaLabel) =>
      h(
        "label",
        { key, className: "dsh-cs-field" },
        h("span", { className: "dsh-cs-fieldLabel" }, label),
        h("input", {
          className: "dsh-cs-input",
          value: row[key] ?? "",
          placeholder: COPY.inheritPlaceholder,
          inputMode: "numeric",
          "aria-label": `${row.id} ${ariaLabel}`,
          onChange: (event) =>
            stage(
              route,
              rows(route).map((candidate, at) =>
                at === index
                  ? {
                      ...candidate,
                      ...{
                        [key]: event.target.value === "" ? undefined : Number(event.target.value),
                      },
                    }
                  : candidate,
              ),
            ),
        }),
      );

    const entry = (route, row, index) => {
      const open = isOpen(route, row);
      const image = (row.input ?? ["text", "image"]).includes("image");
      return h(
        "div",
        { key: row.id ?? String(index), className: "dsh-cs-entry" },
        h(
          "div",
          { className: "dsh-cs-entryRow" },
          h("span", { className: "dsh-cs-id", title: row.id }, row.id),
          h("input", {
            className: "dsh-cs-input",
            value: row.name ?? "",
            placeholder: COPY.namePlaceholder,
            "aria-label": `${row.id} display name`,
            onChange: (event) =>
              stage(
                route,
                rows(route).map((candidate, at) =>
                  at === index ? { ...candidate, name: event.target.value } : candidate,
                ),
              ),
          }),
          h(
            "button",
            {
              type: "button",
              className: "dsh-cs-iconButton",
              "aria-label": `${open ? COPY.hideDetails : COPY.showDetails}: ${row.id}`,
              "aria-expanded": open,
              title: open ? COPY.hideDetails : COPY.showDetails,
              onClick: () =>
                setOpenRows((current) => ({ ...current, [`${route}/${row.id}`]: !open })),
            },
            open
              ? icon("IconChevronDownOutlineRegular", "▾")
              : icon("IconChevronRightOutlineRegular", "▸"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-cs-iconButton dsh-cs-iconDanger",
              disabled: busy !== null,
              "aria-label": `${COPY.remove} ${row.id}`,
              title: COPY.remove,
              onClick: () =>
                stage(
                  route,
                  rows(route).filter((_, at) => at !== index),
                ),
            },
            icon("IconTrashOutlineRegular", "×", 14),
          ),
        ),
        open
          ? h(
              "div",
              { className: "dsh-cs-advanced" },
              h("p", { className: "dsh-cs-meta dsh-cs-advancedHint" }, COPY.blankHint),
              capacityField(
                route,
                row,
                index,
                "contextWindow",
                COPY.contextLabel,
                "context window",
              ),
              capacityField(route, row, index, "maxTokens", COPY.maxTokensLabel, "max output"),
              h(
                "fieldset",
                { className: "dsh-cs-inputTypes" },
                h("legend", { className: "dsh-cs-fieldLabel" }, COPY.inputTypes),
                h(
                  "div",
                  { className: "dsh-cs-choices" },
                  choice({
                    label: COPY.modalityText,
                    checked: true,
                    disabled: true,
                    onChange: () => {},
                  }),
                  choice({
                    label: COPY.modalityImage,
                    checked: image,
                    disabled: busy !== null,
                    onChange: (checked) =>
                      stage(
                        route,
                        rows(route).map((candidate, at) =>
                          at === index
                            ? { ...candidate, input: checked ? ["text", "image"] : ["text"] }
                            : candidate,
                        ),
                      ),
                  }),
                ),
              ),
            )
          : null,
      );
    };

    const customize = async (route) => {
      const restored = stash[route];
      if (restored !== undefined) {
        stage(route, restored);
        return;
      }
      setBusy(route);
      setNotice(null);
      try {
        // A failed mount-time load is retried here, and its failure
        // surfaces where the user asked for the list.
        let ids = catalogIds;
        if (ids === null) {
          const answer = await loadCatalog();
          if (!answer.ok) {
            setNotice(toNotice(route, "error", answer.message));
            return;
          }
          ids = answer.ids;
        }
        stage(
          route,
          ids.map((id) => normalizeRow({ id }) ?? { id }),
        );
      } catch (error) {
        setNotice(toNotice(route, "error", error?.message ?? String(error)));
      } finally {
        setBusy(null);
      }
    };

    const addRow = (route) => {
      const current = rows(route) ?? [];
      const normalized = normalizeRow({ id: drafts[route] ?? "" });
      if (normalized === undefined || current.some((row) => row.id === normalized.id)) return;
      stage(route, [...current, normalized]);
      setDrafts((currentDrafts) => ({ ...currentDrafts, [route]: "" }));
    };

    const selectAll = (route) => {
      setStash((current) => ({ ...current, [route]: rows(route) }));
      setStaged((current) => ({ ...current, [route]: undefined }));
      setResetStaged((current) => ({ ...current, [route]: true }));
      setNotice(null);
    };

    /**
     * One account's model-list editor: the state sentence, the toggle, and
     * the list.
     */
    const modelsBody = (route, stateId) => {
      const current = rows(route);
      const customized = current !== null;
      // The default (no saved list) mode renders no list of its own: the state
      // sentence above says every available model is in use, and the ids are only
      // worth fetching when the user asks to customize.
      const listBody = !customized
        ? null
        : current.length === 0
          ? h("p", { className: "dsh-cs-empty dsh-cs-emptyError" }, COPY.emptyList)
          : h(
              "div",
              { className: "dsh-cs-list" },
              current.map((row, index) => entry(route, row, index)),
            );
      const stateText = !customized
        ? resetStaged[route]
          ? COPY.stateAllStaged
          : catalogIds === null
            ? COPY.stateAllAvailable
            : catalogIds.length === 0
              ? COPY.stateNoCatalog
              : `All ${String(catalogIds.length)} available models are in use.`
        : current.length === 0
          ? COPY.stateCustomNone
          : current.length === 1
            ? COPY.stateCustomOne
            : `${String(current.length)} models are selected.`;
      const toggleLabel = customized ? COPY.useAll : COPY.customize;
      const toggleHint = customized
        ? COPY.useAllHint
        : stash[route] !== undefined
          ? COPY.restoreStashHint
          : COPY.customizeHint;
      const sourceText = catalogSource(route);
      return h(
        "section",
        { className: "dsh-cs-section", "aria-label": COPY.models },
        h(
          "div",
          { className: "dsh-cs-sectionHead" },
          h(
            "div",
            { className: "dsh-cs-heading" },
            h("span", { className: "dsh-cs-headingTitle" }, COPY.models),
            h(
              "p",
              { className: "dsh-cs-meta", id: stateId, role: "status", "aria-live": "polite" },
              stateText,
            ),
            sourceText === "" ? null : h("p", { className: "dsh-cs-meta" }, sourceText),
          ),
          h(
            "div",
            { className: "dsh-cs-headActions" },
            // Same slot and element in both modes (only label and handler change),
            // so keyboard focus survives the flip.
            withTooltip(
              toggleHint,
              {
                key: "mode-toggle",
                type: "button",
                className: "dsh-cs-smallButton",
                disabled: busy !== null,
                "aria-describedby": stateId,
                onClick: () => (customized ? selectAll(route) : customize(route)),
              },
              toggleLabel,
            ),
          ),
        ),
        listBody,
        customized ? addPicker(route, current) : null,
      );
    };

    /**
     * The add picker: a select of the catalog entries the list does not carry, plus
     * Add. The plugin serves only its own catalog (lib/catalog.js), so an arbitrary
     * typed id names a model this route cannot serve, and one already listed is not
     * offered either. The native select keeps the platform's listbox keyboard and
     * screen-reader behaviour; the card only draws its chrome. Every unavailable
     * state says so instead of leaving an empty picker: loading, failed (with
     * Retry), or every catalog model already listed.
     */
    const addPicker = (route, current) => {
      const available = availableModelIds(catalogIds, current);
      const picked = drafts[route] ?? "";
      if (catalog.status === "loading")
        return h("p", { className: "dsh-cs-addNote dsh-cs-meta" }, COPY.catalogLoading);
      if (catalog.status === "failed") {
        return h(
          "div",
          { className: "dsh-cs-addRow" },
          h("p", { className: "dsh-cs-addNote dsh-cs-meta" }, COPY.catalogFailed),
          h(
            "button",
            {
              type: "button",
              className: "dsh-cs-linkButton",
              disabled: busy !== null,
              onClick: () => void loadCatalog(),
            },
            COPY.retry,
          ),
        );
      }
      if (available.length === 0) {
        return h(
          "p",
          { className: "dsh-cs-addNote dsh-cs-meta" },
          catalog.ids.length === 0 ? COPY.noModelsAvailable : COPY.allModelsAdded,
        );
      }
      return h(
        "div",
        { className: "dsh-cs-addRow" },
        h(
          "span",
          { className: "dsh-cs-selectWrap" },
          h(
            "select",
            {
              className: "dsh-cs-input dsh-cs-select",
              value: picked,
              "aria-label": COPY.idLabel,
              disabled: busy !== null,
              onChange: (event) =>
                setDrafts((currentDrafts) => ({ ...currentDrafts, [route]: event.target.value })),
            },
            h("option", { value: "" }, COPY.selectPlaceholder),
            available.map((id) => h("option", { key: id, value: id }, id)),
          ),
          h(
            "span",
            { className: "dsh-cs-selectChevron", "aria-hidden": true },
            icon("IconChevronDownOutlineRegular", "▾", 14),
          ),
        ),
        h(
          "button",
          {
            type: "button",
            className: "dsh-cs-smallButton",
            disabled: busy !== null || !available.includes(picked),
            onClick: () => addRow(route),
          },
          icon("IconPlusOutlineRegular", null, 14),
          COPY.addModel,
        ),
      );
    };

    const footer = (route) => {
      const emptyBlocked = rows(route) !== null && rows(route).length === 0;
      const dirty = listDirty(route);
      const statusFor = notice?.route === route ? notice : undefined;
      const statusText = statusFor !== undefined ? statusFor.text : dirty ? COPY.unsaved : null;
      const statusTone =
        statusFor !== undefined
          ? statusFor.tone === "success"
            ? " dsh-cs-statusSuccess"
            : statusFor.tone === "error"
              ? " dsh-cs-statusError"
              : ""
          : "";
      const onSave = () => save(route);
      return h(
        "div",
        { className: "dsh-cs-footer" },
        statusText === null
          ? h("span", null)
          : h("p", { className: "dsh-cs-status" + statusTone, role: "status" }, statusText),
        h(
          "div",
          { className: "dsh-cs-actions" },
          h(
            "button",
            {
              type: "button",
              className: "dsh-cs-secondaryButton",
              disabled: busy !== null || !dirty,
              onClick: () => discard(route),
            },
            COPY.discard,
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-cs-primaryButton",
              disabled: busy !== null || !dirty || emptyBlocked,
              onClick: onSave,
            },
            busy === route ? COPY.saving : COPY.save,
          ),
        ),
      );
    };

    /** One signed-in account: identity, status, its model list, its own footer. */
    const accountSection = (item) => {
      const route = item.route;
      const email = item.email ?? `account …${route.slice(-6)}`;
      // Signing in again may state the expected account by email (a
      // human-readable hint the login command only compares against). Sign out
      // must name the unique route: a personal plan and a Team seat share an
      // email, and /claude-logout refuses an ambiguous one.
      const loginTarget = item.email ?? route;
      const plan = item.plan ?? state.snapshots?.[route]?.plan;
      const subtitle = descriptor(
        item,
        plan,
        item.status === "needsReauth"
          ? COPY.statusNeedsReauth
          : item.status === "apiKey"
            ? COPY.statusApiKey
            : undefined,
      );
      const actions = [
        item.status === "needsReauth" && startLogin !== undefined
          ? withTooltip(
              COPY.signBackHint,
              {
                type: "button",
                className: "dsh-cs-smallButton dsh-cs-accent",
                "aria-label": `${COPY.signBackLabel}: ${email}`,
                onClick: () => startLogin(`/claude-login ${loginTarget}`),
              },
              COPY.signBackLabel,
            )
          : null,
        startLogin !== undefined
          ? withTooltip(
              COPY.signOutHint,
              {
                type: "button",
                className: "dsh-cs-smallButton dsh-cs-danger",
                "aria-label": `${COPY.signOut}: ${email}`,
                onClick: () => startLogin(`/claude-logout ${route}`),
              },
              COPY.signOut,
            )
          : null,
      ];
      return panelShell({
        key: route,
        label: email,
        title: email,
        subtitle: subtitle.length > 0 ? subtitle : undefined,
        actions,
        children: [modelsBody(route, `${STATE_ID}-${route}`), footer(route)],
      });
    };

    return h(
      "section",
      { className: "dsh-cs-card", "aria-label": COPY.title },
      h(
        "div",
        { className: "dsh-cs-header" },
        h("h6", { className: "dsh-cs-title" }, COPY.title),
        // One refresh for every account's reading. Each reading is its own fetch
        // with its own credential, but the card's list is the union across
        // accounts, so a per-panel button would refresh one reading while
        // changing every panel's options. The header sweep matches what the card
        // actually shows.
        h(
          "div",
          { className: "dsh-cs-headerActions" },
          withTooltip(
            COPY.catalogRefreshHint,
            {
              type: "button",
              className: "dsh-cs-linkButton",
              "aria-label": COPY.catalogRefresh,
              disabled: busy !== null || refreshing || accounts.length === 0,
              onClick: refreshCatalogs,
            },
            refreshing ? COPY.catalogRefreshing : COPY.catalogRefresh,
          ),
          // The persistent sign-in button: adding an account never signs another
          // one out.
          startLogin === undefined
            ? null
            : withTooltip(
                COPY.addAccountHint,
                {
                  type: "button",
                  className: "dsh-cs-smallButton dsh-cs-accent",
                  "aria-label": COPY.addAccount,
                  onClick: () => startLogin(LOGIN_COMMAND),
                },
                COPY.addAccount,
              ),
        ),
      ),
      // Without a session-opening service the command is named in text instead of
      // vanishing.
      startLogin === undefined ? h("p", { className: "dsh-cs-account" }, COPY.loginHint) : null,
      accounts.length === 0 ? h("p", { className: "dsh-cs-account" }, COPY.noneSignedIn) : null,
      accounts.map(accountSection),
    );
  }

  /**
   * The header's plan reading: the bare plan name gains the "plan" noun
   * ("Pro" → "Pro plan"). An "unavailable (…)" degradation stays verbatim.
   */
  function planLabel(plan) {
    return plan === undefined || plan.startsWith("unavailable") ? plan : `${plan} plan`;
  }
  /**
   * The header subtitle both command cards share: the signed-in identity and the
   * plan, joined by the middot the host's list rows use ("email · Pro plan").
   * Either fact alone stands in. With neither known the subtitle is undefined and
   * the caller applies its fallback (the usage card shows no subtitle, the account
   * card its `Auth:` label).
   * @param {string | undefined} account - the parsed `Account:` line.
   * @param {string | undefined} plan - the parsed `Plan:` line.
   */
  function identitySubtitle(account, plan) {
    const label = plan === undefined ? undefined : planLabel(plan);
    if (account === undefined) return label;
    return label === undefined ? account : `${account} · ${label}`;
  }

  /**
   * The card shell both command cards share, mirroring the vanilla
   * changed-files card (deliverables' ChangedFiles): icon-tile header with a
   * title + stat subtitle, hairline rule, then the caller's rows. The
   * changed-files header tint renders white in the composer's scope, so here the
   * header is untinted and auto-height.
   * @param {{ title: string, subtitle?: string, children: unknown[] }} parts
   */
  function commandPanelShell({ title, subtitle, children }) {
    // A panel with no rows (an account whose organization and expiry are both
    // unknown) renders its header alone: the list carries the hairline and the
    // inset, so painting it empty would leave a bare strip under the header.
    const rows = children.flat().filter((child) => child !== null && child !== undefined);
    return h(
      "div",
      { className: "dsh-cs-uroot" },
      h(
        "div",
        { className: "dsh-cs-uhead" },
        h("span", { className: "dsh-cs-utile" }, h(ClaudeSpark, { size: 20 })),
        h(
          "span",
          { className: "dsh-cs-utitles" },
          h("span", { className: "dsh-cs-utitle" }, title),
          subtitle === undefined ? null : h("span", { className: "dsh-cs-uplan" }, subtitle),
        ),
      ),
      rows.length === 0 ? null : h("div", { className: "dsh-cs-ulist" }, rows),
    );
  }

  /**
   * The guidance footer: a list row on the same inset as the fact rows, so its
   * text aligns with their labels. The stylesheet draws the hairline above it.
   */
  function noteFooter(note) {
    return h(
      "div",
      { className: "dsh-cs-uitem dsh-cs-unotes" },
      h("div", { className: "dsh-cs-unote" }, note),
    );
  }

  /**
   * The full plan-usage panel for the /claude-usage command card: the shared
   * shell, then label/value rows with a full-width bar per window. The bars follow
   * the context meter's 4px recipe (ChangedFiles has none). The header subtitle
   * pairs the identity with the plan exactly as the account card's does. The
   * fills and the composer mark's clay band take the brand clay from the
   * stylesheet's one --dsh-cs-brand-clay definition (no host token exists for it),
   * so the spark, the band, and the bars all read the same variable.
   */
  function usagePanel(parsed) {
    return commandPanelShell({
      title: "Usage quota",
      subtitle: identitySubtitle(parsed.account, parsed.plan),
      children: [
        parsed.windows.map((window) => {
          const relative = withoutClock(window.reset);
          return h(
            "div",
            { key: window.label, className: "dsh-cs-uitem" },
            h(
              "div",
              { className: "dsh-cs-urow" },
              h(
                "span",
                { className: "dsh-cs-ulabel" },
                window.label,
                relative === "" ? null : ` · ${relative}`,
              ),
              h("span", { className: "dsh-cs-upct" }, `${window.percent}%`),
            ),
            h(
              "div",
              { className: "dsh-cs-utrack" },
              h("div", {
                className: "dsh-cs-ufill",
                style: { width: `${Math.max(0, Math.min(100, window.percent))}%` },
              }),
            ),
          );
        }),
        parsed.extra === undefined
          ? null
          : h(
              "div",
              { key: "extra", className: "dsh-cs-uitem" },
              h(
                "div",
                { className: "dsh-cs-urow" },
                h("span", { className: "dsh-cs-ulabel" }, EXTRA_LABEL),
                h("span", { className: "dsh-cs-upct dsh-cs-uextraVal" }, parsed.extra),
              ),
            ),
        parsed.note === undefined ? null : noteFooter(parsed.note),
      ],
    });
  }

  /** One label/value fact row of the account panel. The value rides the wrapping-value pair (the Extra-usage row's), so a long expiry string wraps instead of clipping. */
  function accountRow(label, value) {
    return h(
      "div",
      { key: label, className: "dsh-cs-uitem" },
      h(
        "div",
        { className: "dsh-cs-urow" },
        h("span", { className: "dsh-cs-ulabel" }, label),
        h("span", { className: "dsh-cs-upct dsh-cs-uextraVal" }, value),
      ),
    );
  }

  /**
   * The /claude-account panel: the usage panel's shell with the credential facts
   * as rows. The header subtitle is the same identity · plan pairing the usage
   * card renders. When neither fact is known (no email captured, plan fetch
   * degraded) it falls back to the `Auth:` label verbatim ("Subscription (OAuth)",
   * "API key", "Not signed in"). Guidance (API-key route, sign-out) renders as
   * the panel's note, like the usage card's.
   */
  function accountPanel(parsed) {
    return commandPanelShell({
      // The card's title is the command text's tag line (the shared
      // ACCOUNT_TAG): the header names the command it renders.
      title: ACCOUNT_TAG,
      subtitle: identitySubtitle(parsed.account, parsed.plan) ?? parsed.auth,
      children: [
        parsed.organization === undefined ? null : accountRow("Organization", parsed.organization),
        parsed.tokenExpires === undefined ? null : accountRow("OAuth token", parsed.tokenExpires),
        parsed.note === undefined ? null : noteFooter(parsed.note),
      ],
    });
  }

  /**
   * The outcome ladder both command cards share: nothing while the command runs,
   * the host's error text, the parsed panel, or, for a success this plugin cannot
   * parse, the raw text block. A plain function (no hooks), so each card keeps its
   * own hook order. The caller passes its parsed value and panel.
   * @param {{ outcome?: { kind: string, text?: string } | null, parsed?: object, panel: (parsed: object) => unknown, errorText: string }} parts
   */
  function commandOutcomeBody({ outcome, parsed, panel, errorText }) {
    if (outcome === undefined || outcome === null) {
      // Nothing until the result lands. The host keeps the command node open
      // while its handler runs, and a placeholder would put a box where the card
      // is about to appear, usually one request away.
      return null;
    }
    if (outcome.kind === "error") {
      return h(
        "div",
        { className: "dsh-cs-uroot" },
        h("span", { className: "dsh-cs-uerr" }, outcome.text ?? errorText),
      );
    }
    if (parsed === undefined) {
      // Not this plugin's parse (e.g. a cancelled run): the raw text is the
      // honest presentation.
      return h("pre", { className: "dsh-cs-upre" }, outcome.text ?? "");
    }
    return panel(parsed);
  }

  /**
   * The /claude-usage result card, rendered in place of the generic command card
   * through the keyed commandview slot (entry key = the command name). The node
   * carries only the outcome text this plugin's host half emitted, so the card
   * parses its own stable format. Guidance outcomes (no credential, API-key
   * route) arrive as parseable Note lines. A successful parse also feeds the
   * composer's 5-hour indicator (see UsagePie), stamped with the run's Observed
   * time so a historical card can never re-stamp the cache. Anything unexpected
   * falls back to the raw text block.
   * @param {{ node?: { name?: string, outcome?: { kind: string, text?: string } | null } }} props
   */
  function ClaudeUsageCard({ node }) {
    const outcome = node?.outcome;
    const parsed = outcome?.kind === "success" ? parseUsageText(outcome.text ?? "") : undefined;
    // Cache the parsed panel for the composer indicator (mark, tooltip, popover).
    // Declared before any conditional return so the hook order never changes.
    React.useEffect(() => {
      if (parsed === undefined) return;
      // The cache is per account, keyed by the result's Route row. Order runs by
      // observation, not by write: a card from earlier in the conversation must
      // not re-stamp the indicator with a fresh clock, and an older run must not
      // overwrite a newer one. Only a run's own Observed stamp dates its data; an
      // unstamped guidance outcome ("no credential", "API key") is a fresh
      // statement about this account, and clearing the cache is its point. An
      // unstamped result carrying windows has no observation time, so it must not
      // be presented as current.
      const stamp = Date.parse(parsed.observed ?? "");
      if (!Number.isFinite(stamp) && parsed.windows.length > 0) return;
      const observedAt = Number.isFinite(stamp) ? stamp : Date.now();
      // Every account route is a hash now, so there is no default to fall back
      // on: a result with no Route row cannot name the account whose mark it
      // should feed, and caching it under a guess would paint another account's
      // quota.
      const route =
        typeof parsed.route === "string" && parsed.route.length > 0 ? parsed.route : undefined;
      if (route === undefined) return;
      try {
        const previous = readUsageCache(route);
        if (
          previous !== undefined &&
          Number.isFinite(previous.observedAt) &&
          previous.observedAt > observedAt
        )
          return;
        writeUsageCache(route, {
          plan: parsed.plan ?? null,
          windows: parsed.windows,
          extra: parsed.extra ?? null,
          observedAt,
        });
      } catch {
        // Storage unavailable (private mode, hardened browser): the indicator
        // just stays empty.
      }
    }, [node]);

    return commandOutcomeBody({
      outcome,
      parsed,
      panel: usagePanel,
      errorText: "The usage request failed.",
    });
  }

  /**
   * The /claude-account result card: the usage card's mechanism, the keyed
   * commandview slot (entry key = the command name), parse contract over the
   * host's own text format (lib/client-models.js `parseAccountText`), with the
   * shared shell and outcome ladder. Account state has nothing to feed forward
   * (no composer cache), so this card is a pure function of its props, with no
   * effects.
   * @param {{ node?: { name?: string, outcome?: { kind: string, text?: string } | null } }} props
   */
  function ClaudeAccountCard({ node }) {
    const outcome = node?.outcome;
    const parsed = outcome?.kind === "success" ? parseAccountText(outcome.text ?? "") : undefined;
    return commandOutcomeBody({
      outcome,
      parsed,
      panel: accountPanel,
      errorText: "The account request failed.",
    });
  }

  /** Distance between the trigger's top edge and the panel's bottom (the vanilla stat dialog's PANEL_GAP). */
  const PANEL_GAP = 8;
  /** Viewport margin the placement clamp keeps (the vanilla stat dialog's PANEL_MARGIN). */
  const PANEL_MARGIN = 12;
  /**
   * Unplaced portal panel: hidden but laid out so the clamp measures real
   * dimensions (the shared placement primitive's measure pass).
   */
  const MEASURE_STYLE = { visibility: "hidden", left: 0, top: 0 };
  /**
   * The stand-in when the shared placement primitive is absent: no measured
   * position, and the panel falls back to the stylesheet's absolute seat. A
   * stable module-level function keeps the hook call order unconditional.
   */
  function noPlacement() {
    return null;
  }

  /**
   * The primary-quota usage indicator beside the model selector: the Claude mark,
   * depleted by the window's utilization (full clay at 0% used, fully neutral at
   * the limit). The primary window is the 5-hour family when the plan has one,
   * otherwise the weekly window. A weekly window at 100% overrides both the mark
   * and the tooltip, because a spent weekly gate blocks sending no matter what
   * the 5-hour window has left. It reports the account of the *selected model*,
   * read from the session's model directory, and renders only while that model
   * belongs to a signed-in Claude account. Every trigger pings the host with
   * `ping:<route>` so exactly that account is fetched; an idle account generates
   * no traffic. Hover shows the shared Tooltip (200ms delay, like the context
   * meter) with the quota reading and the countdown. Click opens the full plan
   * panel as a portaled, trigger-anchored dialog on the shared placement
   * primitive. An account whose token refresh was refused renders a dimmed
   * "needs sign-in again" mark.
   */
  function UsagePie({ operations, sessionId, directory: injected, resolveDirectory } = {}) {
    // The slot's inject result is cached per session binding, so a failed
    // lookup would stay failed. Re-resolve lazily until the directory answers.
    const [lateDirectory, setLateDirectory] = React.useState(undefined);
    const directory = injected ?? lateDirectory;
    React.useEffect(() => {
      if (injected !== undefined && injected !== null) return;
      if (typeof resolveDirectory !== "function") return;
      let attempts = 0;
      let timer;
      const attempt = () => {
        let found;
        try {
          found = resolveDirectory();
        } catch {}
        if (found !== undefined && found !== null) {
          setLateDirectory(found);
          return;
        }
        attempts += 1;
        if (attempts < 30) timer = setTimeout(attempt, 1000);
      };
      attempt();
      return () => clearTimeout(timer);
    }, [injected, resolveDirectory, sessionId]);
    const snapshot = useStoreSnapshot(directory);
    // The selected model's provider route decides both visibility and whose
    // quota is reported: the account is the model's, never a setting.
    const route =
      typeof snapshot?.current?.provider === "string" ? snapshot.current.provider : undefined;
    const [cached, setCached] = React.useState(undefined);
    const [open, setOpen] = React.useState(false);
    // Which side of the button the panel opens on, as the placement primitive's
    // align: "end" hangs it off the button's right edge (leftward), "start" off
    // its left edge (rightward). Measured once the panel is in the DOM (the
    // align effect below). This default only covers the hidden measure pass;
    // left has priority (see popoverAlign).
    const [align, setAlign] = React.useState("end");
    const [, tick] = React.useState(0);
    // The selected account's mirror row and the signed-in account count: the row
    // gates visibility, the count decides whether the open panel names the account.
    const [mirror, setMirror] = React.useState(undefined);
    // Only the selected route's row counts: after a switch the previous
    // account's row must not name (or gate) the new account's indicator.
    const mirrorLoaded = route !== undefined && mirror?.route === route;
    const mirrorRow = mirrorLoaded ? mirror.row : undefined;
    const [accountCount, setAccountCount] = React.useState(0);
    const btnRef = React.useRef(null);
    const popRef = React.useRef(null);
    // Stable, so an open panel keeps one dismissal subscription (the shared
    // hook re-subscribes when its callback identity changes).
    const close = React.useCallback(() => setOpen(false), []);
    // The refresh ping: a fire-and-forget discovery call naming this indicator's
    // account, whose host-side callback schedules the engine's fetch
    // (lib/index.js). Ordinary remote failures resolve { ok: false }, but a broken
    // transport can reject, and neither an async rejection nor a local assembly
    // fault may take the indicator down.
    const ping = React.useCallback(
      (select) => {
        if (route === undefined || !isAccountRoute(route)) return;
        try {
          Promise.resolve(
            operations?.discoverModels?.(
              `ping:${route}${select === SELECT_PING ? SELECT_SUFFIX : ""}`,
            ),
          ).catch(() => {});
        } catch {}
      },
      [operations, route],
    );
    // A model of another account was just selected (or the composer just mounted
    // on one): refresh that account's quota now, past the engine's cooldown. The
    // effect is keyed on the route, so switching between models of the same
    // account re-runs nothing: the quota is identical.
    React.useEffect(() => {
      ping(SELECT_PING);
    }, [route, ping]);
    // The shared primitive's viewport-clamped placement (the vanilla stat
    // dialog's): fixed coordinates recomputed on scroll and resize, riding the
    // panel's inline style. Null until measured.
    const pos = (useAnchoredPosition ?? noPlacement)({
      open,
      anchorRef: btnRef,
      panelRef: popRef,
      side: "top",
      align,
      gap: PANEL_GAP,
      margin: PANEL_MARGIN,
    });
    React.useEffect(() => {
      if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
      const refresh = () => setCached(route === undefined ? undefined : readUsageCache(route));
      window.addEventListener(USAGE_CACHE_EVENT, refresh);
      window.addEventListener("storage", refresh);
      return () => {
        window.removeEventListener(USAGE_CACHE_EVENT, refresh);
        window.removeEventListener("storage", refresh);
      };
    }, [route]);
    // A model switch shows the new account's cached reading immediately (it may
    // be stale; the dim says so) instead of flickering to nothing.
    React.useEffect(() => {
      setCached(route === undefined ? undefined : readUsageCache(route));
    }, [route]);
    // The settings pull, scoped to the selected account: the mirror row says
    // whether the route is a signed-in Claude account and what it is called,
    // and the account's own snapshot feeds the cache. Pulls apply the
    // observation ordering, so a manual /claude-usage run is never regressed
    // by an older document snapshot.
    React.useEffect(() => {
      let disposed = false;
      const pull = async () => {
        if (route === undefined) return;
        try {
          const view = await operations?.describe?.();
          if (disposed || view?.ok !== true) return;
          const accounts = readAccounts(view.value?.namespaces);
          setAccountCount(accounts.mirror.accounts.length);
          const row = accounts.mirror.accounts.find((entry) => entry.route === route);
          setMirror({ route, row });
          if (row === undefined || row.status !== "signedIn") return;
          const next = normalizeUsageView(accounts.snapshots?.[route]);
          if (next === undefined) return;
          const previous = readUsageCache(route);
          const stamp = previous?.observedAt ?? previous?.ts;
          if (previous !== undefined && Number.isFinite(stamp) && next.observedAt < stamp) return;
          writeUsageCache(route, {
            plan: next.plan ?? null,
            windows: next.windows,
            extra: next.extra ?? null,
            observedAt: next.observedAt,
          });
          setCached(readUsageCache(route));
        } catch {
          // A failed pull keeps the cache. The next trigger retries.
        }
      };
      pull();
      const offSettings = operations?.onSettingsUpdated?.((ns) => {
        if (ns === SETTINGS_NS) pull();
      });
      return () => {
        disposed = true;
        offSettings?.();
      };
    }, [operations, route]);
    // The refresh triggers: a sent message and a settled agent turn arrive as
    // forwarded session events carrying their session id. This indicator only
    // answers its own session, so two sessions on different accounts never drive
    // each other's fetches. The 2:30 cadence is this interval; the tooltip's hover
    // and a click ping from their own handlers below. Every ping funnels into the
    // engine's per-account fetch floor, so storms coalesce.
    React.useEffect(() => {
      const offActivity = operations?.onEvent?.("api-session/activity", (id) => {
        if (id === undefined || id === sessionId) ping();
      });
      const offStatus = operations?.onEvent?.("api-session/status", (id, running) => {
        if ((id === undefined || id === sessionId) && running === false) ping();
      });
      const interval = setInterval(() => ping(), 150_000);
      interval?.unref?.();
      return () => {
        offActivity?.();
        offStatus?.();
        clearInterval(interval);
      };
    }, [operations, sessionId, ping]);
    // The staleness dim is computed at render, so a long-lived composer needs a
    // nudge to re-evaluate it: the tick forces one every minute. (unref keeps a
    // Node test run from hanging on the timer handle.)
    React.useEffect(() => {
      if (cached === undefined) return;
      const id = setInterval(() => tick((value) => value + 1), 60_000);
      id?.unref?.();
      return () => clearInterval(id);
    }, [cached]);
    // The vanilla stat dialog's dismissal seat: the shared outside-pointer hook
    // closes the panel on a press outside both the trigger and the (portaled)
    // panel. Containment, not propagation stopping. Escape is handled here, since
    // the shared hook covers pointer dismissal only.
    useOutsideDismiss(btnRef, open, close, popRef);
    React.useEffect(() => {
      if (
        !open ||
        typeof document === "undefined" ||
        typeof document.addEventListener !== "function"
      )
        return;
      const onKeyDown = (event) => {
        if (event.key === "Escape") close();
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [open, close]);
    // The side decision is measured, not declared: the panel's rendered width is
    // max-content between a 300px floor and a 440px cap, known only in the DOM,
    // and the right side depends on where the button sits. useLayoutEffect settles
    // it before the first paint, so a flip is never visible. Re-decided while open
    // on resize and scroll (the triggers the primitive re-measures on) and when
    // the cache changes (the panel's content, hence its width).
    React.useLayoutEffect(() => {
      if (!open || typeof window === "undefined" || typeof window.addEventListener !== "function")
        return;
      const decide = () => {
        const button = btnRef.current;
        const panel = popRef.current;
        if (button === null || panel === null) return;
        const box = button.getBoundingClientRect();
        setAlign(
          popoverAlign({
            anchorLeft: box.left,
            anchorRight: box.right,
            width: panel.offsetWidth,
            viewportWidth: window.innerWidth,
            margin: PANEL_MARGIN,
          }),
        );
      };
      decide();
      window.addEventListener("resize", decide);
      window.addEventListener("scroll", decide, true);
      return () => {
        window.removeEventListener("resize", decide);
        window.removeEventListener("scroll", decide, true);
      };
    }, [open, cached]);
    // Nothing selected, no directory, or a route that is not a signed-in Claude
    // account: render nothing. A needs-sign-in account renders the dimmed mark so
    // the state is visible. Visibility follows the route alone: an account route is
    // a Claude subscription model whether or not the settings pull landed (a slow
    // or failed pull must not hide the indicator). Once the pull has answered for
    // this route, a row that is not a signed-in account (an API-key or removed
    // route) hides it.
    if (route === undefined || !isAccountRoute(route)) return null;
    if (
      mirrorLoaded &&
      (mirrorRow === undefined ||
        (mirrorRow.status !== "signedIn" && mirrorRow.status !== "needsReauth"))
    )
      return null;
    const email = mirrorRow?.email ?? `account …${route.slice(-6)}`;
    // The mark's interactive control: the shared Tooltip (or the bare button with
    // the same props when the host has no primitives). Returned without the
    // wrapping `dsh-cs-pie` span so both states share one definition.
    const triggerButton = (markElement, label, ariaLabel, withPanel) =>
      Tooltip === undefined
        ? h(
            "button",
            {
              ref: btnRef,
              className: "dsh-cs-pieBtn",
              type: "button",
              "aria-label": ariaLabel,
              onMouseEnter: () => ping(),
              onFocus: () => ping(),
              onClick: () => {
                ping();
                if (withPanel) setOpen((value) => !value);
              },
            },
            markElement,
          )
        : h(
            Tooltip,
            // Portal the bubble: the shared Tooltip draws a fixed-position bubble
            // at viewport coordinates. Unportaled, it renders inside the slot
            // row, whose container-type makes that row the containing block. The
            // bubble lands displaced by the row's own offset and never shows.
            // The host's context meter portals its tooltip too.
            { label, side: "top", delayMs: 200, disabled: open, portal: true },
            h(
              "button",
              {
                ref: btnRef,
                className: "dsh-cs-pieBtn",
                type: "button",
                "aria-label": ariaLabel,
                "aria-haspopup": withPanel ? "dialog" : undefined,
                "aria-expanded": withPanel ? open : undefined,
                onMouseEnter: () => ping(),
                onFocus: () => ping(),
                onClick: () => {
                  ping();
                  if (withPanel) setOpen(!open);
                },
              },
              markElement,
            ),
          );
    if (mirrorRow?.status === "needsReauth") {
      const reauthLabel = `${email} needs sign-in again — run /claude-login ${email}`;
      return h(
        "span",
        { className: "dsh-cs-pie", "data-stale": true },
        triggerButton(neutralMark(), reauthLabel, reauthLabel, false),
      );
    }
    // The mark tracks the account's primary quota: the 5-hour family when the cache
    // has one, otherwise the weekly window, otherwise the first usable window. A
    // verified Ultra account has weekly windows and no session window.
    const windows = Array.isArray(cached?.windows) ? cached.windows : [];
    const usable = (window) => typeof window?.label === "string" && Number.isFinite(window.percent);
    const fiveHour = windows.find(
      (window) =>
        usable(window) &&
        (window.label === FIVE_HOUR_LABEL || window.label.startsWith(`${FIVE_HOUR_LABEL} (`)),
    );
    // The weekly window: the general one first, then the scoped ones ("Weekly
    // (Opus)"), the same family the primary falls back to when the plan has no
    // 5-hour window. A spent weekly gate overrides the mark and the reading below.
    const weekly =
      windows.find((window) => usable(window) && window.label === "Weekly") ??
      windows.find((window) => usable(window) && window.label.startsWith("Weekly"));
    const primary = fiveHour ?? weekly ?? windows.find(usable);
    const pending = primary === undefined;
    const percent = primary?.percent ?? 0;
    const clamped = Math.max(0, Math.min(100, percent));
    const weeklyOut = weekly !== undefined && weekly.percent >= 100;
    const markSpent = weeklyOut ? 100 : clamped;
    // A stale snapshot dims rather than disappears. The stamp is the observation
    // time and anchors the countdown.
    const now = Date.now();
    const stamp = typeof cached?.observedAt === "number" ? cached.observedAt : cached?.ts;
    const stale = !pending && typeof stamp === "number" && now - stamp > 5 * 60 * 60 * 1000;
    // The countdown recomputes from the epoch reset (the engine-published shape)
    // or from the string reset anchored at the stamp, so it keeps ticking between
    // fetches instead of freezing on the stored text. A spent weekly window reads
    // its own countdown, because the 5-hour reset would not unblock anything.
    const readingWindow = weeklyOut ? weekly : primary;
    const relative = pending ? "" : resetDetail(readingWindow, stamp, now);
    // The accessible name keeps the countdown in parentheses; the visible tooltip
    // moves it to a second line. The tooltip stays quota-only, with the account
    // named in the open panel instead.
    const detail = relative === "" ? "" : ` (${relative})`;
    // "Quota", not the wire payload's "limits": these surfaces show the consumed
    // share of the plan's periodic allowance, and "limit" reads as rate limiting.
    // The mark and panel titles share this wording. The spent-weekly reading is
    // the one exception: "Weekly limit reached" names the state, not a share.
    const quotaLabel = primary?.label ?? FIVE_HOUR_LABEL;
    const quotaName =
      quotaLabel === "Weekly"
        ? "weekly"
        : quotaLabel.startsWith(FIVE_HOUR_LABEL)
          ? FIVE_HOUR_LABEL
          : quotaLabel;
    const reading = pending
      ? `Fetching ${email} usage…`
      : weeklyOut
        ? "Weekly limit reached"
        : `${percent}% of the ${quotaName} quota was used`;
    const countdown =
      relative === "" ? "" : `\n${relative.charAt(0).toUpperCase()}${relative.slice(1)}`;
    // The label stays a plain string: the shared bubble's own white-space: pre-line
    // rule (_bubble_44yfq_1, dsh 0.2.1-rc.5 web bundle) breaks it at the newline,
    // and the lines share the bubble's single text color.
    const label = `${reading}${countdown}`;
    const ariaLabel = `${reading}${detail}`;
    // Pending: the neutral base mark. A gauge needs a reading.
    const mark = pending
      ? neutralMark()
      : h(
          "svg",
          { viewBox: "0 0 100 100", width: 14, height: 14, "aria-hidden": true },
          // The depletion gauge: a fully-drawn neutral base with the clay mark clipped
          // to its bottom (100 - used)%. The clay level drops like a fuel gauge as the
          // window is used up, full mark at 0% used and fully neutral at the limit.
          // The base is the receded track (.dsh-cs-pieTrack), dimmed toward the card
          // so the spent share never competes with the clay. The clip is a nested svg
          // viewport (y = percent used, height = 100 - used), bottom-anchored via
          // xMinYMax slice: `meet` would rescale the mark and break base-layer
          // alignment, and YMin would paint the top band. The 0.2.1-rc.5 build ships no
          // depletion treatment for a glyph (its meters are the context ring's
          // dasharray and div width-% bars; clipPath there is static-only, and
          // mask/clipPath would need instance-unique ids), so the viewport clip is the
          // plugin-local technique. Overflow is pinned even though inner svgs clip by
          // default (svg:not(:root)).
          h("path", { d: SPARK_PATH, className: "dsh-cs-pieDepleted dsh-cs-pieTrack" }),
          h(
            "svg",
            {
              x: 0,
              y: markSpent,
              width: 100,
              height: 100 - markSpent,
              viewBox: "0 0 100 100",
              preserveAspectRatio: "xMinYMax slice",
              overflow: "hidden",
            },
            h("path", { d: SPARK_PATH, className: "dsh-cs-spark" }),
          ),
        );
    const panel = open
      ? h(
          "div",
          {
            ref: popRef,
            className: "dsh-cs-piePop dsh-cs-sPanel" + (anchored ? " dsh-cs-piePopFixed" : ""),
            role: "dialog",
            "aria-label": "Usage quota",
            // The placement primitive's coordinates, hidden at 0,0
            // until measured, exactly like the vanilla seat. Without
            // the primitive the stylesheet's absolute seat applies
            // and no inline style runs.
            style: anchored ? (pos ?? MEASURE_STYLE) : undefined,
          },
          h(
            "div",
            { className: "dsh-cs-sTitle" },
            h(
              "span",
              { className: "dsh-cs-sTitleLabel" },
              h(ClaudeSpark, {}),
              accountCount > 1 ? `Usage quota · ${email}` : "Usage quota",
            ),
            cached?.plan === null || cached?.plan === undefined
              ? null
              : h("span", { className: "dsh-cs-sTitleValue" }, planLabel(cached.plan)),
          ),
          h("div", { className: "dsh-cs-sRule", "aria-hidden": true }),
          h(
            "dl",
            { className: "dsh-cs-sDetails" },
            (pending ? [] : windows).map((window) => {
              const relative = resetDetail(window, stamp, now);
              return h(
                "div",
                { key: window?.label ?? "window", className: "dsh-cs-sWindow" },
                h("dt", null, window?.label ?? "", relative === "" ? null : ` · ${relative}`),
                h("dd", null, `${window?.percent ?? 0}%`),
                h(
                  "div",
                  { className: "dsh-cs-sBar" },
                  h("div", {
                    className: "dsh-cs-sFill",
                    style: { width: `${Math.max(0, Math.min(100, window?.percent ?? 0))}%` },
                  }),
                ),
              );
            }),
            pending
              ? h(
                  "div",
                  { className: "dsh-cs-sWindow" },
                  h("dt", null, "Status"),
                  h("dd", null, "Fetching…"),
                )
              : null,
            cached?.extra === null || cached?.extra === undefined
              ? null
              : h(
                  "div",
                  { className: "dsh-cs-sWindow" },
                  h("dt", null, EXTRA_LABEL),
                  h("dd", null, cached.extra),
                ),
          ),
        )
      : null;
    // The vanilla stat dialog portals its panel to the document body, out of the
    // composer's clipping and stacking. This one does too when react-dom and the
    // placement primitive are both available, and renders inline otherwise (the
    // stylesheet's absolute seat).
    const seat =
      panel !== null && anchored && ReactDOM?.createPortal !== undefined
        ? ReactDOM.createPortal(panel, document.body)
        : panel;
    return h(
      "span",
      { className: "dsh-cs-pie", "data-stale": stale || undefined },
      triggerButton(mark, label, ariaLabel, true),
      seat,
    );
  }

  /** Id of the Models section's state sentence, the toggle's description. */
  const STATE_ID = "dsh-cs-models-state";

  /** The command the sign-in button pre-fills into a new session's composer. */
  const LOGIN_COMMAND = "/claude-login";

  /** Cordis plugin name in the browser context. Also the module-system id. */
  const name = pluginName;
  const inject = ["slots", "remote", "remote.llm", "remote.settings"];

  /**
   * Mount the Models-page card and its stylesheet.
   * @param {object} ctx - client root context.
   */
  function apply(ctx) {
    ctx.effect(() => {
      const style = document.createElement("style");
      style.dataset.plugin = name;
      style.textContent = CSS;
      document.head.append(style);
      return () => style.remove();
    }, "claude-subscription: styles");

    const operations = createOperations(ctx.remote, SETTINGS_NS);
    // `uiWorkspace.startSession` opens the current workspace's blank session;
    // `prompt` pre-fills its composer draft and `whenDraftExists: "replace"`
    // overwrites a stale draft. Nothing is submitted. Optional service: without it
    // the card omits the button. Looked up per render, not at mount, because the
    // service may mount later.
    const workspace = () => ctx.get?.("uiWorkspace");
    const startLogin = (prompt) => {
      try {
        workspace()?.startSession(undefined, { prompt, whenDraftExists: "replace" });
      } catch {
        // A refused open is already surfaced by the host's workspace notice.
      }
    };
    ctx.slots.inject("settings.models.footer", () =>
      ctx.slots.register(
        {
          name: "settings.models.footer",
          id: "claude-subscription-models",
          order: 10,
          inject: () => ({
            operations,
            startLogin: typeof workspace()?.startSession === "function" ? startLogin : undefined,
          }),
        },
        ClaudeModelsCard,
      ),
    );

    // The chat renders a command's result through this keyed slot (the entry key
    // is the command name). Occupying it replaces the generic card, which shows
    // multi-line output as a code block. The two cards are separate entries under
    // their own command keys, and the keyed dispatch picks one per command name.
    // Neither draws anything while the command is still running (see
    // commandOutcomeBody).
    ctx.slots.inject("conversation.chat.commandview", () =>
      ctx.slots.register(
        { name: "conversation.chat.commandview", key: "claude-usage" },
        ClaudeUsageCard,
      ),
    );
    ctx.slots.inject("conversation.chat.commandview", () =>
      ctx.slots.register(
        { name: "conversation.chat.commandview", key: "claude-account" },
        ClaudeAccountCard,
      ),
    );

    // A compact primary-quota indicator, the plan's spark mark depleted as the
    // limit is used, immediately left of the model selector: the composer renders
    // this list slot's entries right before the model seat. Fed by the host's
    // usage snapshots plus the self-refresh pulls. The operations prop (the same
    // inject seam the models card uses) lets it reach the settings document and the
    // refresh ping.
    ctx.slots.inject("conversation.input.right", () =>
      ctx.slots.register(
        {
          name: "conversation.input.right",
          id: "claude-subscription-usage",
          order: 0,
          // Session-scoped list slots receive the session id (the
          // `conversation.input.plan` slot's precedent): it scopes the activity
          // pings, and the session's model directory names the selected model's
          // account. That directory is an implementation-level host service, not
          // a documented extension point. The lookup is guarded, and a host
          // without it (or a session it cannot resolve) hides the indicator
          // instead of guessing an account.
          inject: (sessionId) => {
            const resolveDirectory = () => {
              try {
                return ctx.get?.("modelDirectories")?.directoryFor?.(sessionId)?.store;
              } catch {
                return undefined;
              }
            };
            return { operations, sessionId, directory: resolveDirectory(), resolveDirectory };
          },
        },
        UsagePie,
      ),
    );
  }

  return { name, inject, apply };
}
