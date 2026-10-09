# Workflow — from printed kit to finished casts

A practical guide to the physical side of Meltemi Mold Studio: what to buy, how to assemble the
printed kit, how to pour silicone and casting material, and how to fix what goes wrong. The
example is the built-in demo (three taper candles), but every step applies to any master.

```
 ┌──────────── stage 1: silicone pour ────────────┐   ┌────────── stage 2: casting ──────────┐
 │                                                │   │                                      │
 │   shell A │ board │ shell B   (long pins,      │   │  shell A + silicone A │ silicone B + │
 │      ▲    │reliefs│    ▲       silicone clips) │   │  shell B   (short pins, cast clips)  │
 │      └─ silicone fills the gap between the     │   │      └─ wax / resin fills the cavity │
 │         shell and the board's master reliefs   │   │         left by the master           │
 └────────────────────────────────────────────────┘   └──────────────────────────────────────┘
```

## 1. Materials & tools

| Item | Recommendation | Notes |
|---|---|---|
| Filament | PLA (default) or PETG | PETG if the mold sits in sun / hot car or for wax poured > 80 °C |
| Silicone | Platinum-cure RTV, Shore **10A–30A** | e.g. "Mold Star 15/16/30", "Dragon Skin", "Smooth-Sil", "Platinum 25"… 10–15A: deep relief, undercuts, thin tapers. 25–30A: large, crisp, durable |
| — alternative | Tin-cure (condensation) RTV | cheaper, tolerant of contaminants, 0.2–0.5 % shrink, shorter life with resins |
| Release agent (print ↔ silicone) | Ease Release 200 (spray), or a *thin* wiped film of vaseline (petroleum jelly) | Silicone locks into FDM layer lines, so release is not optional |
| Release (silicone ↔ silicone) | not needed — the board separates the two halves | if you ever pour silicone against cured silicone: Ease Release 200 or vaseline, otherwise it bonds |
| Scale | 0.1 g resolution | mix by **weight**, not volume |
| Cups & sticks | clear PP cups, flat wooden sticks | flat sticks scrape the walls; no wax-coated cups |
| Vacuum chamber (optional) | −0.95 bar | degassing; without it, use the high-pour technique below |
| Casting material | paraffin / soy / beeswax, PU or epoxy resin, plaster / Jesmonite, M&P soap, concrete | see §6 for temperatures |
| Candles extra | cotton wick (flat-braid or square-braid), wick putty / mold sealer (or Blu-Tack), wick bar / skewer | |

Silicone cure inhibition: platinum silicone stays sticky against sulfur clays, latex gloves,
some fresh resin prints (SLA/MSLA — post-cure thoroughly), tin-cure silicone and some tapes. Do a
thumbnail-size test pour on a printed scrap first. PLA and PETG themselves are fine.

## 2. Printing the kit

* **Shells A and B**: exactly as exported (upright, plinth down) — no supports. 0.2 mm layers,
  **4–6 perimeters**, 15–25 % gyroid infill. The cavity side is a single-wall-ish skin backed
  by ribs; enough perimeters make it watertight.
* **Parting board**: double-sided board prints upright (on its edge) — the reliefs face ±Y;
  enable a brim. Single-sided boards print flat, relief up. Finer layers (0.12–0.16 mm) on the
  board pay off: every layer line ends up on the cast.
* **Clips**: flat, 100 % infill or 6+ perimeters (they flex). PETG clips last longer.
* **Pins**: flat or upright, 100 % infill. Print 1–2 spares.
* Check: pins slide into the holes with light friction, a clip snaps over a flange stack with
  firm thumb pressure. Otherwise adjust `pinClearance` / `clipInterference` and reprint only those.

## 3. Preparing the mold box (stage 1)

1. **Clean** the master reliefs on the board: sand / prime / spray-fill if you want a glossy cast
   (silicone copies everything, including layer lines). Optional: a coat of clear lacquer or
   XTC-3D on the reliefs, fully cured.
2. **Release**: spray Ease Release 200 on the shell insides, flange faces, board and reliefs,
   brush into corners, let flash off ~10 min, second coat. With vaseline: wipe the thinnest film
   you can, then wipe again with a dry paper towel — thick vaseline leaves a matte, wavy surface.
3. **Assemble**: shell A | board | shell B. Push the **long pins** through flange A, the board and
   flange B. Snap the **silicone-stage clips** on the side flanges, then the bottom ones.
4. **Seal**: for the first use, run a thin bead of hot glue or plasticine along the outside of the
   flange seams and the plinth. Stand the box on a level surface (check with a phone level).

```
        open top (pour here)
   ┌───┐ ▼ ▼ ▼ ┌──┬──┐ ▼ ▼ ▼ ┌───┐
   │ A │ silic.│bo│ar│ silic.│ B │   ← section through the parting plane
   │   │ (pour)│d │  │ (pour)│   │     each shell's cavity = silicone layer
   │   │       │re│li│       │   │     around the board's master reliefs
   └┬─┬┘       └ef┴s ┘       └┬─┬┘
    ribs / feet stand on the table
```

## 4. Mixing, degassing and pouring silicone

1. **Quantity**: `README.txt` / `report.json` give the silicone volume and the part A / part B
   weights for your mix ratio. Mix **10 % extra** (cup and stick losses).
2. **Pre-stir** each component (fillers settle). Weigh A, then B into the same cup.
3. **Mix** 2–3 min, scraping walls and bottom; then pour into a second clean cup and mix 1 min
   more ("double cup") — unmixed silicone from the walls never cures.
4. **Degas** (optional, recommended for detail): vacuum until the foam rises and collapses, plus
   1–2 min. Mind the pot life (typically 6–50 min).
5. **Pour**: hold the cup **30–50 cm above** the mold and pour a **thin, steady stream into the
   lowest corner** of one side — not onto the reliefs. The thin stream breaks bubbles; the
   silicone climbs up and pushes air out ahead of it. Let it flow around the board edge into the
   other side or pour both sides alternately so the levels stay similar (the board must not bow).
6. Fill to the rim. Tap the table / sides for a minute to release bubbles; pop surface bubbles
   with a quick pass of a heat gun or a torch held well away.
7. **Cure** at 20–25 °C: platinum silicones typically demold in **4–16 h** (fast grades 75 min),
   tin-cure 16–24 h. Cold rooms (< 18 °C) slow cure a lot. Full properties after 24 h; a 2–4 h post
   cure at 60 °C helps platinum molds used for hot wax/resin.

## 5. Opening and closing for casting (stage 2)

1. Remove the clips and the long pins. Pull shell **A** off in **−Y** and shell **B** in **+Y** —
   each silicone half stays in its shell. Flex the shell slightly; never pry against the board
   reliefs.
2. Lift out the **parting board**. Check the silicone: complete keys (tongue on one half, groove on
   the other), no tears at thin spots, vents and wick channel open.
3. Trim flash (thin films at the parting line) with a sharp knife or scissors.
4. Close the two halves face to face with the **short pins**, snap on the **cast clips**. The
   tongue-and-groove key seals the cavity; the shells keep the soft silicone from bulging.
5. Stand the closed mold upright on its feet.

## 6. Casting

### Candles (wax)

* **Wick**: thread the wick from the bottom through the wick channel up through the cavity (a
  needle or thin wire helps), centre it at the top with a wick bar / two skewers, pull it straight.
  **Seal the wick hole** at the bottom with a pea of wick putty (or Blu-Tack) — hot wax finds every
  gap. Wick size: tapers 20–25 mm diameter → flat-braid **#2–#4 / 15–24 ply** (paraffin),
  one size larger for beeswax / soy; follow your supplier's chart for the diameter at the base.
* **Temperature**: paraffin tapers pour at **~70–80 °C** (just above the melt point gives fewer
  sink holes, hotter gives a glossier surface); beeswax 70–75 °C; soy blends 65–75 °C. Silicone
  tolerates > 200 °C; PLA softens from ~55 °C — the silicone insulates it, but do not leave a
  PLA mold full of hot wax in a warm place. PETG for hot pours.
* **Pour** slowly into the opening, filling to the top of the pour extension (sprue). Wax shrinks
  ~10 % on cooling: after 20–40 min a **sink well** forms around the wick — poke relief holes
  near the wick and **top up** with wax 5–10 °C hotter.
* Let it cool fully (1–3 h at room temperature, or fridge after it has set). Open, peel the
  silicone off, trim the pour stub flat, cut the wick.

### Resin (PU / epoxy)

* Mix per datasheet, pour thin and slow into the lowest point / sprue. The vents must reach the
  rim; a little resin coming out of each vent means the pocket is full.
* Pressure pot (2–4 bar) gives bubble-free casts; otherwise warm the resin to lower viscosity.
* Epoxy exotherm in thick parts can exceed 100 °C — PETG shells, or thinner sections.

### Plaster / Jesmonite / concrete

* Mist the silicone with water or a drop of dish soap solution (surface tension), brush the first
  thin coat into the detail, then fill. Vibrate / tap to release air.

### Soap / chocolate

* Food or cosmetic use needs **food-safe platinum silicone** and food-safe release; the printed
  shells never touch the product. Chocolate: temper, pour, tap, chill 15 min.

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| **Silicone leaks** at seams or the plinth | flanges not flat (warped print), clips loose, gap at the board edge | seal seams with hot glue / plasticine before the pour; increase `clipInterference` or `clipsPerSide`; print the shells with brim and lower bed-to-chamber temperature differences |
| **Wax / resin leaks** at the parting line | silicone halves not pressed together, keys not seated, flash in the key groove | trim flash, check the pins are seated, more clips; increase `keyHeight` |
| **Flash** (thin fins) on the cast | parting faces not in contact, too much release agent, soft silicone bulging | wipe release agent thin; harder silicone or thicker `siliconeThickness`; tighter clips |
| **Bubbles on the cast surface** | air trapped in the detail when pouring the cast | pour slower into the lowest point; brush a thin first coat into the detail (resin, plaster); check vents are open; pressure pot for resin |
| **Bubbles in the silicone** (dimples on the cast) | mixing air, pouring onto the master | high thin-stream pour into the lowest corner; degas; let the mix rest 2 min before pouring |
| **Sink marks / holes** (wax) | volume shrink on cooling | pour cooler; poke relief holes and top up; insulate the mold top so it solidifies last |
| **Cast sticks** / silicone tears | undercuts deeper than the silicone can stretch, no release with resin | softer silicone (10–15A) or thicker skin; release agent for PU resin; demold slower, flex the silicone not the cast |
| **Silicone stuck to the print** | no / insufficient release agent | release every time; seal the print (XTC-3D, primer); vaseline wiped thin |
| **Silicone stays tacky** | cure inhibition | test the master and agents; avoid latex gloves, sulfur clay, fresh SLA resin; post-cure the print |
| **Pins too tight / loose** | printer tolerance | change `pinClearance` (±0.1) and reprint the pins only |
| **Clip cracks** | too much interference, brittle PLA | `clipInterference` 0.1, print clips in PETG, more perimeters |
| **Shell bows during the pour** | tall thin walls, warm silicone exotherm | more ribs (`ribSpacing` smaller), thicker `wallThickness`, more clips at the bottom |
| **Air trapped in a pocket** (incomplete cast) | pocket shallower than `ventMinDepth`, or orientation | lower `ventMinDepth`, rotate the master so the pocket points up toward the pour |

## 8. Care

Clean silicone with warm soapy water, dry, store flat in its shells (the shells keep it from
deforming). Wax-only molds last hundreds of casts; resin degrades silicone faster (store with a
thin film of release). Label each kit with the `report.json` parameters so it can be reprinted.
