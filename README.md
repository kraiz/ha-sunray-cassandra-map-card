# Sunray / CaSSAndRA Map Card

A plain-canvas Lovelace card for Home Assistant that renders the live mowing map
from the [ha-sunray-cassandra](https://github.com/ha-sunray-cassandra/ha-sunray-cassandra)
integration.

## What it renders

| Layer | Description |
|---|---|
| Perimeter | Garden boundary (filled + outline) |
| Exclusion zones | No-go areas inside the perimeter |
| Mow path — done | Completed portion of the current route |
| Mow path — todo | Remaining portion |
| Obstacles | Dynamically detected obstacles |
| Dock approach | Docking line (dashed) |
| Rover dot | Current robot position with glow |

## Requirements

- [ha-sunray-cassandra](https://github.com/ha-sunray-cassandra/ha-sunray-cassandra) integration installed and configured
- The **Map Data** sensor entity must be **enabled** in the entity registry (it is disabled by default — go to *Settings → Devices & Services → Sunray / CaSSAndRA → entities → Map Data → Enable*)

## Installation via HACS

1. In HACS go to **Frontend → Custom repositories**
2. Add `ha-sunray-cassandra/ha-sunray-cassandra-map-card` as type **Dashboard**
3. Install the card and reload your browser

## Manual installation

Copy `sunray-cassandra-map-card.js` to `<config>/www/` and add a Lovelace resource:

```yaml
url: /local/sunray-cassandra-map-card.js
type: module
```

## Card configuration

```yaml
type: custom:sunray-cassandra-map-card
entity: sensor.cassandra_map_data   # required — the Map Data sensor
title: Garden Map                   # optional — card header text
height: 400                         # optional — canvas height in px (default 400)

# All colours are optional — these are the defaults:
background:       "#1a1a2e"
perimeter_fill:   "rgba(34, 139, 34, 0.18)"
perimeter_stroke: "#4caf50"
exclusion_fill:   "rgba(180, 30, 30, 0.25)"
exclusion_stroke: "#e53935"
obstacle_fill:    "rgba(255, 152, 0, 0.35)"
obstacle_stroke:  "#ff9800"
mow_done:         "#1565c0"
mow_todo:         "rgba(100, 181, 246, 0.45)"
dock_stroke:      "#ffd54f"
rover_fill:       "#ffffff"
rover_stroke:     "#00e5ff"
rover_radius:     6       # rover dot radius in px
padding:          16      # padding around map content in px
```

## How the progress split works

CaSSAndRA publishes `finished_idx` (how many mow-path points have been visited)
and `idx_total` (total points). The card draws the first `finished_idx` points in
`mow_done` colour and the rest in `mow_todo` colour, giving a visual progress
indicator along the actual route.

## Coordinate system

All coordinates in the GeoJSON are in **metres relative to the GPS origin** stored
in `origin_lat` / `origin_lon`.  The card projects them to canvas pixels using a
scale-to-fit transform that keeps the full map visible with uniform padding.
Y-axis is flipped (positive = north = up on screen).
