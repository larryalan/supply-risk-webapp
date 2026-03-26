import { Router, type Request, type Response } from 'express'
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

type BusinessConstants = {
  D: number
  C0: number
  TTS: number
  W_raw: number
  Cost_limit_ratio: number
  horizonDays: number
}

type JobResult = {
  materials: Array<{
    materialId: string
    materialInfo: any
    perceptionTable: any
    curves: any
    recommendations: any
  }>
}

type RiskJob = {
  jobId: string
  status: JobStatus
  progressPct: number
  createdAt: string
  updatedAt: string
  errorMessage?: string
  request: {
    materialIds: string[]
    constants: BusinessConstants
  }
  result?: JobResult
  clients: Set<Response>
}

function nowIso() {
  return new Date().toISOString()
}

function makeJobId() {
  return `job_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`
}

function sseSend(res: Response, event: string, data: any) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function broadcast(job: RiskJob, event: string, payload: any) {
  for (const c of job.clients) {
    try {
      sseSend(c, event, payload)
    } catch {
      job.clients.delete(c)
    }
  }
}

function ensureConstants(input: any): BusinessConstants {
  const D = Number(input?.D)
  const C0 = Number(input?.C0)
  const TTS = Number(input?.TTS)
  const W_raw = Number(input?.W_raw)
  const Cost_limit_ratio = Number(input?.Cost_limit_ratio)
  const horizonDays = Number(input?.horizonDays ?? 180)

  if (!Number.isFinite(D) || D <= 0) throw new Error('D must be positive')
  if (!Number.isFinite(C0) || C0 <= 0) throw new Error('C0 must be positive')
  if (!Number.isFinite(TTS) || TTS <= 0) throw new Error('TTS must be positive')
  if (!Number.isFinite(W_raw) || W_raw < 0 || W_raw > 1) throw new Error('W_raw must be in [0,1]')
  if (!Number.isFinite(Cost_limit_ratio) || Cost_limit_ratio < 1) throw new Error('Cost_limit_ratio must be >= 1')
  if (!Number.isFinite(horizonDays) || horizonDays < 30 || horizonDays > 365) throw new Error('horizonDays must be in [30,365]')

  return { D, C0, TTS, W_raw, Cost_limit_ratio, horizonDays }
}

const jobs = new Map<string, RiskJob>()

function runPythonModel(input: { materialIds: string[]; constants: BusinessConstants }): Promise<JobResult> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const runner = path.resolve(__dirname, '../python/run_model.py')

  return new Promise((resolve, reject) => {
    const p = spawn('python3', [runner], { stdio: ['pipe', 'pipe', 'pipe'] })

    let out = ''
    let err = ''

    p.stdout.on('data', (d) => {
      out += d.toString('utf-8')
    })
    p.stderr.on('data', (d) => {
      err += d.toString('utf-8')
    })

    p.on('error', (e) => {
      reject(e)
    })

    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err || `python exited with code ${code}`))
        return
      }
      try {
        const json = JSON.parse(out)
        resolve(json as JobResult)
      } catch {
        reject(new Error(err || 'python output is not valid json'))
      }
    })

    p.stdin.write(JSON.stringify(input))
    p.stdin.end()
  })
}

async function startJob(job: RiskJob) {
  job.status = 'running'
  job.updatedAt = nowIso()
  job.progressPct = 2
  broadcast(job, 'status', { jobId: job.jobId, status: job.status, progressPct: job.progressPct, updatedAt: job.updatedAt })

  const tick = setInterval(() => {
    if (job.status !== 'running') {
      clearInterval(tick)
      return
    }
    job.progressPct = Math.min(95, job.progressPct + 3)
    job.updatedAt = nowIso()
    broadcast(job, 'status', { jobId: job.jobId, status: job.status, progressPct: job.progressPct, updatedAt: job.updatedAt })
  }, 700)

  try {
    const result = await runPythonModel(job.request)
    clearInterval(tick)
    job.result = result
    job.status = 'succeeded'
    job.progressPct = 100
    job.updatedAt = nowIso()
    broadcast(job, 'result', {
      jobId: job.jobId,
      status: job.status,
      progressPct: job.progressPct,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      result: job.result,
    })
    broadcast(job, 'status', { jobId: job.jobId, status: job.status, progressPct: job.progressPct, updatedAt: job.updatedAt })
  } catch (e: any) {
    clearInterval(tick)
    job.status = 'failed'
    job.errorMessage = e?.message || 'failed'
    job.updatedAt = nowIso()
    broadcast(job, 'error', { jobId: job.jobId, status: job.status, errorMessage: job.errorMessage, updatedAt: job.updatedAt })
  }
}

const router = Router()

router.post('/jobs', async (req: Request, res: Response) => {
  try {
    const materialIdsRaw = Array.isArray(req.body?.materialIds) ? req.body.materialIds : []
    const materialIds = materialIdsRaw.map((s: any) => String(s).trim()).filter(Boolean)
    if (materialIds.length === 0) {
      res.status(400).json({ success: false, error: 'materialIds is required' })
      return
    }

    const constants = ensureConstants(req.body?.constants)
    const jobId = makeJobId()
    const job: RiskJob = {
      jobId,
      status: 'queued',
      progressPct: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      request: { materialIds, constants },
      clients: new Set<Response>(),
    }
    jobs.set(jobId, job)
    res.status(201).json({ success: true, jobId, status: job.status })
    setTimeout(() => startJob(job), 30)
  } catch (e: any) {
    res.status(400).json({ success: false, error: e?.message || 'bad request' })
  }
})

router.get('/jobs/:jobId', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    res.status(404).json({ success: false, error: 'job not found' })
    return
  }
  res.json({
    success: true,
    jobId: job.jobId,
    status: job.status,
    progressPct: job.progressPct,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    errorMessage: job.errorMessage,
    request: job.request,
    result: job.result,
  })
})

router.get('/jobs/:jobId/stream', (req: Request, res: Response) => {
  const job = jobs.get(req.params.jobId)
  if (!job) {
    res.status(404).end()
    return
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  job.clients.add(res)
  sseSend(res, 'status', { jobId: job.jobId, status: job.status, progressPct: job.progressPct, updatedAt: job.updatedAt })
  if (job.status === 'succeeded' && job.result) {
    sseSend(res, 'result', {
      jobId: job.jobId,
      status: job.status,
      progressPct: job.progressPct,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      request: job.request,
      result: job.result,
    })
  }
  if (job.status === 'failed') {
    sseSend(res, 'error', { jobId: job.jobId, status: job.status, errorMessage: job.errorMessage, updatedAt: job.updatedAt })
  }

  req.on('close', () => {
    job.clients.delete(res)
  })
})

export default router

