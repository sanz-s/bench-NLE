import { ProbeError, makeThumbnail, probeFile } from '../media/probe'
import { timelineDuration } from '../media/compositor'
import { containerDef } from '../media/formats'
import { executeJob, runAndReport } from '../bench/jobRunner'
import { addAsset, addReport, getState, setState, toast } from './store'
import { uid } from './model'

// ------------------------------------------------------------------ import

export async function importFiles(files) {
  const list = Array.from(files)
  const added = []
  setState((s) => ({ importing: s.importing + list.length }))
  await Promise.all(
    list.map(async (file) => {
      try {
        const info = await probeFile(file)
        const asset = { id: uid('a'), name: file.name, file, info }
        addAsset(asset)
        added.push(asset)
        for (const w of info.warnings) toast('info', `${file.name}: ${w}`)
        void makeThumbnail(file, info).then((thumb) => {
          if (!thumb) return
          setState((s) => ({
            project: { ...s.project, assets: s.project.assets.map((a) => (a.id === asset.id ? { ...a, thumb } : a)) },
          }))
        })
      } catch (err) {
        const msg = err instanceof ProbeError ? err.message : `Couldn't import "${file.name}": ${err instanceof Error ? err.message : String(err)}`
        toast('error', msg, undefined, 6000)
      } finally {
        setState((s) => ({ importing: s.importing - 1 }))
      }
    }),
  )
  return added
}

/** Generate synthetic test media with Mediabunny (in a worker) and import it. */
export async function generateTestClip(spec = {}) {
  const full = {
    container: 'mp4',
    videoCodec: 'avc',
    audioCodec: 'aac',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 10,
    ...spec,
  }
  setState((s) => ({ importing: s.importing + 1 }))
  try {
    const r = await executeJob({ kind: 'fixture', spec: full }, { runIn: 'worker' })
    const file = new File([r.buffer], r.fileName, { type: r.mimeType })
    const [asset] = await importFiles([file])
    return asset ?? null
  } catch (err) {
    toast('error', `Test clip generation failed: ${err instanceof Error ? err.message : String(err)}`, undefined, 6000)
    return null
  } finally {
    setState((s) => ({ importing: s.importing - 1 }))
  }
}

// ------------------------------------------------------------------ export / convert

export function canStreamToDisk() {
  return typeof window.showSaveFilePicker === 'function'
}

async function pickTarget(settings, baseName, saveToDisk) {
  if (!saveToDisk || !canStreamToDisk()) return { kind: 'buffer' }
  const def = containerDef(settings.container)
  try {
    const picker = window.showSaveFilePicker
    const handle = await picker({
      suggestedName: `${baseName.replace(/\.[^.]+$/, '')}${def.ext}`,
      types: [{ description: def.label, accept: { 'application/octet-stream': [def.ext] } }],
    })
    return { kind: 'stream', handle }
  } catch {
    return null // user canceled the picker
  }
}

function setTitleProgress(p) {
  const base = 'Bunny NLE'
  document.title = p === null ? base : `${Math.round(p * 100)}% · Exporting – ${base}`
}

async function runTracked(job, opts, label) {
  const id = uid('job')
  const ctrl = new AbortController()
  setState((s) => ({ jobs: [...s.jobs, { id, label, progress: 0, runIn: opts.runIn, cancel: () => ctrl.abort() }] }))
  const update = (progress) => {
    setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, progress } : j)) }))
    setTitleProgress(progress)
  }
  try {
    const res = await runAndReport(job, {
      runIn: opts.runIn,
      label: opts.label,
      signal: ctrl.signal,
      onProgress: (p) => update(p.progress),
    })
    const url = res.file && job.target.kind === 'buffer' ? URL.createObjectURL(res.file) : undefined
    addReport(res.report, url)
    const r = res.report
    if (r.status === 'done') {
      const secs = (r.derived.conversionMs / 1000).toFixed(2)
      const verify = r.verify && !r.verify.ok ? ` (verify: ${r.verify.problems[0]})` : ''
      toast(
        r.verify && !r.verify.ok ? 'error' : 'success',
        `${r.output.fileName} ready in ${secs}s${verify}`,
        url ? { label: 'Download', run: () => download(url, r.output.fileName) } : undefined,
        7000,
      )
      if (url && opts.autoDownload) download(url, r.output.fileName)
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Export finished', { body: `${r.output.fileName} in ${secs}s` })
      }
    } else if (r.status === 'canceled') {
      toast('info', 'Export canceled')
    } else {
      toast('error', `Export failed: ${r.error}`, undefined, 8000)
    }
    return res
  } finally {
    setState((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) }))
    setTitleProgress(getState().jobs.length ? 0 : null)
  }
}

export function download(url, name) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

export async function startExport(settings, opts) {
  const { project } = getState()
  const end = timelineDuration(project)
  if (end <= 0) {
    toast('info', 'Add something to the timeline before exporting')
    return null
  }
  const target = await pickTarget(settings, project.name, opts.saveToDisk)
  if (!target) return null
  const job = { kind: 'export', project, settings, range: { start: 0, end }, target }
  return runTracked(job, opts, `Export ${project.name}`)
}

export async function startConvert(asset, settings, engine, allowCopy, trim, opts) {
  const target = await pickTarget(settings, asset.name, opts.saveToDisk)
  if (!target) return null
  const job = { kind: 'convert', engine, asset, settings, allowCopy, trim, target }
  return runTracked(job, opts, `Convert ${asset.name}`)
}
