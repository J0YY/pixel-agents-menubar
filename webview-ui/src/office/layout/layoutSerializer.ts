import { TileType, FurnitureType, DEFAULT_COLS, DEFAULT_ROWS, TILE_SIZE, Direction } from '../types.js'
import type { TileType as TileTypeVal, OfficeLayout, PlacedFurniture, Seat, FurnitureInstance, FloorColor } from '../types.js'
import { getCatalogEntry } from './furnitureCatalog.js'
import { getColorizedSprite } from '../colorize.js'

/** Convert flat tile array from layout into 2D grid */
export function layoutToTileMap(layout: OfficeLayout): TileTypeVal[][] {
  const map: TileTypeVal[][] = []
  for (let r = 0; r < layout.rows; r++) {
    const row: TileTypeVal[] = []
    for (let c = 0; c < layout.cols; c++) {
      row.push(layout.tiles[r * layout.cols + c])
    }
    map.push(row)
  }
  return map
}

/** Convert placed furniture into renderable FurnitureInstance[] */
export function layoutToFurnitureInstances(furniture: PlacedFurniture[]): FurnitureInstance[] {
  // Pre-compute desk zY per tile so surface items can sort in front of desks
  const deskZByTile = new Map<string, number>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    const deskZY = item.row * TILE_SIZE + entry.sprite.length
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        const prev = deskZByTile.get(key)
        if (prev === undefined || deskZY > prev) deskZByTile.set(key, deskZY)
      }
    }
  }

  const instances: FurnitureInstance[] = []
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const x = item.col * TILE_SIZE
    const y = item.row * TILE_SIZE
    const spriteH = entry.sprite.length
    let zY = y + spriteH

    // Chair z-sorting: ensure characters sitting on chairs render correctly
    if (entry.category === 'chairs') {
      if (entry.orientation === 'back') {
        // Back-facing chairs render IN FRONT of the seated character
        // (the chair back visually occludes the character behind it)
        zY = (item.row + 1) * TILE_SIZE + 1
      } else {
        // All other chairs: cap zY to first row bottom so characters
        // at any seat tile render in front of the chair
        zY = (item.row + 1) * TILE_SIZE
      }
    }

    // Surface items render in front of the desk they sit on
    if (entry.canPlaceOnSurfaces) {
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          const deskZ = deskZByTile.get(`${item.col + dc},${item.row + dr}`)
          if (deskZ !== undefined && deskZ + 0.5 > zY) zY = deskZ + 0.5
        }
      }
    }

    // Colorize sprite if this furniture has a color override
    let sprite = entry.sprite
    if (item.color) {
      const { h, s, b: bv, c: cv } = item.color
      sprite = getColorizedSprite(`furn-${item.type}-${h}-${s}-${bv}-${cv}-${item.color.colorize ? 1 : 0}`, entry.sprite, item.color)
    }

    instances.push({ sprite, x, y, zY })
  }
  return instances
}

/** Get all tiles blocked by furniture footprints, optionally excluding a set of tiles.
 *  Skips top backgroundTiles rows so characters can walk through them. */
export function getBlockedTiles(furniture: PlacedFurniture[], excludeTiles?: Set<string>): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows — characters can walk through
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const key = `${item.col + dc},${item.row + dr}`
        if (excludeTiles && excludeTiles.has(key)) continue
        tiles.add(key)
      }
    }
  }
  return tiles
}

/** Get tiles blocked for placement purposes — skips top backgroundTiles rows per item */
export function getPlacementBlockedTiles(furniture: PlacedFurniture[], excludeUid?: string): Set<string> {
  const tiles = new Set<string>()
  for (const item of furniture) {
    if (item.uid === excludeUid) continue
    const entry = getCatalogEntry(item.type)
    if (!entry) continue
    const bgRows = entry.backgroundTiles || 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      if (dr < bgRows) continue // skip background rows
      for (let dc = 0; dc < entry.footprintW; dc++) {
        tiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }
  return tiles
}

/** Map chair orientation to character facing direction */
function orientationToFacing(orientation: string): Direction {
  switch (orientation) {
    case 'front': return Direction.DOWN
    case 'back': return Direction.UP
    case 'left': return Direction.LEFT
    case 'right': return Direction.RIGHT
    default: return Direction.DOWN
  }
}

/** Generate seats from chair furniture.
 *  Facing priority: 1) chair orientation, 2) adjacent desk, 3) forward (DOWN). */
export function layoutToSeats(furniture: PlacedFurniture[]): Map<string, Seat> {
  const seats = new Map<string, Seat>()

  // Build set of all desk tiles
  const deskTiles = new Set<string>()
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || !entry.isDesk) continue
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        deskTiles.add(`${item.col + dc},${item.row + dr}`)
      }
    }
  }

  const dirs: Array<{ dc: number; dr: number; facing: Direction }> = [
    { dc: 0, dr: -1, facing: Direction.UP },    // desk is above chair → face UP
    { dc: 0, dr: 1, facing: Direction.DOWN },   // desk is below chair → face DOWN
    { dc: -1, dr: 0, facing: Direction.LEFT },   // desk is left of chair → face LEFT
    { dc: 1, dr: 0, facing: Direction.RIGHT },   // desk is right of chair → face RIGHT
  ]

  // For each chair, every footprint tile becomes a seat.
  // Multi-tile chairs (e.g. 2-tile couches) produce multiple seats.
  for (const item of furniture) {
    const entry = getCatalogEntry(item.type)
    if (!entry || entry.category !== 'chairs') continue

    let seatCount = 0
    for (let dr = 0; dr < entry.footprintH; dr++) {
      for (let dc = 0; dc < entry.footprintW; dc++) {
        const tileCol = item.col + dc
        const tileRow = item.row + dr

        // Determine facing direction:
        // 1) Chair orientation takes priority
        // 2) Adjacent desk direction
        // 3) Default forward (DOWN)
        let facingDir: Direction = Direction.DOWN
        if (entry.orientation) {
          facingDir = orientationToFacing(entry.orientation)
        } else {
          for (const d of dirs) {
            if (deskTiles.has(`${tileCol + d.dc},${tileRow + d.dr}`)) {
              facingDir = d.facing
              break
            }
          }
        }

        // First seat uses chair uid (backward compat), subsequent use uid:N
        const seatUid = seatCount === 0 ? item.uid : `${item.uid}:${seatCount}`
        seats.set(seatUid, {
          uid: seatUid,
          seatCol: tileCol,
          seatRow: tileRow,
          facingDir,
          assigned: false,
        })
        seatCount++
      }
    }
  }

  return seats
}

/** Get the set of tiles occupied by seats (so they can be excluded from blocked tiles) */
export function getSeatTiles(seats: Map<string, Seat>): Set<string> {
  const tiles = new Set<string>()
  for (const seat of seats.values()) {
    tiles.add(`${seat.seatCol},${seat.seatRow}`)
  }
  return tiles
}

/** Default floor colors for the two rooms */
const DEFAULT_LEFT_ROOM_COLOR: FloorColor = { h: 35, s: 30, b: 15, c: 0 }  // warm beige
const DEFAULT_RIGHT_ROOM_COLOR: FloorColor = { h: 25, s: 45, b: 5, c: 10 }  // warm brown
const DEFAULT_CARPET_COLOR: FloorColor = { h: 280, s: 40, b: -5, c: 0 }     // purple
const DEFAULT_DOORWAY_COLOR: FloorColor = { h: 35, s: 25, b: 10, c: 0 }     // tan
const DEFAULT_STUDIO_COLOR: FloorColor = { h: 196, s: 14, b: -8, c: 4 }
const DEFAULT_COURTYARD_COLOR: FloorColor = { h: 126, s: 18, b: -14, c: 6 }
const DEFAULT_LOUNGE_COLOR: FloorColor = { h: 202, s: 10, b: -18, c: 10 }

type DeskSide = 'top' | 'bottom' | 'left' | 'right'

interface FloorZone {
  left: number
  right: number
  top: number
  bottom: number
  tile: TileTypeVal
  color: FloorColor
}

export const ROOM_LAYOUT_TEMPLATES = [
  { id: 'split-office', label: 'Split Office', description: 'Two connected wings with desk stations in each room.' },
  { id: 'studio-loft', label: 'Studio Loft', description: 'An open L-shaped room with a single shared floor.' },
  { id: 'courtyard-ring', label: 'Courtyard Ring', description: 'A ring-shaped office with an interior courtyard void.' },
] as const

export type RoomLayoutTemplateId = (typeof ROOM_LAYOUT_TEMPLATES)[number]['id']

/** Create the default office layout with one desk setup per agent seat. */
export function createDefaultLayout(): OfficeLayout {
  return createLayoutTemplate('split-office')
}

export function createLayoutTemplate(templateId: RoomLayoutTemplateId): OfficeLayout {
  switch (templateId) {
    case 'studio-loft':
      return createStudioLoftLayout()
    case 'courtyard-ring':
      return createCourtyardRingLayout()
    case 'split-office':
    default:
      return createSplitOfficeLayout()
  }
}

function createSplitOfficeLayout(): OfficeLayout {
  const zones: FloorZone[] = [
    { left: 1, top: 1, right: 9, bottom: 19, tile: TileType.FLOOR_1, color: DEFAULT_LEFT_ROOM_COLOR },
    { left: 11, top: 1, right: 19, bottom: 19, tile: TileType.FLOOR_2, color: DEFAULT_RIGHT_ROOM_COLOR },
    { left: 10, top: 9, right: 10, bottom: 11, tile: TileType.FLOOR_4, color: DEFAULT_DOORWAY_COLOR },
    { left: 14, top: 13, right: 18, bottom: 17, tile: TileType.FLOOR_3, color: DEFAULT_CARPET_COLOR },
  ]

  const furniture: PlacedFurniture[] = [
    ...buildDeskStation('split-left-a', 2, 2, 'top'),
    ...buildDeskStation('split-left-b', 6, 2, 'top'),
    ...buildDeskStation('split-left-c', 2, 8, 'bottom'),
    ...buildDeskStation('split-left-d', 6, 8, 'bottom'),
    ...buildDeskStation('split-right-a', 12, 2, 'top'),
    ...buildDeskStation('split-right-b', 15, 2, 'top'),
    ...buildDeskStation('split-right-c', 12, 8, 'bottom'),
    ...buildDeskStation('split-right-d', 15, 8, 'bottom'),
    { uid: 'split-bookshelf', type: FurnitureType.BOOKSHELF, col: 1, row: 14 },
    { uid: 'split-plant-left', type: FurnitureType.PLANT, col: 8, row: 17 },
    { uid: 'split-cooler', type: FurnitureType.COOLER, col: 17, row: 14 },
    { uid: 'split-plant-right', type: FurnitureType.PLANT, col: 18, row: 17 },
  ]

  return createLayoutFromZones(DEFAULT_COLS, DEFAULT_ROWS, zones, furniture)
}

function createStudioLoftLayout(): OfficeLayout {
  const zones: FloorZone[] = [
    { left: 1, top: 1, right: 14, bottom: 16, tile: TileType.FLOOR_6, color: DEFAULT_STUDIO_COLOR },
    { left: 15, top: 7, right: 22, bottom: 16, tile: TileType.FLOOR_7, color: DEFAULT_LOUNGE_COLOR },
    { left: 3, top: 4, right: 12, bottom: 6, tile: TileType.FLOOR_4, color: DEFAULT_DOORWAY_COLOR },
  ]

  const furniture: PlacedFurniture[] = [
    ...buildDeskStation('studio-a', 3, 2, 'top'),
    ...buildDeskStation('studio-b', 7, 2, 'top'),
    ...buildDeskStation('studio-c', 11, 2, 'top'),
    ...buildDeskStation('studio-d', 3, 9, 'bottom'),
    ...buildDeskStation('studio-e', 7, 9, 'bottom'),
    ...buildDeskStation('studio-f', 16, 10, 'right'),
    { uid: 'studio-bookshelf', type: FurnitureType.BOOKSHELF, col: 21, row: 8 },
    { uid: 'studio-cooler', type: FurnitureType.COOLER, col: 20, row: 14 },
    { uid: 'studio-plant-a', type: FurnitureType.PLANT, col: 2, row: 14 },
    { uid: 'studio-plant-b', type: FurnitureType.PLANT, col: 13, row: 14 },
  ]

  return createLayoutFromZones(24, 18, zones, furniture)
}

function createCourtyardRingLayout(): OfficeLayout {
  const zones: FloorZone[] = [
    { left: 1, top: 1, right: 23, bottom: 17, tile: TileType.FLOOR_6, color: DEFAULT_COURTYARD_COLOR },
    { left: 4, top: 4, right: 20, bottom: 14, tile: TileType.FLOOR_7, color: DEFAULT_LOUNGE_COLOR },
  ]

  const courtyardVoid = createVoidZone(8, 6, 16, 12)
  const furniture: PlacedFurniture[] = [
    ...buildDeskStation('court-a', 3, 2, 'top'),
    ...buildDeskStation('court-b', 7, 2, 'top'),
    ...buildDeskStation('court-c', 15, 2, 'top'),
    ...buildDeskStation('court-d', 19, 2, 'top'),
    ...buildDeskStation('court-e', 3, 13, 'bottom'),
    ...buildDeskStation('court-f', 7, 13, 'bottom'),
    ...buildDeskStation('court-g', 15, 13, 'bottom'),
    ...buildDeskStation('court-h', 19, 13, 'bottom'),
    { uid: 'court-cooler', type: FurnitureType.COOLER, col: 22, row: 9 },
    { uid: 'court-bookshelf', type: FurnitureType.BOOKSHELF, col: 1, row: 8 },
    { uid: 'court-plant-a', type: FurnitureType.PLANT, col: 5, row: 16 },
    { uid: 'court-plant-b', type: FurnitureType.PLANT, col: 19, row: 16 },
  ]

  return createLayoutFromZones(25, 19, zones, furniture, courtyardVoid)
}

function createLayoutFromZones(
  cols: number,
  rows: number,
  zones: FloorZone[],
  furniture: PlacedFurniture[],
  voidKeys: Set<string> = new Set(),
): OfficeLayout {
  const tiles: TileTypeVal[] = new Array(cols * rows).fill(TileType.VOID)
  const tileColors: Array<FloorColor | null> = new Array(cols * rows).fill(null)
  const floorKeys = new Set<string>()

  for (const zone of zones) {
    for (let row = zone.top; row <= zone.bottom; row++) {
      for (let col = zone.left; col <= zone.right; col++) {
        const key = `${col},${row}`
        if (voidKeys.has(key)) continue
        const idx = row * cols + col
        tiles[idx] = zone.tile
        tileColors[idx] = zone.color
        floorKeys.add(key)
      }
    }
  }

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col
      if (tiles[idx] !== TileType.VOID) continue
      if (hasAdjacentFloor(col, row, floorKeys)) {
        tiles[idx] = TileType.WALL
      }
    }
  }

  return { version: 1, cols, rows, tiles, tileColors, furniture }
}

function hasAdjacentFloor(col: number, row: number, floorKeys: Set<string>): boolean {
  return floorKeys.has(`${col},${row - 1}`)
    || floorKeys.has(`${col + 1},${row}`)
    || floorKeys.has(`${col},${row + 1}`)
    || floorKeys.has(`${col - 1},${row}`)
}

function createVoidZone(left: number, top: number, right: number, bottom: number): Set<string> {
  const keys = new Set<string>()
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      keys.add(`${col},${row}`)
    }
  }
  return keys
}

function buildDeskStation(uid: string, deskCol: number, deskRow: number, chairSide: DeskSide): PlacedFurniture[] {
  const station: PlacedFurniture[] = [
    { uid: `${uid}-desk`, type: FurnitureType.DESK, col: deskCol, row: deskRow },
    { uid: `${uid}-pc`, type: FurnitureType.PC, col: deskCol + getPcOffset(chairSide).col, row: deskRow + getPcOffset(chairSide).row },
  ]

  const chairPosition = getChairPosition(deskCol, deskRow, chairSide)
  station.push({ uid: `${uid}-chair`, type: FurnitureType.CHAIR, col: chairPosition.col, row: chairPosition.row })
  return station
}

function getChairPosition(deskCol: number, deskRow: number, chairSide: DeskSide): { col: number; row: number } {
  switch (chairSide) {
    case 'bottom':
      return { col: deskCol, row: deskRow + 2 }
    case 'left':
      return { col: deskCol - 1, row: deskRow }
    case 'right':
      return { col: deskCol + 2, row: deskRow }
    case 'top':
    default:
      return { col: deskCol, row: deskRow - 1 }
  }
}

function getPcOffset(chairSide: DeskSide): { col: number; row: number } {
  switch (chairSide) {
    case 'bottom':
      return { col: 1, row: 0 }
    case 'left':
      return { col: 1, row: 1 }
    case 'right':
      return { col: 0, row: 1 }
    case 'top':
    default:
      return { col: 1, row: 0 }
  }
}

/** Serialize layout to JSON string */
export function serializeLayout(layout: OfficeLayout): string {
  return JSON.stringify(layout)
}

/** Deserialize layout from JSON string, migrating old tile types if needed */
export function deserializeLayout(json: string): OfficeLayout | null {
  try {
    const obj = JSON.parse(json)
    if (obj && obj.version === 1 && Array.isArray(obj.tiles) && Array.isArray(obj.furniture)) {
      return migrateLayout(obj as OfficeLayout)
    }
  } catch { /* ignore parse errors */ }
  return null
}

/**
 * Ensure layout has tileColors. If missing, generate defaults based on tile types.
 * Exported for use by message handlers that receive layouts over the wire.
 */
export function migrateLayoutColors(layout: OfficeLayout): OfficeLayout {
  return migrateLayout(layout)
}

/**
 * Migrate old layouts that use legacy tile types (TILE_FLOOR=1, WOOD_FLOOR=2, CARPET=3, DOORWAY=4)
 * to the new pattern-based system. If tileColors is already present, no migration needed.
 */
function migrateLayout(layout: OfficeLayout): OfficeLayout {
  if (layout.tileColors && layout.tileColors.length === layout.tiles.length) {
    return layout // Already migrated
  }

  // Check if any tiles use old values (1-4) — these map directly to FLOOR_1-4
  // but need color assignments
  const tileColors: Array<FloorColor | null> = []
  for (const tile of layout.tiles) {
    switch (tile) {
      case 0: // WALL
        tileColors.push(null)
        break
      case 1: // was TILE_FLOOR → FLOOR_1 beige
        tileColors.push(DEFAULT_LEFT_ROOM_COLOR)
        break
      case 2: // was WOOD_FLOOR → FLOOR_2 brown
        tileColors.push(DEFAULT_RIGHT_ROOM_COLOR)
        break
      case 3: // was CARPET → FLOOR_3 purple
        tileColors.push(DEFAULT_CARPET_COLOR)
        break
      case 4: // was DOORWAY → FLOOR_4 tan
        tileColors.push(DEFAULT_DOORWAY_COLOR)
        break
      default:
        // New tile types (5-7) without colors — use neutral gray
        tileColors.push(tile > 0 ? { h: 0, s: 0, b: 0, c: 0 } : null)
    }
  }

  return { ...layout, tileColors }
}
