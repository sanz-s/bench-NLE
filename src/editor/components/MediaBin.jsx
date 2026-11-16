import { useRef, useState } from 'react'
import { generateTestClip, importFiles } from '../actions'
import { placeAsset, removeAsset, setState, useStore } from '../store'
import { formatBytes, formatDuration } from '../model'
import { Badge, Icon, IconButton } from './ui'
import { ASSET_MIME, dragState } from './dragState'

const ACCEPT = 'video/*,audio/*,image/*,.mkv,.mov,.ts,.m2ts,.flac,.ogg,.opus,.m4a,.aac,.wav,.webm,.mp3,.m3u8'

function kindIcon(a) {
  return a.info.kind === 'video' ? 'film' : a.info.kind === 'audio' ? 'music' : 'image'
}

export function MediaBin() {
  const assets = useStore((s) => s.project.assets)
  const selectedId = useStore((s) => s.selectedAssetId)
  const importing = useStore((s) => s.importing)
  const clips = useStore((s) => s.project.clips)
  const fileInput = useRef(null)
  const [dragOver, setDragOver] = useState(false)
  const [query, setQuery] = useState('')
  const used = new Set(clips.map((c) => c.assetId))
  const selected = assets.find((a) => a.id === selectedId) ?? null
  const shown = assets.filter((a) => a.name.toLowerCase().includes(query.toLowerCase()))

  return (
    <div
      className={`bin${dragOver ? ' drag-over' : ''}`}
      aria-label="Media"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setDragOver(true)
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        e.stopPropagation()
        setDragOver(false)
        void importFiles(e.dataTransfer.files)
      }}
    >
      <div className="panel-head">
        <h2>Media</h2>
        <div className="panel-actions">
          <IconButton icon="sparkles" label="Generate a 10 s 1080p test clip (Mediabunny)" onClick={() => void generateTestClip()} />
          <button type="button" className="btn btn-small" onClick={() => fileInput.current?.click()} title="Import files (⌘I)">
            <Icon name="upload" size={14} /> Import
          </button>
        </div>
        <input
          ref={fileInput}
          id="file-import"
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => {
            if (e.target.files) void importFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>
      {assets.length > 3 && (
        <input className="bin-search" placeholder="Search media" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search media" />
      )}
      {importing > 0 && (
        <div className="bin-importing">
          <span className="spinner" /> Reading {importing} file{importing > 1 ? 's' : ''} with Mediabunny…
        </div>
      )}
      {assets.length === 0 ? (
        <div className="empty-drop" onClick={() => fileInput.current?.click()}>
          <Icon name="upload" size={28} />
          <strong>Drop videos, audio or images here</strong>
          <span>MP4 · MOV · MKV · WebM · TS · Ogg · MP3 · WAV · AAC · FLAC · ProRes · AC-3 · DTS</span>
          <button
            type="button"
            className="btn btn-small"
            onClick={(e) => {
              e.stopPropagation()
              void generateTestClip()
            }}
          >
            <Icon name="sparkles" size={14} /> Or generate a test clip
          </button>
        </div>
      ) : (
        <ul className="bin-grid">
          {shown.map((a) => (
            <li
              key={a.id}
              className={`bin-item${a.id === selectedId ? ' selected' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_MIME, a.id)
                e.dataTransfer.effectAllowed = 'copy'
                dragState.assetId = a.id
              }}
              onDragEnd={() => (dragState.assetId = null)}
              onClick={() => setState({ selectedAssetId: a.id })}
              onDoubleClick={() => placeAsset(a.id)}
              title={`${a.name}\nDouble-click or drag to the timeline`}
            >
              <div className="bin-thumb">
                {a.thumb ? <img src={a.thumb} alt="" draggable={false} /> : <Icon name={kindIcon(a)} size={22} />}
                <span className="bin-dur">{a.info.kind === 'image' ? 'IMG' : formatDuration(a.info.duration)}</span>
                {!used.has(a.id) && <span className="bin-unused" title="Not used in the timeline" />}
                <div className="bin-hover-actions">
                  <button type="button" title="Append to timeline" aria-label="Append to timeline" onClick={(e) => (e.stopPropagation(), placeAsset(a.id))}>
                    <Icon name="plus" size={14} />
                  </button>
                  {a.info.kind !== 'image' && (
                    <button
                      type="button"
                      title="Convert this file to another format"
                      aria-label="Convert"
                      onClick={(e) => (e.stopPropagation(), setState({ dialog: { type: 'convert', assetId: a.id } }))}
                    >
                      <Icon name="convert" size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="bin-name">{a.name}</div>
            </li>
          ))}
        </ul>
      )}
      {selected && <AssetInfo asset={selected} />}
    </div>
  )
}

function AssetInfo({ asset }) {
  const i = asset.info
  return (
    <div className="asset-info">
      <div className="asset-info-head">
        <strong title={asset.name}>{asset.name}</strong>
        <IconButton icon="trash" label="Remove from project" onClick={() => removeAsset(asset.id)} />
      </div>
      <dl>
        <dt>Container</dt>
        <dd>{i.container}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(i.size)}</dd>
        {i.kind !== 'image' && (
          <>
            <dt>Duration</dt>
            <dd>{formatDuration(i.duration)}</dd>
          </>
        )}
        {i.video && (
          <>
            <dt>Video</dt>
            <dd>
              <Badge tone={i.video.canDecode ? 'accent' : 'bad'}>{i.video.codec ?? '?'}</Badge> {i.video.width}×{i.video.height} · {i.video.fps.toFixed(2)} fps
              {i.video.bitrate ? ` · ${(i.video.bitrate / 1e6).toFixed(1)} Mb/s` : ''}
              {i.video.rotation ? ` · ${i.video.rotation}°` : ''}
              {i.video.hdr ? ' · HDR' : ''}
            </dd>
          </>
        )}
        {i.audio && (
          <>
            <dt>Audio</dt>
            <dd>
              <Badge tone={i.audio.canDecode ? 'accent' : 'bad'}>{i.audio.codec ?? '?'}</Badge> {i.audio.channels} ch · {i.audio.sampleRate} Hz
              {i.audio.bitrate ? ` · ${Math.round(i.audio.bitrate / 1000)} kb/s` : ''}
            </dd>
          </>
        )}
        {i.kind === 'image' && (
          <>
            <dt>Image</dt>
            <dd>
              {i.imageWidth}×{i.imageHeight}
            </dd>
          </>
        )}
        {(i.videoTrackCount > 1 || i.audioTrackCount > 1) && (
          <>
            <dt>Tracks</dt>
            <dd>
              {i.videoTrackCount} video · {i.audioTrackCount} audio
            </dd>
          </>
        )}
      </dl>
      {i.warnings.length > 0 && (
        <ul className="asset-warnings">
          {i.warnings.map((w) => (
            <li key={w}>
              <Icon name="alert" size={12} /> {w}
            </li>
          ))}
        </ul>
      )}
      {i.kind !== 'image' && (
        <button type="button" className="btn btn-small btn-block" onClick={() => setState({ dialog: { type: 'convert', assetId: asset.id } })}>
          <Icon name="convert" size={14} /> Convert file…
        </button>
      )}
    </div>
  )
}
