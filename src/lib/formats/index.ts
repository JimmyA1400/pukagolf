/**
 * What `@/lib/formats` means today: the events' original format module,
 * unchanged.
 *
 * The unified system lives beside it and is imported explicitly —
 * `formats/registry` for the list and what each format means,
 * `formats/field` for turning a roster into sides,
 * `formats/teams` for the one shape a side takes whichever table it came from.
 *
 * Kept apart on purpose. The outing pages score real rounds through `legacy`
 * and will move across a page at a time; re-exporting the new registry under
 * the old names here would silently change what `getFormat` returns for all
 * of them at once. When the last page has moved, `legacy` goes and this file
 * becomes `export * from "./registry"`.
 */

export * from "./legacy";
