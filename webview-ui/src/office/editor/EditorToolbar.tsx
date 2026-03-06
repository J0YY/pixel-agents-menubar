import { useState, useEffect, useRef, useCallback } from 'react'
import { EditTool } from '../types.js'
import type { TileType as TileTypeVal, FloorColor } from '../types.js'
import { getCatalogByCategory, buildDynamicCatalog, getActiveCategories } from '../layout/furnitureCatalog.js'
import type { FurnitureCategory, LoadedAssetData } from '../layout/furnitureCatalog.js'
import { getCachedSprite } from '../sprites/spriteCache.js'
import { getColorizedFloorSprite, getFloorPatternCount, hasFloorSprites } from '../floorTiles.js'
import { wallColorToHex } from '../wallTiles.js'

const btnStyle: React.CSSProperties = {
  padding: '3px 8px',
  fontSize: '22px',
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'rgba(255, 255, 255, 0.7)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const activeBtnStyle: React.CSSProperties = {
  ...btnStyle,
  background: 'rgba(90, 140, 255, 0.25)',
  color: 'rgba(255, 255, 255, 0.9)',
  border: '2px solid #5a8cff',
}

const tabStyle: React.CSSProperties = {
  padding: '2px 6px',
  fontSize: '20px',
  background: 'transparent',
  color: 'rgba(255, 255, 255, 0.5)',
  border: '2px solid transparent',
  borderRadius: 0,
  cursor: 'pointer',
}

const activeTabStyle: React.CSSProperties = {
  ...tabStyle,
  background: 'rgba(255, 255, 255, 0.08)',
  color: 'rgba(255, 255, 255, 0.8)',
  border: '2px solid #5a8cff',
}

interface EditorToolbarProps {
  activeTool: EditTool
  selectedTileType: TileTypeVal
  selectedFurnitureType: string
  selectedFurnitureUid: string | null
  selectedFurnitureColor: FloorColor | null
  floorColor: FloorColor
  wallColor: FloorColor
  onToolChange: (tool: EditTool) => void
  onTileTypeChange: (type: TileTypeVal) => void
  onFloorColorChange: (color: FloorColor) => void
  onWallColorChange: (color: FloorColor) => void
  onSelectedFurnitureColorChange: (color: FloorColor | null) => void
  onFurnitureTypeChange: (type: string) => void
  loadedAssets?: LoadedAssetData
}

/** Render a floor pattern preview at 2x (32x32 canvas showing the 16x16 tile) */
function FloorPatternPreview({ patternIndex, color, selected, onClick }: {
  patternIndex: number
  color: FloorColor
  selected: boolean
  onClick: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const displaySize = 32
  const tileZoom = 2

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = displaySize
    canvas.height = displaySize
    ctx.imageSmoothingEnabled = false

    if (!hasFloorSprites()) {
      ctx.fillStyle = '#444'
      ctx.fillRect(0, 0, displaySize, displaySize)
      return
    }

    const sprite = getColorizedFloorSprite(patternIndex, color)
    const cached = getCachedSprite(sprite, tileZoom)
    ctx.drawImage(cached, 0, 0)
  }, [patternIndex, color])

  return (
    <button
      onClick={onClick}
      title={`Floor ${patternIndex}`}
      style={{
        width: displaySize,
        height: displaySize,
        padding: 0,
        border: selected ? '2px solid #5a8cff' : '2px solid #4a4a6a',
        borderRadius: 0,
        cursor: 'pointer',
        overflow: 'hidden',
        flexShrink: 0,
        background: '#2A2A3A',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ width: displaySize, height: displaySize, display: 'block' }}
      />
    </button>
  )
}

/** Slider control for a single color parameter */
function ColorSlider({ label, value, min, max, onChange }: {
  label: string
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <span style={{ fontSize: '20px', color: '#999', width: 28, textAlign: 'right', flexShrink: 0 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, height: 12, accentColor: 'rgba(90, 140, 255, 0.8)' }}
      />
      <span style={{ fontSize: '20px', color: '#999', width: 48, textAlign: 'right', flexShrink: 0 }}>{value}</span>
    </div>
  )
}

const DEFAULT_FURNITURE_COLOR: FloorColor = { h: 0, s: 0, b: 0, c: 0 }

interface MaterialPreset {
  label: string
  patternIndex?: number
  color: FloorColor
}

interface RoomThemePreset {
  floorPatternIndex: number
  floorColor: FloorColor
  furnitureColor: FloorColor
  label: string
  wallColor: FloorColor
}

const FLOOR_MATERIAL_PRESETS: MaterialPreset[] = [
  { label: 'Oak', patternIndex: 1, color: { h: 34, s: 42, b: 8, c: 10 } },
  { label: 'Walnut', patternIndex: 2, color: { h: 24, s: 46, b: -18, c: 16 } },
  { label: 'Stone', patternIndex: 3, color: { h: 205, s: 8, b: -24, c: 18 } },
  { label: 'Concrete', patternIndex: 4, color: { h: 198, s: 6, b: -8, c: -8 } },
  { label: 'Terracotta', patternIndex: 5, color: { h: 18, s: 55, b: 6, c: 4 } },
  { label: 'Forest', patternIndex: 6, color: { h: 118, s: 24, b: -20, c: 6 } },
  { label: 'Navy', patternIndex: 7, color: { h: 218, s: 42, b: -18, c: 10 } },
  { label: 'Mint', patternIndex: 2, color: { h: 164, s: 22, b: 8, c: 0 } },
]

const WALL_MATERIAL_PRESETS: MaterialPreset[] = [
  { label: 'Ivory', color: { h: 42, s: 18, b: 18, c: -4 } },
  { label: 'Sage', color: { h: 108, s: 18, b: 6, c: -2 } },
  { label: 'Slate', color: { h: 214, s: 16, b: -20, c: 10 } },
  { label: 'Brick', color: { h: 12, s: 48, b: -4, c: 8 } },
  { label: 'Midnight', color: { h: 228, s: 34, b: -28, c: 14 } },
  { label: 'Teal', color: { h: 182, s: 26, b: -8, c: 4 } },
]

const ROOM_THEME_PRESETS: RoomThemePreset[] = [
  {
    label: 'Workshop',
    floorPatternIndex: 2,
    floorColor: { h: 28, s: 38, b: -6, c: 12 },
    wallColor: { h: 32, s: 16, b: 12, c: -6 },
    furnitureColor: { h: 20, s: 14, b: 8, c: 4 },
  },
  {
    label: 'Gallery',
    floorPatternIndex: 3,
    floorColor: { h: 198, s: 10, b: -14, c: 6 },
    wallColor: { h: 44, s: 12, b: 20, c: -10 },
    furnitureColor: { h: 210, s: 8, b: -4, c: 8 },
  },
  {
    label: 'Night Shift',
    floorPatternIndex: 7,
    floorColor: { h: 220, s: 34, b: -24, c: 10 },
    wallColor: { h: 228, s: 24, b: -30, c: 18 },
    furnitureColor: { h: 216, s: 28, b: -18, c: 10 },
  },
  {
    label: 'Atrium',
    floorPatternIndex: 6,
    floorColor: { h: 124, s: 18, b: -16, c: 8 },
    wallColor: { h: 108, s: 18, b: 10, c: -6 },
    furnitureColor: { h: 112, s: 16, b: -10, c: 4 },
  },
  {
    label: 'Sunset',
    floorPatternIndex: 5,
    floorColor: { h: 18, s: 48, b: 4, c: 6 },
    wallColor: { h: 18, s: 24, b: 16, c: -8 },
    furnitureColor: { h: 14, s: 34, b: -8, c: 6 },
  },
  {
    label: 'Blueprint',
    floorPatternIndex: 4,
    floorColor: { h: 208, s: 14, b: -6, c: 2 },
    wallColor: { h: 198, s: 20, b: 8, c: -4 },
    furnitureColor: { h: 198, s: 18, b: -12, c: 8 },
  },
]

const FURNITURE_COLOR_PRESETS: Array<{ color: FloorColor; label: string }> = [
  { label: 'Ash', color: { h: 0, s: 0, b: 6, c: -4 } },
  { label: 'Ink', color: { h: 224, s: 18, b: -24, c: 10 } },
  { label: 'Moss', color: { h: 112, s: 20, b: -10, c: 4 } },
  { label: 'Rosewood', color: { h: 8, s: 30, b: -10, c: 10 } },
  { label: 'Copper', color: { h: 24, s: 36, b: 2, c: 8 } },
  { label: 'Ice', color: { h: 196, s: 16, b: 10, c: -12 } },
]

const sectionLabelStyle: React.CSSProperties = {
  fontSize: '16px',
  color: 'rgba(255, 255, 255, 0.55)',
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}

function MaterialPresetButton({ active, label, onClick, secondarySwatch, swatch }: {
  active: boolean
  label: string
  onClick: () => void
  secondarySwatch?: string
  swatch: string
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        border: active ? '2px solid #5a8cff' : '2px solid #4a4a6a',
        background: active ? 'rgba(90, 140, 255, 0.18)' : '#202032',
        color: 'rgba(255, 255, 255, 0.85)',
        cursor: 'pointer',
        fontSize: '18px',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: secondarySwatch ? 18 : 14,
          height: 14,
          display: 'grid',
          gridTemplateColumns: secondarySwatch ? '1fr 1fr' : '1fr',
          gap: 1,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            background: swatch,
            border: '1px solid rgba(255,255,255,0.2)',
          }}
        />
        {secondarySwatch && (
          <span
            style={{
              background: secondarySwatch,
              border: '1px solid rgba(255,255,255,0.2)',
            }}
          />
        )}
      </span>
      {label}
    </button>
  )
}

export function EditorToolbar({
  activeTool,
  selectedTileType,
  selectedFurnitureType,
  selectedFurnitureUid,
  selectedFurnitureColor,
  floorColor,
  wallColor,
  onToolChange,
  onTileTypeChange,
  onFloorColorChange,
  onWallColorChange,
  onSelectedFurnitureColorChange,
  onFurnitureTypeChange,
  loadedAssets,
}: EditorToolbarProps) {
  const [activeCategory, setActiveCategory] = useState<FurnitureCategory>('desks')
  const [showColor, setShowColor] = useState(false)
  const [showWallColor, setShowWallColor] = useState(false)
  const [showFurnitureColor, setShowFurnitureColor] = useState(false)

  // Build dynamic catalog from loaded assets
  useEffect(() => {
    if (loadedAssets) {
      try {
        console.log(`[EditorToolbar] Building dynamic catalog with ${loadedAssets.catalog.length} assets...`)
        const success = buildDynamicCatalog(loadedAssets)
        console.log(`[EditorToolbar] Catalog build result: ${success}`)

        // Reset to first available category if current doesn't exist
        const activeCategories = getActiveCategories()
        if (activeCategories.length > 0) {
          const firstCat = activeCategories[0]?.id
          if (firstCat) {
            console.log(`[EditorToolbar] Setting active category to: ${firstCat}`)
            setActiveCategory(firstCat)
          }
        }
      } catch (err) {
        console.error(`[EditorToolbar] Error building dynamic catalog:`, err)
      }
    }
  }, [loadedAssets])

  const handleColorChange = useCallback((key: keyof FloorColor, value: number) => {
    onFloorColorChange({ ...floorColor, [key]: value })
  }, [floorColor, onFloorColorChange])

  const handleWallColorChange = useCallback((key: keyof FloorColor, value: number) => {
    onWallColorChange({ ...wallColor, [key]: value })
  }, [wallColor, onWallColorChange])

  // For selected furniture: use existing color or default
  const effectiveColor = selectedFurnitureColor ?? DEFAULT_FURNITURE_COLOR
  const handleSelFurnColorChange = useCallback((key: keyof FloorColor, value: number) => {
    onSelectedFurnitureColorChange({ ...effectiveColor, [key]: value })
  }, [effectiveColor, onSelectedFurnitureColorChange])

  const categoryItems = getCatalogByCategory(activeCategory)

  const patternCount = getFloorPatternCount()
  // Wall is TileType 0, floor patterns are 1..patternCount
  const floorPatterns = Array.from({ length: patternCount }, (_, i) => i + 1)
  const activeFloorPresetKey = `${selectedTileType}:${floorColor.h}:${floorColor.s}:${floorColor.b}:${floorColor.c}`
  const activeWallPresetKey = `${wallColor.h}:${wallColor.s}:${wallColor.b}:${wallColor.c}`
  const activeRoomThemeKey = ROOM_THEME_PRESETS.find((theme) =>
    selectedTileType === theme.floorPatternIndex &&
    colorsMatch(floorColor, theme.floorColor) &&
    colorsMatch(wallColor, theme.wallColor),
  )?.label ?? null
  const activeFurniturePresetKey = FURNITURE_COLOR_PRESETS.find((preset) =>
    colorsMatch(effectiveColor, preset.color),
  )?.label ?? null

  const thumbSize = 36 // 2x for items

  const isFloorActive = activeTool === EditTool.TILE_PAINT || activeTool === EditTool.EYEDROPPER
  const isWallActive = activeTool === EditTool.WALL_PAINT
  const isEraseActive = activeTool === EditTool.ERASE
  const isFurnitureActive = activeTool === EditTool.FURNITURE_PLACE || activeTool === EditTool.FURNITURE_PICK
  const applyRoomTheme = useCallback((theme: RoomThemePreset) => {
    onTileTypeChange(theme.floorPatternIndex as TileTypeVal)
    onFloorColorChange({ ...theme.floorColor })
    onWallColorChange({ ...theme.wallColor })
    if (selectedFurnitureUid) {
      onSelectedFurnitureColorChange({ ...theme.furnitureColor })
    }
  }, [onFloorColorChange, onSelectedFurnitureColorChange, onTileTypeChange, onWallColorChange, selectedFurnitureUid])

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 68,
        left: 10,
        zIndex: 50,
        background: '#1e1e2e',
        border: '2px solid #4a4a6a',
        borderRadius: 0,
        padding: '6px 8px',
        display: 'flex',
        flexDirection: 'column-reverse',
        gap: 6,
        boxShadow: '2px 2px 0px #0a0a14',
        maxWidth: 'calc(100vw - 20px)',
      }}
    >
      {/* Tool row — at the bottom */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button
          style={isFloorActive ? activeBtnStyle : btnStyle}
          onClick={() => onToolChange(EditTool.TILE_PAINT)}
          title="Paint floor tiles"
        >
          Floor
        </button>
        <button
          style={isWallActive ? activeBtnStyle : btnStyle}
          onClick={() => onToolChange(EditTool.WALL_PAINT)}
          title="Paint walls (click to toggle)"
        >
          Wall
        </button>
        <button
          style={isEraseActive ? activeBtnStyle : btnStyle}
          onClick={() => onToolChange(EditTool.ERASE)}
          title="Erase tiles to void"
        >
          Erase
        </button>
        <button
          style={isFurnitureActive ? activeBtnStyle : btnStyle}
          onClick={() => onToolChange(EditTool.FURNITURE_PLACE)}
          title="Place furniture"
        >
          Furniture
        </button>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column-reverse',
          gap: 4,
          padding: '4px 6px',
          background: '#181828',
          border: '2px solid #4a4a6a',
          borderRadius: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
          {ROOM_THEME_PRESETS.map((theme) => (
            <MaterialPresetButton
              key={theme.label}
              active={activeRoomThemeKey === theme.label}
              label={theme.label}
              onClick={() => applyRoomTheme(theme)}
              swatch={wallColorToHex(theme.floorColor)}
              secondarySwatch={wallColorToHex(theme.wallColor)}
            />
          ))}
        </div>
        <div style={sectionLabelStyle}>Room Themes</div>
      </div>

      {/* Sub-panel: Floor tiles — stacked bottom-to-top via column-reverse */}
      {isFloorActive && (
        <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 6 }}>
          {/* Color toggle + Pick — just above tool row */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              style={showColor ? activeBtnStyle : btnStyle}
              onClick={() => setShowColor((v) => !v)}
              title="Adjust floor color"
            >
              Color
            </button>
            <button
              style={activeTool === EditTool.EYEDROPPER ? activeBtnStyle : btnStyle}
              onClick={() => onToolChange(EditTool.EYEDROPPER)}
              title="Pick floor pattern + color from existing tile"
            >
              Pick
            </button>
          </div>

          {/* Color controls (collapsible) — above Wall/Color/Pick */}
          {showColor && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '4px 6px',
              background: '#181828',
              border: '2px solid #4a4a6a',
              borderRadius: 0,
            }}>
              <ColorSlider label="H" value={floorColor.h} min={0} max={360} onChange={(v) => handleColorChange('h', v)} />
              <ColorSlider label="S" value={floorColor.s} min={0} max={100} onChange={(v) => handleColorChange('s', v)} />
              <ColorSlider label="B" value={floorColor.b} min={-100} max={100} onChange={(v) => handleColorChange('b', v)} />
              <ColorSlider label="C" value={floorColor.c} min={-100} max={100} onChange={(v) => handleColorChange('c', v)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
            {FLOOR_MATERIAL_PRESETS.map((preset) => {
              const presetKey = `${preset.patternIndex}:${preset.color.h}:${preset.color.s}:${preset.color.b}:${preset.color.c}`
              return (
                <MaterialPresetButton
                  key={preset.label}
                  active={activeFloorPresetKey === presetKey}
                  label={preset.label}
                  onClick={() => {
                    onFloorColorChange({ ...preset.color })
                    if (preset.patternIndex) {
                      onTileTypeChange(preset.patternIndex as TileTypeVal)
                    }
                  }}
                  swatch={wallColorToHex(preset.color)}
                />
              )
            })}
          </div>

          {/* Floor pattern horizontal carousel — at the top */}
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2 }}>
            {floorPatterns.map((patIdx) => (
              <FloorPatternPreview
                key={patIdx}
                patternIndex={patIdx}
                color={floorColor}
                selected={selectedTileType === patIdx}
                onClick={() => onTileTypeChange(patIdx as TileTypeVal)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sub-panel: Wall — stacked bottom-to-top via column-reverse */}
      {isWallActive && (
        <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 6 }}>
          {/* Color toggle — just above tool row */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              style={showWallColor ? activeBtnStyle : btnStyle}
              onClick={() => setShowWallColor((v) => !v)}
              title="Adjust wall color"
            >
              Color
            </button>
          </div>

          {/* Color controls (collapsible) */}
          {showWallColor && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '4px 6px',
              background: '#181828',
              border: '2px solid #4a4a6a',
              borderRadius: 0,
            }}>
              <ColorSlider label="H" value={wallColor.h} min={0} max={360} onChange={(v) => handleWallColorChange('h', v)} />
              <ColorSlider label="S" value={wallColor.s} min={0} max={100} onChange={(v) => handleWallColorChange('s', v)} />
              <ColorSlider label="B" value={wallColor.b} min={-100} max={100} onChange={(v) => handleWallColorChange('b', v)} />
              <ColorSlider label="C" value={wallColor.c} min={-100} max={100} onChange={(v) => handleWallColorChange('c', v)} />
            </div>
          )}

          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
            {WALL_MATERIAL_PRESETS.map((preset) => {
              const presetKey = `${preset.color.h}:${preset.color.s}:${preset.color.b}:${preset.color.c}`
              return (
                <MaterialPresetButton
                  key={preset.label}
                  active={activeWallPresetKey === presetKey}
                  label={preset.label}
                  onClick={() => onWallColorChange({ ...preset.color })}
                  swatch={wallColorToHex(preset.color)}
                />
              )
            })}
          </div>

        </div>
      )}

      {/* Sub-panel: Furniture — stacked bottom-to-top via column-reverse */}
      {isFurnitureActive && (
        <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 4 }}>
          {/* Category tabs + Pick — just above tool row */}
          <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            {getActiveCategories().map((cat) => (
              <button
                key={cat.id}
                style={activeCategory === cat.id ? activeTabStyle : tabStyle}
                onClick={() => setActiveCategory(cat.id)}
              >
                {cat.label}
              </button>
            ))}
            <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.15)', margin: '0 2px', flexShrink: 0 }} />
            <button
              style={activeTool === EditTool.FURNITURE_PICK ? activeBtnStyle : btnStyle}
              onClick={() => onToolChange(EditTool.FURNITURE_PICK)}
              title="Pick furniture type from placed item"
            >
              Pick
            </button>
          </div>
          {/* Furniture items — single-row horizontal carousel at 2x */}
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', flexWrap: 'nowrap', paddingBottom: 2 }}>
            {categoryItems.map((entry) => {
              const cached = getCachedSprite(entry.sprite, 2)
              const isSelected = selectedFurnitureType === entry.type
              return (
                <button
                  key={entry.type}
                  onClick={() => onFurnitureTypeChange(entry.type)}
                  title={entry.label}
                  style={{
                    width: thumbSize,
                    height: thumbSize,
                    background: '#2A2A3A',
                    border: isSelected ? '2px solid #5a8cff' : '2px solid #4a4a6a',
                    borderRadius: 0,
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    flexShrink: 0,
                  }}
                >
                  <canvas
                    ref={(el) => {
                      if (!el) return
                      const ctx = el.getContext('2d')
                      if (!ctx) return
                      const scale = Math.min(thumbSize / cached.width, thumbSize / cached.height) * 0.85
                      el.width = thumbSize
                      el.height = thumbSize
                      ctx.imageSmoothingEnabled = false
                      ctx.clearRect(0, 0, thumbSize, thumbSize)
                      const dw = cached.width * scale
                      const dh = cached.height * scale
                      ctx.drawImage(cached, (thumbSize - dw) / 2, (thumbSize - dh) / 2, dw, dh)
                    }}
                    style={{ width: thumbSize, height: thumbSize }}
                  />
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Selected furniture color panel — shows when any placed furniture item is selected */}
      {selectedFurnitureUid && (
        <div style={{ display: 'flex', flexDirection: 'column-reverse', gap: 3 }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              style={showFurnitureColor ? activeBtnStyle : btnStyle}
              onClick={() => setShowFurnitureColor((v) => !v)}
              title="Adjust selected furniture color"
            >
              Color
            </button>
            {selectedFurnitureColor && (
              <button
                style={{ ...btnStyle, fontSize: '20px', padding: '2px 6px' }}
                onClick={() => onSelectedFurnitureColorChange(null)}
                title="Remove color (restore original)"
              >
                Clear
              </button>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column-reverse',
              gap: 4,
              padding: '4px 6px',
              background: '#181828',
              border: '2px solid #4a4a6a',
              borderRadius: 0,
            }}
          >
            <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2 }}>
              {FURNITURE_COLOR_PRESETS.map((preset) => (
                <MaterialPresetButton
                  key={preset.label}
                  active={activeFurniturePresetKey === preset.label}
                  label={preset.label}
                  onClick={() => onSelectedFurnitureColorChange({ ...preset.color })}
                  swatch={wallColorToHex(preset.color)}
                />
              ))}
            </div>
            <div style={sectionLabelStyle}>Furniture Tints</div>
          </div>
          {showFurnitureColor && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              padding: '4px 6px',
              background: '#181828',
              border: '2px solid #4a4a6a',
              borderRadius: 0,
            }}>
              {effectiveColor.colorize ? (
                <>
                  <ColorSlider label="H" value={effectiveColor.h} min={0} max={360} onChange={(v) => handleSelFurnColorChange('h', v)} />
                  <ColorSlider label="S" value={effectiveColor.s} min={0} max={100} onChange={(v) => handleSelFurnColorChange('s', v)} />
                </>
              ) : (
                <>
                  <ColorSlider label="H" value={effectiveColor.h} min={-180} max={180} onChange={(v) => handleSelFurnColorChange('h', v)} />
                  <ColorSlider label="S" value={effectiveColor.s} min={-100} max={100} onChange={(v) => handleSelFurnColorChange('s', v)} />
                </>
              )}
              <ColorSlider label="B" value={effectiveColor.b} min={-100} max={100} onChange={(v) => handleSelFurnColorChange('b', v)} />
              <ColorSlider label="C" value={effectiveColor.c} min={-100} max={100} onChange={(v) => handleSelFurnColorChange('c', v)} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '20px', color: '#999', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={!!effectiveColor.colorize}
                  onChange={(e) => onSelectedFurnitureColorChange({ ...effectiveColor, colorize: e.target.checked || undefined })}
                  style={{ accentColor: 'rgba(90, 140, 255, 0.8)' }}
                />
                Colorize
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function colorsMatch(left: FloorColor, right: FloorColor): boolean {
  return left.h === right.h
    && left.s === right.s
    && left.b === right.b
    && left.c === right.c
    && Boolean(left.colorize) === Boolean(right.colorize)
}
