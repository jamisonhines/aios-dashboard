# Usage model palettes

Retrieved and validated: 2026-10-01. Source of executable colours: `usagePalettes.mjs`.

These are categorical identity palettes, not magnitude ramps. Each model has a fixed slot. Claude uses warm yellow/amber/orange/red/rose anchors; OpenAI uses green/teal/aqua/blue/indigo anchors; local uses violet. Light and dark variants are separately validated. No step is shared or cycled, including across providers.

Within each provider, stack, legend, and table order is ascending slot. Known models are explicitly assigned in `USAGE_EXPLICIT_MODEL_SLOTS`. Claude's eight observed identities occupy slots 0 through 7; historical family-only aliases occupy 8 through 12. OpenAI's eight priced identities and unpriced auto-review occupy 0 through 8. New identities take the next unused step from their provider's ordered list, allocated against the full export and saved in plugin settings (`usageModelColors`). Filtering or rank cannot change an existing assignment. Local identities use their own ordered allocation.

Each palette has 24 unique steps. Beyond capacity the allocator fails explicitly instead of cycling or substituting Other grey. The current export has 8 Claude, 8 OpenAI, and 3 local identities. Many models exceed the usual seven-category guidance. We retain the full labelled legend and numeric table, and use alternating lightness steps to separate neighbours in the fixed order. This is not an all-pairs-safe palette: some non-neighbour steps are close. Labels, not colour alone, identify models. Sub-3:1 mark contrast is conditional relief supported by the visible legend and table. The palettes are validated for adjacent stacks, not scatter or choropleth use.

## Fixed steps in legend/stack order

| Slot | Claude light | Claude dark | OpenAI light | OpenAI dark | Local light | Local dark |
| ---: | --- | --- | --- | --- | --- | --- |
| 0 | #854000 | #924b00 | #006b00 | #177225 | #644089 | #6f4b95 |
| 1 | #fe77bd | #e15ca3 | #8ea0ff | #7a89e7 | #c099ea | #a67fce |
| 2 | #8f3600 | #9c4200 | #006f2d | #007642 | #663f88 | #714a94 |
| 3 | #ff767c | #ee5a63 | #1cb5ff | #3699e2 | #c298e9 | #a87ecd |
| 4 | #9e1900 | #ac2900 | #00714f | #00775b | #683e88 | #734994 |
| 5 | #e89c00 | #cc8200 | #53ca5d | #53a858 | #c497e8 | #a97dcc |
| 6 | #970663 | #a41c6e | #3d40b7 | #4a54ae | #693d87 | #754993 |
| 7 | #f49300 | #d87800 | #00cf83 | #1fab73 | #c596e7 | #ab7ccb |
| 8 | #a30026 | #b01530 | #0056b2 | #0064a9 | #6b3d86 | #774893 |
| 9 | #ff7f37 | #eb640d | #00d0a6 | #00ac8c | #c795e6 | #ad7bca |
| 10 | #883f00 | #944b00 | #006c00 | #167324 | #6d3c86 | #784792 |
| 11 | #ff73bd | #e259a3 | #8c9eff | #7988e7 | #c993e4 | #af7ac9 |
| 12 | #923500 | #9f4100 | #00712c | #007742 | #6f3b85 | #7a4691 |
| 13 | #ff7279 | #ef5661 | #00b4ff | #3398e2 | #cb92e3 | #b079c8 |
| 14 | #a11400 | #af2600 | #00724f | #00785b | #703a84 | #7c4690 |
| 15 | #e99a00 | #cd8000 | #4dca59 | #51a757 | #cd91e2 | #b278c6 |
| 16 | #9a0064 | #a7186f | #3d3fbb | #4b55b0 | #723a83 | #7e458f |
| 17 | #f59100 | #d97600 | #00ce80 | #17ab72 | #cf90e0 | #b477c5 |
| 18 | #a60024 | #b30e2f | #0056b6 | #0065ab | #743982 | #80448e |
| 19 | #ff7c2f | #ec6000 | #00d0a5 | #00ac8b | #d08fdf | #b576c3 |
| 20 | #8a3f00 | #974b00 | #006e00 | #157524 | #763881 | #82438d |
| 21 | #ff70bc | #e355a2 | #8a9cff | #7887e7 | #d28edd | #b775c2 |
| 22 | #943400 | #a14000 | #00722b | #007843 | #773780 | #83438c |
| 23 | #ff6e77 | #f1525e | #00b3ff | #2f97e2 | #d48ddb | #b973c0 |

## Derivation and validation

Candidates were derived in OKLCH at fixed provider hue anchors with alternating lightness, then converted to sRGB. Initial candidates failed the chroma floor after gamut clipping for yellow and aqua. Those were re-stepped, not accepted. A later cool dark candidate failed normal separation at 14.5 and was re-stepped. The final cool dark palette uses smaller chroma and a higher lightness anchor, clearing the normal floor at 16.0. Violet uses small hue steps within its provider range to prevent sRGB rounding from duplicating hex values.

The implementation report includes CLI validator command/output for each provider and the combined order, in light on #ffffff and dark on #1e1e1e, plus the actual export's whole-window model order. Those 16 runs exit 0; no CVD floor-band exception is needed in those orders. Numeric table and legend labels satisfy contrast relief only.

## Shipment blocker: sparse daily order

Further validation of the actual daily stacks found 66 of 72 day/mode combinations fail separation. For example, the first day contains only Opus 5 and Sonnet 5. Their light steps #fe77bd and #ff767c have normal Delta E 9.1, below the mandatory 15 floor. These normally non-adjacent slots become neighbours when other models are absent. Labels cannot excuse this hard failure.

The palette work is incomplete and must not ship. Passing a full reserved order is insufficient when filtering creates new neighbours. A revised encoding must clear sparse combinations, not merely the full legend. Twenty-four unique hex steps are not twenty-four perceptually separated identities within a narrow provider hue range. No approval or all-pairs safety claim is made.
