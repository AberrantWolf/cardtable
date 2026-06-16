# cardtable

A spatial canvas for browser tabs: each tab is a **Polaroid card** (screenshot of the
last time it was open) on a 2D table. You can pan and zoom, and group cards together.
New tabs arrive as **cards in your hand** along the bottom — drop them onto the table
into a group or on their own, or discard them. Groups are drawn as **hand-drawn chalk
blobs**. You can annotate cards and rename groups.

I was sad to learn about the dead **Kosmik** browser, so I put together this browser
extension to see if it could help me keep my head together better when dealing with
multple git hosts and ticketing systems for my work tasks. Initial impressions seem
positive so far?

## Status

This is the first pass of something I think is pretty useful. I have some ideas of
features to add in the future (mostly as I want them from using them), but hey, I'm
open to suggestions.

## Run it

... TODO

### Try

- **Drag the felt** to pan, **scroll wheel** to zoom.
- **Click or drag a card** → it raises to the top of the stack (persisted).
- **Drag a card** around; the group outline updates live as you drag it in or out.
  Joining is generous (no overlap needed — you can leave space between cards); leaving
  is sticky (you must drag well clear), so cards don't fall out of a group by accident.
  Drop next to a loose card to start a new group, or in open space to stand alone.
- **Drag a card down into the hand** to pull it back for placing elsewhere.
- **Drag the outline** for a group to move the whole group together.
- **Drag a hand card** (bottom fan) onto the table to place it, or onto **🗑** to discard.
- **Click on a card's bottom strip** to type a note. **Click a group name** to rename.

Grouping feel is tuned by `ADD_PAD` / `REMOVE_PAD` (the join/leave hysteresis) and
`NEW_GROUP_DIST` at the top of `app.js`.

State (positions, groups, notes, view) persists in `localStorage`.
