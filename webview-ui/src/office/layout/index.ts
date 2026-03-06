export { FURNITURE_CATALOG, getCatalogEntry, getCatalogByCategory, FURNITURE_CATEGORIES } from './furnitureCatalog.js'
export type { FurnitureCategory, CatalogEntryWithCategory } from './furnitureCatalog.js'
export {
  layoutToTileMap,
  layoutToFurnitureInstances,
  getBlockedTiles,
  layoutToSeats,
  getSeatTiles,
  createDefaultLayout,
  createLayoutTemplate,
  ROOM_LAYOUT_TEMPLATES,
  serializeLayout,
  deserializeLayout,
} from './layoutSerializer.js'
export type { RoomLayoutTemplateId } from './layoutSerializer.js'
export {
  isWalkable,
  getWalkableTiles,
  findPath,
} from './tileMap.js'
