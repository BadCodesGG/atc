/**
 * The followed flight's silhouette, nose up, in a 40-unit box centred on the origin: the map draws its
 * icon from it, and the diorama's beacon draws the same shape over the diorama, so the two are one mark
 * across a hand between them.
 */
export const AIRCRAFT_GLYPH = "M0 -15C2.2 -13 2.2 -9 2.2 -6L14 2L14 5L2.2 1L2 9L6 13L6 15L0 13L-6 15L-6 13L-2 9L-2.2 1L-14 5L-14 2L-2.2 -6C-2.2 -9 -2.2 -13 0 -15Z";
/** The glyph's box, units, which the map's icon draws at 20 CSS pixels for an icon size of 1. */
export const GLYPH_BOX = 40;
export const GLYPH_PX = 20;
/** The beacon's ring round the followed flight, CSS pixels, as the map's circle layer draws it. */
export const BEACON_RADIUS_PX = 15;
